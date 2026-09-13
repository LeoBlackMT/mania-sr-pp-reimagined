// `!(x > 0.0)` style guards appear throughout the ported modules: they are true for NaN, which is
// how the Python reference treats undefined inputs (`not (x > 0)`). Clippy's suggested `x <= 0.0`
// would send NaN down the other branch, so the lint is allowed deliberately, not by accident.
#![allow(clippy::neg_cmp_op_on_partial_ord)]
//! The four compared osu!mania PP algorithms.
//!
//! | module | algorithm | how it is obtained |
//! |---|---|---|
//! | [`bancho`] | official osu! (osu!lazer) | ported upstream in the pinned `rosu-pp` dependency |
//! | [sunny] | community algorithm by [Crz]sunnyxxy (repo: Star-Rating-Rebirth), pattern + accuracy | `mania::sunny` of the same dependency |
//! | [`codexxy`] | sunny plus the map-based timing surface | the `pp_timing` part of the same calculation |
//! | [`reimagined`] | this project's three-channel R / L / A algorithm | implemented here |
//!
//! Everything that is expensive is computed once per `(map, mods)` pair by [`prepare`], and the four
//! algorithms then price any number of scores off that shared state — which is also what keeps the
//! comparison fair: all four see exactly the same parsed map, the same mods and the same score.
//!
//! ```no_run
//! # fn main() -> Result<(), String> {
//! let text = std::fs::read_to_string("map.osu").map_err(|e| e.to_string())?;
//! let prepared = mania_pp_algorithms::prepare(&text, "DT")?;
//! let counts: mania_pp_algorithms::Counts = [900, 80, 15, 3, 1, 1];
//! let pp = mania_pp_algorithms::price(&prepared, &counts);
//! println!("bancho {:.2} sunny {:.2} codexxy {:.2} reimagined {:.2}",
//!     pp.bancho.unwrap_or(f64::NAN), pp.sunny.unwrap_or(f64::NAN),
//!     pp.codexxy.unwrap_or(f64::NAN), pp.reimagined.unwrap_or(f64::NAN));
//! # Ok(())
//! # }
//! ```

pub mod bancho;
pub mod codexxy;
pub mod reimagined;
pub mod shared;
pub mod sunny;

use rosu_pp::mania::{Mania, ManiaDifficultyAttributes, SunnyManiaDifficultyAttributes};
use rosu_pp::model::mode::IGameMode;
use rosu_pp::{Beatmap, Difficulty};

pub use reimagined::mods::ModSet;
pub use reimagined::pp::Counts;

/// Algorithm ids in presentation order.
pub const ALGORITHM_IDS: [&str; 4] = ["bancho", "sunny", "codexxy", "reimagined"];

/// Parse a mod acronym string into the dependency's mod representation, plus the clock rate.
///
/// Accepts the usual spellings: `"DT+MR"`, `"HDHR"`, `"EZDTV2"`, `"NM"`, `""`. Separators are
/// stripped before parsing because the upstream parser consumes the string in two-character chunks.
///
/// The clock rate is derived here rather than taken from the dependency's `report_utils::mods_for`
/// helper: that helper only knows `DT`/`NC`/`HT` and would silently treat `DC` (Daycore, the
/// pitch-preserving 0.75x rate mod, ranked on mania) as a neutral mod. Rate-changing mods are the
/// one thing that legitimately changes the difficulty calculation, so getting `DC` wrong would
/// misprice every Daycore score in a fixture.
fn game_mods_for(mods_str: &str) -> (rosu_pp::GameMods, f64) {
    use rosu_pp::model::mods::rosu_mods::GameModsIntermode;

    let normalized: String = mods_str
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '+' && *c != ',' && *c != '|')
        .collect();

    let intermode = GameModsIntermode::from_acronyms(&normalized);
    let clock_rate = if mods_str.contains("DT") || mods_str.contains("NC") {
        1.5
    } else if mods_str.contains("HT") || mods_str.contains("DC") {
        0.75
    } else {
        1.0
    };

    (rosu_pp::GameMods::from(intermode), clock_rate)
}

