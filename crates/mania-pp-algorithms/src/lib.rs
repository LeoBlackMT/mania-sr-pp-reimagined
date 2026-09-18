// `!(x > 0.0)` style guards appear throughout the ported modules: they are true for NaN, which is how the Python reference treats undefined inputs (`not (x > 0)`). Clippy's suggested `x <= 0.0` would send NaN down the other branch, so the lint is allowed deliberately, not by accident.
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
//! Everything that is expensive is computed once per `(map, mods)` pair by [`prepare`], and the four algorithms then price any number of scores off that shared state — which is also what keeps the comparison fair: all four see exactly the same parsed map, the same mods and the same score.
//!
//! ```no_run
//! # fn main() -> Result<(), String> {
//! let text = std::fs::read_to_string("map.osu").map_err(|e| e.to_string())?; let prepared = mania_pp_algorithms::prepare(&text, "DT")?; let counts: mania_pp_algorithms::Counts = [900, 80, 15, 3, 1, 1]; let pp = mania_pp_algorithms::price(&prepared, &counts); println!("bancho {:.2} sunny {:.2} codexxy {:.2} reimagined {:.2}", pp.bancho.unwrap_or(f64::NAN), pp.sunny.unwrap_or(f64::NAN), pp.codexxy.unwrap_or(f64::NAN), pp.reimagined.unwrap_or(f64::NAN));
//! # Ok(())
//! # }
//! ```

pub mod bancho;
pub mod codexxy;
pub mod reimagined;
pub mod shared;
pub mod sunny;

use rosu_pp::mania::SunnyManiaDifficultyAttributes;
use rosu_pp::Beatmap;

// The official osu!mania calculation comes from the untouched upstream crate, not from the pinned fork: the fork's `mania::difficulty` fills `ManiaDifficultyAttributes.stars` from the Community Sunny ("rebirth") parameters, so its attributes fed through the official pp formula would price "Sunny stars on the official curve" and label it Bancho. Both crates share one `rosu-map` and one `rosu-mods` version, so a `Beatmap` and a `GameMods` built here can be handed to either.
use rosu_pp_official::mania::Mania as OfficialMania;
use rosu_pp_official::mania::ManiaDifficultyAttributes as OfficialManiaAttributes;
use rosu_pp_official::model::mode::IGameMode as OfficialGameMode;
use rosu_pp_official::Difficulty as OfficialDifficulty;

pub use reimagined::mods::ModSet;
pub use reimagined::pp::Counts;

/// Algorithm ids in presentation order.
pub const ALGORITHM_IDS: [&str; 4] = ["bancho", "sunny", "codexxy", "reimagined"];

/// Parse a mod acronym string into the dependency's mod representation, plus the clock rate.
///
/// Accepts the usual spellings: `"DT+MR"`, `"HDHR"`, `"EZDTV2"`, `"NM"`, `""`. Separators are stripped before parsing because the upstream parser consumes the string in two-character chunks.
///
/// The clock rate is derived here rather than taken from the dependency's `report_utils::mods_for` helper: that helper only knows `DT`/`NC`/`HT` and would silently treat `DC` (Daycore, the pitch-preserving 0.75x rate mod, ranked on mania) as a neutral mod. Rate-changing mods are the one thing that legitimately changes the difficulty calculation, so getting `DC` wrong would misprice every Daycore score in a fixture.
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

