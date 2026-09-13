//! `bancho` — the official osu!mania pp, as implemented by osu!lazer and ported upstream.
//!
//! The official calculator is a single fused difficulty number: a star rating produced by one strain
//! skill, mapped to PP with a power curve, an accuracy term and a length bonus. Notably, the mania
//! star rating does not depend on OD, HP, column count or long notes at all — mods only reach it
//! through the clock rate — so HR/EZ/DA leave official mania pp untouched (see
//! `docs/reference-csharp-sources.md` for the C# reference).
//!
//! Only the final conversion is done here; the difficulty calculation happens once per
//! `(map, mods)` pair in [`crate::prepare`].

/// Algorithm id used in the results document.
pub const ID: &str = "bancho";

/// Human-readable name for the comparison site.
pub const LABEL: &str = "bancho (official)";

/// One-line description shown next to the algorithm.
pub const DESCRIPTION: &str = "osu!lazer mania pp: one fused strain rating, mapped to PP with an accuracy term and a length bonus";

use rosu_pp::mania::{ManiaPerformance, ManiaScoreState};

use crate::{Counts, Prepared};

/// Official mania pp for one score, or `None` if the upstream calculator rejects the input.
pub fn pp(prepared: &Prepared, counts: &Counts) -> Option<f64> {
    let state = ManiaScoreState {
        n320: counts[0],
        n300: counts[1],
        n200: counts[2],
        n100: counts[3],
        n50: counts[4],
        misses: counts[5],
    };

    ManiaPerformance::new(prepared.bancho.clone())
        .mods(prepared.game_mods.clone())
        .state(state)
        .calculate()
        .ok()
        .map(|perf| perf.pp())
}

/// The official star rating of the map (with mods applied).
pub fn stars(prepared: &Prepared) -> f64 {
    prepared.bancho.stars
}