/// Map metadata and structural features, read from the `.osu` file.
#[derive(Clone, Debug)]
pub struct MapInfo {
    /// Key count resolved from mode/CS/key mods (see reimagined::keys::effective_keys).
    pub keys: i32,
    /// Beatmapset id, for the canonical eatmapsets/{set}#mania/{id} link.
    pub beatmap_set_id: i64,
    pub od: f64,
    pub hp: f64,
    pub artist: String,
    pub title: String,
    pub version: String,
    /// Difficulty author (`Creator` tag), the mapper osu! search calls `creator`/`mapper`.
    pub mapper: String,
    /// Hold objects divided by all objects.
    pub ln_ratio: f64,
    /// Average number of simultaneous presses (chord structure).
    pub mean_chord: f64,
    /// Median release -> next press in a different column, in milliseconds.
    pub rel_gap_cross: Option<f64>,
}

/// A `(map, mods)` pair with every upstream calculation already done.
///
/// Fields are crate-visible only: the algorithm modules read them, callers use the functions.
pub struct Prepared {
    pub map_info: MapInfo,
    pub(crate) mods_str: String,
    pub(crate) mod_set: ModSet,
    pub(crate) game_mods: rosu_pp::GameMods,
    pub(crate) sunny_full: SunnyManiaDifficultyAttributes,
    pub(crate) sunny_rice: SunnyManiaDifficultyAttributes,
    pub(crate) bancho: ManiaDifficultyAttributes,
}

impl Prepared {
    pub fn map_info(&self) -> &MapInfo {
        &self.map_info
    }

    pub fn mods(&self) -> &str {
        &self.mods_str
    }
}

/// Parse a map, derive the rice variant, and run every upstream calculation once.
///
/// `mods_str` accepts the usual acronyms joined with `+` (`DT+MR`, `HDHR`) or unseparated
/// (`EZDTV2`).
pub fn prepare(osu_text: &str, mods_str: &str) -> Result<Prepared, String> {
    let map = Beatmap::from_bytes(osu_text.as_bytes())
        .map_err(|e| format!("cannot parse the beatmap: {e}"))?;
    let rice_text = shared::rice::rice_variant(osu_text);
    let rice_map = Beatmap::from_bytes(rice_text.as_bytes())
        .map_err(|e| format!("cannot parse the rice variant: {e}"))?;

    // Guard: the rice variant must contain exactly the same objects. A transform that drops lines
    // (for example by clearing the hold bit without setting the circle bit, which makes the decoder
    // reject the line) would silently measure the R channel on a different map.
    if rice_map.hit_objects.len() != map.hit_objects.len() {
        return Err(format!(
            "rice variant has {} objects but the map has {} — refusing to compute R",
            rice_map.hit_objects.len(),
            map.hit_objects.len()
        ));
    }

    let (game_mods, clock_rate) = game_mods_for(mods_str);
    // Stable scoring semantics unless the score explicitly used ScoreV2; this mirrors the
    // convention of the research reference and of the dependency's own batch tool.
    let lazer = Some(!mods_str.contains("V2"));

    let sunny_full = rosu_pp::mania::sunny::calculate(&map, &game_mods, clock_rate, lazer, None)
        .ok_or_else(|| "sunny difficulty failed for the map".to_owned())?;
    let sunny_rice =
        rosu_pp::mania::sunny::calculate(&rice_map, &game_mods, clock_rate, lazer, None)
            .ok_or_else(|| "sunny difficulty failed for the rice variant".to_owned())?;
    let bancho = Mania::difficulty(
        &Difficulty::new()
            .mods(game_mods.clone())
            .clock_rate(clock_rate),
        &map,
    )
    .map_err(|e| format!("official difficulty failed: {e}"))?;

    let map_info = build_map_info(osu_text, mods_str)?;

    Ok(Prepared {
        map_info,
        mods_str: mods_str.to_owned(),
        mod_set: ModSet::parse(mods_str),
        game_mods,
        sunny_full,
        sunny_rice,
        bancho,
    })
}

