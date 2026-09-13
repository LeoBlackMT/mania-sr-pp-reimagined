//! `surface` — the community algorithm plus the map-based timing surface.
//!
//! surface keeps sunny's pattern term and adds a forward timing model: per-object expected judgement
//! loss from a fitted error distribution, a map-level timing factor derived during the difficulty
//! pass, and a score-conditioned adjustment clamped to `[0.75, 1.15]`.
//!
//! The pinned dependency implements the integrated calculation, so this module simply reports its
//! final PP. [`crate::sunny`] reports the same calculation with the timing component removed, which
//! is what makes the difference between the two columns meaningful.

/// Algorithm id used in the results document.
pub const ID: &str = "surface";

/// Human-readable name for the comparison site.
pub const LABEL: &str = "surface";

/// One-line description shown next to the algorithm.
pub const DESCRIPTION: &str = "sunny plus a forward timing surface: expected judgement loss, a map timing factor and a score adjustment";

use rosu_pp::mania::SunnyScoreState;

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

/// surface PP for one score: sunny's pattern value plus the timing surface.
pub fn pp(prepared: &Prepared, counts: &Counts) -> Option<f64> {
    let perf = rosu_pp::mania::sunny::calculate_performance(
        &prepared.sunny_full,
        &prepared.game_mods,
        state_of(counts),
    );

    Some(perf.pp)
}

/// The timing model's own numbers, for diagnostics: (map factor, score adjustment, expected accuracy).
pub fn timing_diagnostics(prepared: &Prepared, counts: &Counts) -> (f64, f64, f64) {
    let perf = rosu_pp::mania::sunny::calculate_performance(
        &prepared.sunny_full,
        &prepared.game_mods,
        state_of(counts),
    );

    (
        perf.timing_map_factor,
        perf.timing_score_adjustment,
        perf.timing_expected_accuracy,
    )
}
