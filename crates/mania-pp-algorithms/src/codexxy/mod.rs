//! codexxy — the community algorithm plus the map-based timing surface.
//!
//! Codexxy is the name its author gives the algorithm; the technique it adds on top of sunny is a **map-based timing surface**, which is why this project's older notes call it "surface". The dataset, the site and this module all use the name **Codexxy**.
//!
//! surface keeps sunny's pattern term and adds a forward timing model: per-object expected judgement loss from a fitted error distribution, a map-level timing factor derived during the difficulty pass, and a score-conditioned adjustment clamped to `[0.75, 1.15]`.
//!
//! The pinned dependency implements the integrated calculation, so this module simply reports its final PP. [`crate::sunny`] reports the same calculation with the timing component removed, which is what makes the difference between the two columns meaningful.

/// Algorithm id used in the results document.
pub const ID: &str = "codexxy";

/// Human-readable name for the comparison site.
pub const LABEL: &str = "Codexxy";

/// One-line description shown next to the algorithm.
pub const DESCRIPTION: &str = "sunny plus a forward timing surface: expected judgement loss, a map timing factor and a score adjustment";

use rosu_pp::mania::{SunnyManiaPerformanceAttributes, SunnyScoreState};

use crate::{Counts, Prepared};

/// The score state the upstream calculation consumes (kept here so the timing helpers below can recompute the shared pass on their own).
#[allow(dead_code)]
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

/// Codexxy PP from an already computed performance pass (see [`crate::sunny::performance`]).
pub fn pp_from(perf: &SunnyManiaPerformanceAttributes) -> f64 {
    perf.pp
}

/// Codexxy PP for one score: sunny's pattern value plus the timing surface.
///
/// Prefer [`pp_from`] together with a single [`crate::sunny::performance`] call when pricing a score for several columns; this convenience wrapper pays for the shared pass on its own.
pub fn pp(prepared: &Prepared, counts: &Counts) -> Option<f64> {
    Some(pp_from(&crate::sunny::performance(prepared, counts)))
}

/// The timing model's own numbers, for diagnostics: (map factor, score adjustment, expected accuracy).
pub fn timing_diagnostics(prepared: &Prepared, counts: &Counts) -> (f64, f64, f64) {
    let perf = crate::sunny::performance(prepared, counts);

    (
        perf.timing_map_factor,
        perf.timing_score_adjustment,
        perf.timing_expected_accuracy,
    )
}
