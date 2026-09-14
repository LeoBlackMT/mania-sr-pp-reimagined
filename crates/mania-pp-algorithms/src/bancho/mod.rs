//! `bancho` — the official osu!mania pp, as implemented by osu!lazer and ported upstream.
//!
//! The official calculator is a single fused difficulty number: a star rating produced by one strain skill, mapped to PP with a power curve, an accuracy term and a length bonus. Notably, the mania star rating does not depend on OD, HP, column count or long notes at all — mods only reach it through the clock rate — so HR/EZ/DA leave official mania pp untouched (see `docs/reference-csharp-sources.md` for the C# reference).
//!
//! Only the final conversion is done here; the difficulty calculation happens once per `(map, mods)` pair in [`crate::prepare`].

/// Algorithm id used in the results document.
pub const ID: &str = "bancho";

/// Human-readable name for the comparison site.
pub const LABEL: &str = "Bancho";

/// One-line description shown next to the algorithm.
pub const DESCRIPTION: &str = "osu!lazer mania pp: one fused strain rating, mapped to PP with an accuracy term and a length bonus";

use rosu_pp_official::mania::{ManiaPerformance, ManiaScoreState};

use crate::{Counts, Prepared};

/// Official mania pp for one score, or `None` if the upstream calculator rejects the input.
///
/// `lazer` selects the judgement semantics of the score's own generation, which osu! itself applies: a lazer `solo_score` is priced with lazer semantics and a legacy `score_best_*` entry with classic ones. The two differ by 3% to 20% on the same counts — measured against the pp osu! reports, the right setting matches to within 1% on every sampled score while the wrong one is off on most of them — so the flag travels with the score rather than being a global choice. It defaults to lazer for a score whose generation is unknown.
pub fn pp_with(prepared: &Prepared, counts: &Counts, lazer: bool) -> Option<f64> {
    let state = ManiaScoreState {
        n320: counts[0],
        n300: counts[1],
        n200: counts[2],
        n100: counts[3],
        n50: counts[4],
        misses: counts[5],
    };

    ManiaPerformance::new(prepared.official.clone())
        .mods(prepared.official_mods.clone())
        .lazer(lazer)
        .state(state)
        .calculate()
        .ok()
        .map(|perf| perf.pp())
}

/// Official mania pp under the default (lazer) score semantics.
pub fn pp(prepared: &Prepared, counts: &Counts) -> Option<f64> {
    pp_with(prepared, counts, true)
}

/// The official star rating of the map (with mods applied).
pub fn stars(prepared: &Prepared) -> f64 {
    prepared.official.stars
}