/// The mods in the mod representation of the **upstream** crate, plus the clock rate.
///
/// The pinned fork defines its own `GameMods` enum, so its value cannot be handed to the upstream calculator; both are built here from the same acronym string and the same normalisation, which is what keeps the two paths reading the same mods. Rate-changing mods are resolved the same way as in [`game_mods_for`]: `DT`/`NC` are 1.5× and `HT`/`DC` are 0.75×, because the upstream helper does not know Daycore.
fn official_game_mods_for(mods_str: &str) -> rosu_pp_official::GameMods {
    use rosu_pp_official::model::mods::rosu_mods::GameModsIntermode;

    let normalized: String = mods_str
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '+' && *c != ',' && *c != '|')
        .collect();

    rosu_pp_official::GameMods::from(GameModsIntermode::from_acronyms(&normalized))
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
    /// Total hit objects, so a caller can validate a score's judgement counts against the map.
    pub objects: usize,
    /// Objects that carry an end time (mania holds, in a native mania map).
    ///
    /// A mania play produces one judgement for a note and *two* for a hold — its head and its tail — so a score's judgement counts add up to objects or to objects + holds depending on how the score's statistics were recorded, and osu!'s own accuracy for such a score uses that larger denominator. Reporting the number lets a caller check whichever convention applies instead of guessing.
    pub holds: usize,
    /// Hold objects divided by all objects.
    pub ln_ratio: f64,
    /// Average number of simultaneous presses (chord structure).
    pub mean_chord: f64,
    /// Median release -> next press in a different column, in milliseconds.
    pub rel_gap_cross: Option<f64>,
    /// Share of seconds during which at least half of the columns are held ("long-note wall").
    ///
    /// The key-type A axis compresses the coordination channel by this; `None` when the map has no notes.
    pub wall_frac: Option<f64>,
    /// Share of adjacent cross-column press gaps at or below 100 ms on the rice side ("rice cut").
    ///
    /// The key-type C axis compresses the regular channel by this; `None` when no cross-column pair exists.
    pub rice_cut: Option<f64>,
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
    /// Official osu!mania difficulty attributes, from the untouched upstream crate.
    pub(crate) official: OfficialManiaAttributes,
    /// The same mods in the upstream crate's representation, which is what its performance calculator consumes.
    pub(crate) official_mods: rosu_pp_official::GameMods,
}

impl Prepared {
    pub fn map_info(&self) -> &MapInfo {
        &self.map_info
    }

    pub fn mods(&self) -> &str {
        &self.mods_str
    }

    /// Sunny star rating of the full map — the difficulty the L channel is measured against.
    pub fn star_sunny(&self) -> f64 {
        self.sunny_full.stars
    }

    /// Sunny star rating of the rice variant (every hold rewritten as a tap) — the R channel.
    pub fn star_rice(&self) -> f64 {
        self.sunny_rice.stars
    }

    /// Official (Bancho) star rating with the prepared mods.
    pub fn star_bancho(&self) -> f64 {
        self.official.stars
    }
}