fn build_map_info(osu_text: &str, mods_str: &str) -> Result<MapInfo, String> {
    let note_list = reimagined::notes::parse_notes(osu_text);
    let meta = reimagined::notes::parse_meta(osu_text);
    let keys = reimagined::keys::effective_keys(
        meta.mode,
        meta.cs,
        &ModSet::parse(mods_str),
        meta.od,
        meta.total_objects,
        meta.end_time_objects,
    );
    let chord = reimagined::features::chord_stats(&note_list);
    let columns = reimagined::features::compute_column_features(&note_list, keys);
    let holds = note_list.iter().filter(|n| n.is_hold).count();
    let ln_ratio = if note_list.is_empty() {
        0.0
    } else {
        holds as f64 / note_list.len() as f64
    };

    Ok(MapInfo {
        keys,
        beatmap_set_id: meta.beatmap_set_id,
        od: meta.od,
        hp: meta.hp,
        artist: meta.artist,
        title: meta.title,
        version: meta.version,
        mapper: meta.creator,
        ln_ratio,
        mean_chord: chord.map(|c| c.mean_chord).unwrap_or(1.0),
        rel_gap_cross: columns.map(|c| c.c_rel_gap_cross),
    })
}

/// The PP of one score under all four algorithms.
#[derive(Clone, Copy, Debug, Default)]
pub struct ScorePp {
    pub bancho: Option<f64>,
    pub sunny: Option<f64>,
    pub codexxy: Option<f64>,
    pub reimagined: Option<f64>,
}

impl ScorePp {
    /// Lookup by algorithm id (`"bancho"`, `"sunny"`, `"codexxy"`, `"reimagined"`).
    pub fn get(&self, id: &str) -> Option<f64> {
        match id {
            "bancho" => self.bancho,
            "sunny" => self.sunny,
            "codexxy" => self.codexxy,
            "reimagined" => self.reimagined,
            _ => None,
        }
    }

    /// Values in [`ALGORITHM_IDS`] order.
    pub fn as_array(&self) -> [Option<f64>; 4] {
        [self.bancho, self.sunny, self.codexxy, self.reimagined]
    }
}

/// Numbers behind the reimagined result, for explanations and diagnostics.
#[derive(Clone, Copy, Debug, Default)]
pub struct ReimaginedDetail {
    pub stars_full: f64,
    pub stars_rice: f64,
    pub ln_ratio: f64,
    pub l_share: f64,
    pub w: f64,
    pub coord_mod: f64,
    pub eff_star: f64,
    pub acc_factor: f64,
    pub nf_factor: f64,
    pub variety: f64,
    pub acc_scalar: f64,
}

/// Price one score under all four algorithms.
///
/// `sunny` and `codexxy` are two views of one and the same upstream calculation, so the expensive
/// performance pass runs **once** here and both columns are derived from its output. Calling
/// `sunny::pattern_pp` and `codexxy::pp` back to back (as an earlier version did) would run that
/// pass twice and roughly double the cost of the two columns.
pub fn price(prepared: &Prepared, counts: &Counts) -> ScorePp {
    let perf = sunny::performance(prepared, counts);

    ScorePp {
        bancho: bancho::pp(prepared, counts),
        sunny: Some(sunny::pattern_pp_from(&perf)),
        codexxy: Some(codexxy::pp_from(&perf)),
        reimagined: Some(reimagined::pp(prepared, counts)),
    }
}

/// Price one score and return the reimagined channel details as well.
pub fn price_with_detail(prepared: &Prepared, counts: &Counts) -> (ScorePp, ReimaginedDetail) {
    (
        price(prepared, counts),
        reimagined::detail(prepared, counts),
    )
}
