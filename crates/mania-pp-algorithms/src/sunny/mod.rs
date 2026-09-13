//! `sunny` — the community algorithm by [Crz]sunnyxxy, pattern and accuracy part only.
//!
//! Known in the community simply as **sunny**; its repository is named *Star-Rating-Rebirth*, and
//! the shortened "SRR" is only used internally in this project's older notes. The site shows it as
//! plain `sunny`.
//!
//! The community algorithm replaces the official difficulty model with one built around per-object
//! difficulty, long-note structure and a window-derived parameter, and prices PP as
//! `9.8 · max(star − 0.15, 0.05)^2.2 · variety · length · accuracy terms`.
//!
//! The calculation available in the pinned dependency is already integrated with the surface timing
//! model. To expose the *original* community algorithm as its own column, this module reports the
//! pattern and accuracy components (`xxy_pp_pattern + xxy_pp_accuracy`) and leaves the timing
//! component to [`crate::codexxy`]. Both come from the same single calculation, so their difference
//! is exactly the timing model — nothing else.

/// Algorithm id used in the dataset.
pub const ID: &str = "sunny";

/// Human-readable name for the comparison site.
pub const LABEL: &str = "Sunny";

/// One-line description shown next to the algorithm.
pub const DESCRIPTION: &str =
    "community algorithm by [Crz]sunnyxxy (repository: Star-Rating-Rebirth): per-object difficulty \
     with long-note structure and a window parameter; pattern and accuracy part only";

use rosu_pp::mania::{SunnyManiaPerformanceAttributes, SunnyScoreState};

use crate::{Counts, Prepared};

fn state_of(counts: &Counts) -> SunnyScoreState {
    SunnyScoreState {
        n320: counts[0],
        n300: counts[1],
        n200: counts[2],
        n100: counts[3],
        n50: counts[4],
        misses: counts[5],
    }
}

/// The shared upstream performance pass for one score.
///
/// Both this module and [`crate::codexxy`] read from its result, so a caller pricing a score should
/// compute it once and derive both columns — see [`crate::price`].
pub fn performance(prepared: &Prepared, counts: &Counts) -> SunnyManiaPerformanceAttributes {
    rosu_pp::mania::sunny::calculate_performance(
        &prepared.sunny_full,
        &prepared.game_mods,
        state_of(counts),
    )
}

/// The community algorithm's own PP, from an already computed performance pass.
pub fn pattern_pp_from(perf: &SunnyManiaPerformanceAttributes) -> f64 {
    perf.xxy_pp_pattern + perf.xxy_pp_accuracy
}

/// The part of the calculation that the timing surface adds, from an already computed pass.
pub fn timing_component_from(perf: &SunnyManiaPerformanceAttributes) -> f64 {
    perf.pp_timing
}

/// The community algorithm's own PP: pattern plus accuracy, without the timing surface.
pub fn pattern_pp(prepared: &Prepared, counts: &Counts) -> Option<f64> {
    Some(pattern_pp_from(&performance(prepared, counts)))
}

/// The part of the calculation that the timing surface adds on top of [`pattern_pp`].
///
/// Reported separately so the comparison can show *why* sunny and surface differ on a score.
pub fn timing_component(prepared: &Prepared, counts: &Counts) -> Option<f64> {
    Some(timing_component_from(&performance(prepared, counts)))
}

/// Sunny star rating of the map (the full map; the rice variant feeds the R channel).
pub fn stars(prepared: &Prepared) -> f64 {
    prepared.sunny_full.stars
}
