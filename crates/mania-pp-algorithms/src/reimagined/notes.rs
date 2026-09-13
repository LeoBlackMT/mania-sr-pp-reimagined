//! `.osu` parsing for mania maps, ported from `osu_parser.py` (and from the hit-object
//! counters of `scripts/build_maps_meta.py`, which is where the object counts come from).
//!
//! The parser is deliberately forgiving, exactly like the reference: a malformed hit object
//! line is skipped rather than aborting the map, because the corpus contains lines written by
//! many editor versions.
//!
//! # Traps preserved
//!
//! * **The hold line format is `x,y,time,type,hitSound,endTime:hitSample`.** The sixth field
//!   is *not* a plain number: it usually carries a sample suffix (`639:0:0:0:0:`), so the end
//!   time must be read as `parts[5].split(':')[0]`. Parsing the field directly fails on every
//!   hold of a real corpus and silently degrades holds to zero length, which is what happened
//!   to this project for several versions (it disabled the LN judgement model everywhere).
//! * `x` is the raw first field; the column index is derived by the caller with the key count
//!   (see [`crate::reimagined::features::column_of`]) — the parser must not guess key counts, because a
//!   std convert's `CircleSize` is a radius, not a column count.
//! * `total_objects` is the number of hit objects, `end_time_objects` the number of objects
//!   **with an end time** (lazer's `TotalObjectCount` / `EndTimeObjectCount`, i.e.
//!   `hitObjects.Count(h => h is IHasDuration)`): sliders (`type & 2`), spinners (`type & 8`)
//!   and mania holds (`type & 128`). Both are inputs of the official convert key-count rule,
//!   so their exact definition matters (`key_count` resolution).
//!
//!   Traps around `end_time_objects`: the research side's `build_maps_meta.py` counts only
//!   sliders and spinners, because the value is only ever *consumed* for std converts — and on
//!   a convert there are no holds, so the two definitions agree everywhere it matters. The
//!   union is used here because it is the game's definition (the mania ruleset itself reads
//!   `EndTimeObjectCount / TotalObjectCount` as the *hold note ratio*), and because the
//!   exported golden vectors are built from the parser's `is_hold` flag.

use std::cmp::Ordering;

/// Legacy hit-object type bit of a slider (has an end time).
const TYPE_SLIDER: i32 = 2;
/// Legacy hit-object type bit of a spinner (has an end time).
const TYPE_SPINNER: i32 = 8;
/// Legacy hit-object type bit of a mania hold.
const TYPE_HOLD: i32 = 128;

/// One hit object.
///
/// `t` and `end` are milliseconds; for a plain note `end == t`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Note {
    /// Start time in milliseconds.
    pub t: f64,
    /// End time in milliseconds (equal to `t` for a plain note).
    pub end: f64,
    /// Raw `x` of the hit-object line. On mania this encodes the column.
    pub x: f64,
    /// Whether the object is a mania hold (long note).
    pub is_hold: bool,
}

/// Header metadata plus the hit-object counters of a `.osu` file.
#[derive(Debug, Clone, PartialEq)]
pub struct OsuMeta {
    /// Ruleset id (`3` = mania; anything else is a convert when read as mania).
    pub mode: i32,
    /// `CircleSize`: the key count on a native mania map, the circle radius otherwise.
    pub cs: f64,
    /// `OverallDifficulty` (before any mod).
    pub od: f64,
    /// `HPDrainRate` (before any mod) — the input of the No-Fail risk model.
    pub hp: f64,
    /// Number of hit objects (lazer's `TotalObjectCount`).
    pub total_objects: usize,
    /// Number of objects with an end time: sliders (`type & 2`), spinners (`type & 8`) and
    /// mania holds (`type & 128`). This is lazer's `EndTimeObjectCount`
    /// (`hitObjects.Count(h => h is IHasDuration)`), which the mania ruleset reads as the
    /// hold-note ratio of the map.
    pub end_time_objects: usize,
    /// `Artist` tag.
    pub artist: String,
    /// `Title` tag.
    pub title: String,
    /// `Version` (difficulty name).
    pub version: String,
    /// `Creator` (mapper).
    pub creator: String,
    /// `BeatmapSetID` — the beatmapset this difficulty belongs to.
    ///
    /// Needed because the canonical osu! link to a difficulty is
    /// `https://osu.ppy.sh/beatmapsets/{set}#mania/{id}`: the beatmap id alone is not enough.
    /// `-1` means the map was never uploaded (the field is absent or a negative placeholder).
    pub beatmap_set_id: i64,
}