/// Parse a map, derive the rice variant, and run every upstream calculation once.
///
/// `mods_str` accepts the usual acronyms joined with `+` (`DT+MR`, `HDHR`) or unseparated (`EZDTV2`).
pub fn prepare(osu_text: &str, mods_str: &str) -> Result<Prepared, String> {
    let map = Beatmap::from_bytes(osu_text.as_bytes())
        .map_err(|e| format!("cannot parse the beatmap: {e}"))?;
    let rice_text = shared::rice::rice_variant(osu_text);
    let rice_map = Beatmap::from_bytes(rice_text.as_bytes())
        .map_err(|e| format!("cannot parse the rice variant: {e}"))?;

    // Guard: the rice variant must contain exactly the same objects. A transform that drops lines (for example by clearing the hold bit without setting the circle bit, which makes the decoder reject the line) would silently measure the R channel on a different map.
    if rice_map.hit_objects.len() != map.hit_objects.len() {
        return Err(format!(
            "rice variant has {} objects but the map has {} — refusing to compute R",
            rice_map.hit_objects.len(),
            map.hit_objects.len()
        ));
    }

    let (game_mods, clock_rate) = game_mods_for(mods_str);
    // Stable scoring semantics unless the score explicitly used ScoreV2; this mirrors the convention of the research reference and of the dependency's own batch tool.
    let lazer = Some(!mods_str.contains("V2"));

    let sunny_full = rosu_pp::mania::sunny::calculate(&map, &game_mods, clock_rate, lazer, None)
        .ok_or_else(|| "sunny difficulty failed for the map".to_owned())?;
    let sunny_rice =
        rosu_pp::mania::sunny::calculate(&rice_map, &game_mods, clock_rate, lazer, None)
            .ok_or_else(|| "sunny difficulty failed for the rice variant".to_owned())?;
    // The official star rating, from the untouched upstream crate.
    //
    // Both crates define their own `Beatmap` and `GameMods`, so this path parses the same text and rebuilds the same mods for the upstream types. That costs one extra parse per (map, mods) pair — tens of microseconds next to the difficulty pass itself — and it buys an honest Bancho column: the fork's `mania::difficulty` reports the Sunny ("rebirth") star rating, so reusing its attributes would price Sunny stars through the official pp curve under the Bancho name.
    let official_map: rosu_pp_official::Beatmap = osu_text
        .parse()
        .map_err(|e| format!("upstream parse failed: {e}"))?;
    let official_mods = official_game_mods_for(mods_str);
    let official = OfficialMania::difficulty(
        &OfficialDifficulty::new()
            .mods(official_mods.clone())
            .clock_rate(clock_rate),
        &official_map,
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
        official,
        official_mods,
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
    // The two key-type quantities are pure properties of the notes (no difficulty graph needed), so
    // they are computed for every map rather than only when a graph is available.
    let wall_frac = reimagined::features::wall_frac(&note_list, keys);
    let rice_cut = reimagined::features::rice_cut_fraction(&note_list, keys);
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
        objects: meta.total_objects,
        holds: meta.end_time_objects,
        ln_ratio,
        mean_chord: chord.map(|c| c.mean_chord).unwrap_or(1.0),
        rel_gap_cross: columns.map(|c| c.c_rel_gap_cross),
        wall_frac,
        rice_cut,
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
/// `sunny` and `codexxy` are two views of one and the same upstream calculation, so the expensive performance pass runs **once** here and both columns are derived from its output. Calling `sunny::pattern_pp` and `codexxy::pp` back to back (as an earlier version did) would run that pass twice and roughly double the cost of the two columns.
pub fn price(prepared: &Prepared, counts: &Counts) -> ScorePp {
    price_with_options(prepared, counts, ScoreOptions::default())
}

/// How the score being priced was recorded.
///
/// osu! keeps two score generations and prices each with its own judgement semantics: a lazer `solo_score` counts both ends of a hold and is priced accordingly, while a legacy `score_best_*` entry is priced under the classic rules. The difference is not cosmetic — on identical counts the two settings differ by 3% to 20%, and against the pp osu! reports the matching one lands within 1% on every sampled score while the other is off on most of them — so it is a property of the score, not a global choice.
#[derive(Clone, Copy, Debug)]
pub struct ScoreOptions {
    /// True for a lazer (`solo_score`) entry, false for a legacy one. Defaults to true, the safe assumption when a fixture does not say.
    pub lazer: bool,
}

impl Default for ScoreOptions {
    fn default() -> Self {
        ScoreOptions { lazer: true }
    }
}

/// Price one score under all four algorithms, taking the score's own generation into account.
///
/// `sunny` and `codexxy` are two views of one and the same upstream calculation, so the expensive performance pass runs **once** here and both columns are derived from its output. Calling `sunny::pattern_pp` and `codexxy::pp` back to back (as an earlier version did) would run that pass twice and roughly double the cost of the two columns.
pub fn price_with_options(prepared: &Prepared, counts: &Counts, options: ScoreOptions) -> ScorePp {
    let perf = sunny::performance(prepared, counts);

    ScorePp {
        bancho: bancho::pp_with(prepared, counts, options.lazer),
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

/// Price one score, with the score's generation, and return the reimagined channel details as well.
pub fn price_with_detail_and_options(
    prepared: &Prepared,
    counts: &Counts,
    options: ScoreOptions,
) -> (ScorePp, ReimaginedDetail) {
    (
        price_with_options(prepared, counts, options),
        reimagined::detail(prepared, counts),
    )
}