impl Default for OsuMeta {
    /// The reference's defaults: everything zero/empty, mode 0.
    fn default() -> Self {
        OsuMeta {
            mode: 0,
            cs: 0.0,
            od: 0.0,
            hp: 0.0,
            total_objects: 0,
            end_time_objects: 0,
            artist: String::new(),
            title: String::new(),
            version: String::new(),
            creator: String::new(),
            beatmap_set_id: -1,
        }
    }
}

/// Value of a `Key: value` header line, or `None` when the line is not that key.
fn header_value<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    line.strip_prefix(key).map(|rest| rest.trim())
}

/// Parse a trimmed float, mirroring the reference's tolerance for surrounding whitespace.
fn parse_f64(s: &str) -> Option<f64> {
    s.trim().parse::<f64>().ok()
}

/// Parse a trimmed integer.
fn parse_i32(s: &str) -> Option<i32> {
    s.trim().parse::<i32>().ok()
}

/// Parse the `[HitObjects]` section into notes, sorted by start time.
///
/// The sort is stable and never panics: a NaN timestamp (which a hand-edited file can contain)
/// keeps its input position instead of imposing an order.
pub fn parse_notes(text: &str) -> Vec<Note> {
    let mut notes: Vec<Note> = Vec::new();
    let mut in_hit_objects = false;
    for raw in text.lines() {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if line == "[HitObjects]" {
            in_hit_objects = true;
            continue;
        } else if line.starts_with('[') && in_hit_objects {
            // A section header after the hit objects ends the section.
            break;
        }
        if !in_hit_objects || line.trim().is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split(',').collect();
        if parts.len() < 6 {
            continue;
        }
        let (Some(t), Some(object_type)) = (parse_f64(parts[2]), parse_i32(parts[3])) else {
            continue;
        };
        let is_hold = object_type & TYPE_HOLD != 0;
        let mut end = t;
        if is_hold {
            // `endTime:hitSample` — split on ':' before parsing, and fall back to the start
            // time when the field is empty or malformed.
            let field = parts[5].split(':').next().unwrap_or("");
            end = parse_f64(field).unwrap_or(t);
        }
        let x = parse_f64(parts[0]).unwrap_or(0.0);
        notes.push(Note { t, end, x, is_hold });
    }
    notes.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(Ordering::Equal));
    notes
}

/// Parse the header and the hit-object counters.
///
/// Parsing is lenient where the reference would raise: an unparsable numeric tag keeps its
/// default instead of failing the whole map (the reference relies on its callers to catch the
/// exception and skip the file).
pub fn parse_meta(text: &str) -> OsuMeta {
    let mut meta = OsuMeta::default();
    let mut in_hit_objects = false;
    for raw in text.lines() {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if let Some(v) = header_value(line, "Artist:") {
            meta.artist = v.to_string();
        } else if let Some(v) = header_value(line, "Title:") {
            meta.title = v.to_string();
        } else if let Some(v) = header_value(line, "Version:") {
            meta.version = v.to_string();
        } else if let Some(v) = header_value(line, "Creator:") {
            meta.creator = v.to_string();
        } else if let Some(v) = header_value(line, "BeatmapSetID:") {
            if let Ok(set_id) = v.trim().parse::<i64>() {
                meta.beatmap_set_id = set_id;
            }
        } else if let Some(v) = header_value(line, "CircleSize:") {
            if let Some(cs) = parse_f64(v) {
                meta.cs = cs;
            }
        } else if let Some(v) = header_value(line, "OverallDifficulty:") {
            if let Some(od) = parse_f64(v) {
                meta.od = od;
            }
        } else if let Some(v) = header_value(line, "HPDrainRate:") {
            if let Some(hp) = parse_f64(v) {
                meta.hp = hp;
            }
        } else if let Some(v) = header_value(line, "Mode:") {
            if let Some(mode) = parse_i32(v) {
                meta.mode = mode;
            }
        } else if line == "[HitObjects]" {
            in_hit_objects = true;
            continue;
        } else if line.starts_with('[') && in_hit_objects {
            break;
        }
        if !in_hit_objects {
            continue;
        }
        let parts: Vec<&str> = line.split(',').collect();
        if parts.len() < 6 {
            continue;
        }
        let (Some(_t), Some(object_type)) = (parse_f64(parts[2]), parse_i32(parts[3])) else {
            continue;
        };
        meta.total_objects += 1;
        if object_type & (TYPE_SLIDER | TYPE_SPINNER | TYPE_HOLD) != 0 {
            meta.end_time_objects += 1;
        }
    }
    meta
}
