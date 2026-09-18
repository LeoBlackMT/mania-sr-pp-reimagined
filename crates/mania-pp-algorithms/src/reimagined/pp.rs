//! The reimagined PP formula: the 305-weighted accuracy curve, the sunny "rebirth" body, the window-derived accuracy channel and the three-channel combination.
//!
//! Ported one-to-one from `pp_formula.py`. Everything tunable is read from [`mania_pp_spec::spec`]; only the *shape* of the formulas (band boundaries, the `4.5` numerator and the `0.9^20` denominator term of the accuracy curve) is written here.
//!
//! # The pricing pipeline
//!
//! ```text
//! R, L      -> effective_star():  (R_SCALE * R + w * L) * (1 + star_key_boost(keys)) eff_star  -> sunny_rebirth_pp(): 9.8 * max(star - 0.15, 0.05)^2.2 * proportion(acc)
//!                                  * flat_pp_mult * nf_factor * variety * acc_scalar * length
//! * nf_factor  (inside the body: NF only, from the failure-risk model)
//! * acc_factor (outside, scaled by ACC_WEIGHT around its neutral 1.0)
//! ```
//!
//! `nf_factor` is applied **inside** `sunny_rebirth_pp`, exactly once — reading the pipeline as "…then multiply by nf_factor, then by accuracy_factor" must not lead to applying it twice.

use std::sync::OnceLock;

use mania_pp_spec::spec;

use crate::reimagined::keys::{
    coord_transfer_mod, rice_cut_mod, shape_args, stack_boost_mod, star_key_boost, w_m3_keys,
    wall_cut_mod,
};
use crate::reimagined::mods::{clamp_py, flat_pp_multiplier, nf_multiplier, ModSet};

/// Judgement counts of a score: `[n320, n300, n200, n100, n50, miss]`.
///
/// The order is also the order of [`crate::reimagined::mods::Judgement`] (best to worst) and the order of the 305 weights used by [`custom_accuracy`].
pub type Counts = [u32; 6];

/// Total number of judgements in a count array.
fn total_of(counts: &Counts) -> f64 {
    counts.iter().map(|&c| f64::from(c)).sum()
}

/// Python's `max(a, b)`: a NaN **first** operand propagates, whereas Rust's `f64::max` returns the other operand. Only used where the reference puts the value first.
fn py_max(a: f64, b: f64) -> f64 {
    if b > a {
        b
    } else {
        a
    }
}

/// 305-weighted accuracy of a score, clamped to `[0, 1]`.
///
/// The weights are `320 -> 305`, `300 -> 300`, `200 -> 200`, `100 -> 100`, `50 -> 50`, miss `0` (osu!'s "305 score"), so a score can only reach 1.0 with all 320s.
pub fn custom_accuracy(counts: &Counts) -> f64 {
    let total = total_of(counts);
    if total == 0.0 {
        return 0.0;
    }
    let acc = (f64::from(counts[0]) * 305.0
        + f64::from(counts[1]) * 300.0
        + f64::from(counts[2]) * 200.0
        + f64::from(counts[3]) * 100.0
        + f64::from(counts[4]) * 50.0)
        / (total * 305.0);
    clamp_py(acc, 0.0, 1.0)
}

/// The four anchors of the reshaped accuracy curve: `p98`, `p99`, `p995` and the tail coefficient `C` of `1 - C * (1 - acc)^k_tail`.
///
/// Computed once and cached, like the reference's lazy `_acc_anchor()`. The band widths (`0.02`, `0.01`) are the reference's literals: they describe the *shape*, they are not knobs, which is why they do not appear in the exported spec.
fn acc_anchors() -> &'static (f64, f64, f64, f64) {
    static ANCHORS: OnceLock<(f64, f64, f64, f64)> = OnceLock::new();
    ANCHORS.get_or_init(|| {
        let c = &spec().accuracy_curve;
        let denominator = |width: f64| (100.0 * width + 0.9f64.powf(20.0)).powf(0.05);
        let p98 = 4.5 * (0.98 - c.gate) / denominator(0.02);
        let p99_original = 4.5 * (0.99 - c.gate) / denominator(0.01);
        // The 0.98..0.99 band keeps only `g98` of the gain the original curve had there: that band is where high-accuracy scores used to be overestimated.
        let p99 = p98 + (p99_original - p98) * c.g98;
        let p995 = p99 + c.g995;
        let tail_c = (1.0 - p995) / (1.0 - 0.995f64).powf(c.k_tail);
        (p98, p99, p995, tail_c)
    })
}

/// Unreshaped accuracy -> PP proportion, the original sunny curve (kept as a baseline).
pub fn performance_proportion_legacy(acc: f64) -> f64 {
    let gate = spec().accuracy_curve.gate;
    if acc > gate {
        return 4.5 * (acc - gate) / (100.0 * (1.0 - acc) + 0.9f64.powf(20.0)).powf(0.05);
    }
    0.0
}

/// Accuracy -> PP proportion (the reference's reshaped v1.1 curve).
///
/// * `acc <= gate` (0.8) -> 0.0: a score below the gate is worth nothing,
/// * `0.8 .. 0.98` -> the original sunny formula (the main distribution lives here),
/// * `0.98 .. 0.99` -> a band where the slope is deliberately flattened (only `g98` of the
///   original gain is kept),
/// * `0.99 .. 0.995` -> a short connector band,
/// * `>= 0.995` -> a steep tail `1 - C * (1 - acc)^k_tail` whose derivative *grows* as the
///   accuracy approaches 1: the closer to a perfect score, the more each point is worth.
pub fn performance_proportion(acc: f64) -> f64 {
    let c = &spec().accuracy_curve;
    if acc <= c.gate {
        return 0.0;
    }
    if acc <= 0.98 {
        return 4.5 * (acc - c.gate) / (100.0 * (1.0 - acc) + 0.9f64.powf(20.0)).powf(0.05);
    }
    let (p98, p99, p995, tail_c) = *acc_anchors();
    if acc <= 0.99 {
        return p98 + (p99 - p98) * ((acc - 0.98) / 0.01);
    }
    if acc <= 0.995 {
        return p99 + (p995 - p99) * ((acc - 0.99) / 0.005);
    }
    1.0 - tail_c * (1.0 - acc).powf(c.k_tail)
}

/// star -> star term of the difficulty value (`diff_value` without the proportion).
pub fn star_value(star: f64) -> f64 {
    let pp = &spec().pp;
    pp.base * py_max(star - pp.star_offset, pp.star_floor).powf(pp.exponent)
}

/// Variation (stream pattern variety) -> multiplier: a logistic between `variety_lo` and `variety_hi` with its midpoint at `variety_mid`.
pub fn variety_multiplier(variety: f64) -> f64 {
    let pp = &spec().pp;
    pp.variety_lo
        + (pp.variety_hi - pp.variety_lo)
            / (1.0 + (-pp.variety_k * (variety - pp.variety_mid)).exp())
}

/// Explicit accuracy-scalar multiplier (`acc_scalar == 1.0` makes it exactly 1.0).
///
/// The sigmoid maps the scalar to a weight in `[base, base + amp]`, which is then blended between the two terms of `2 * acc^k - 1` and `2 - 2 * acc^k`. In this project the three channel price always passes `acc_scalar = 1.0` (the accuracy channel is carried by [`accuracy_factor`]), so this is the "old" sunny knob kept for the comparison baselines.
pub fn acc_multiplier(acc: f64, acc_scalar: f64) -> f64 {
    let c = &spec().accuracy_curve;
    let sigmoid_scaler =
        c.acc_scalar_base + c.acc_scalar_amp / (1.0 + (-c.acc_scalar_k * (acc_scalar - 1.0)).exp());
    let power = acc.powf(c.acc_scalar_k);
    sigmoid_scaler * (2.0 * power - 1.0) + 2.0 - 2.0 * power
}

/// Note-count / star -> length multiplier (`1.0` for an empty map or a non-finite star).
///
/// A negative star would take the square root of a negative number: the reference raises `ValueError` there, this port yields NaN (the input is outside the documented domain).
pub fn length_multiplier(total_notes: f64, star: f64) -> f64 {
    if total_notes <= 0.0 || !star.is_finite() {
        return 1.0;
    }
    spec().pp.length_numerator / (1.0 + (star / (2.0 * total_notes)).sqrt())
}

/// Key count -> the typical mean chord of that key count.
///
/// Measured values (`chord.typical_measured`: 4K 1.471, 6K 1.812, 7K 2.109) win; every other key count is extrapolated linearly from the measured 4K value with the measured slope (`chord.slope_per_key`), floored at 1.0 (no chords at all).
pub fn typical_chord(keys: i32) -> f64 {
    let chord = &spec().chord;
    if let Some(measured) = chord.typical_measured.get(&keys.to_string()) {
        return *measured;
    }
    let base = chord
        .typical_measured
        .get("4")
        .copied()
        .unwrap_or(chord.reference);
    let v = base + chord.slope_per_key * f64::from(keys - 4);
    1.0f64.max(v)
}

/// Mean chord -> timing-sigma amplification (`1.0` = the 4K anchor; `> 1` = harder to stay accurate). Diagnostic only: it feeds the expected-loss model, never the price.
fn sigma_scale_from_chord(mean_chord: f64) -> f64 {
    let chord = &spec().chord;
    if !(mean_chord > 0.0) {
        return 1.0;
    }
    let v = 1.0 + chord.sigma_beta * (mean_chord - chord.reference);
    clamp_py(v, chord.sigma_clamp[0], chord.sigma_clamp[1])
}

/// Mean chord -> accuracy *pricing* adjustment (a weak coupling, deliberately about a seventh of the sigma version: the full timing evidence cannot enter the price without moving the overall calibration water level).
pub fn acc_boost_from_chord(mean_chord: f64) -> f64 {
    let chord = &spec().chord;
    if !(mean_chord > 0.0) {
        return 1.0;
    }
    let v = 1.0 + chord.acc_beta * (mean_chord - chord.reference);
    clamp_py(v, chord.acc_clamp[0], chord.acc_clamp[1])
}

/// Key count -> accuracy pricing adjustment, derived from the map's chord structure.
///
/// `mean_chord` is the map's measured mean simultaneous press count; when it is absent the typical chord of that key count is used ([`typical_chord`]), which degrades the coupling to "key count only". The reference deletes its former per-key hard-coded table precisely because this derivation replaced it.
pub fn key_acc_boost(keys: i32, mean_chord: Option<f64>) -> f64 {
    let mc = mean_chord.unwrap_or_else(|| typical_chord(keys));
    acc_boost_from_chord(mc)
}

/// Key count -> timing-sigma amplification, derived from the map's chord structure.
pub fn key_sigma_scale(keys: i32, mean_chord: Option<f64>) -> f64 {
    let mc = mean_chord.unwrap_or_else(|| typical_chord(keys));
    sigma_scale_from_chord(mc)
}

/// Effective star of the three-channel fusion: `(R_SCALE * R * rice_mod + w * wall_mod * L) * (1 + boost) * stack_mod`.
///
/// * `w` = the key count's LN weight ([`w_m3_keys`]) modulated by the map's cross-column
///   transfer speed ([`coord_transfer_mod`]),
/// * `boost` = the flat star lift from 7K upward ([`star_key_boost`]) — zero since v1.18,
/// * the three shape factors (v1.17) each attach where the structure says they must:
///   `rice_cut_mod` on `R`, `wall_cut_mod` on `w * L`, `stack_boost_mod` on the whole star.
///
/// `ln_gap_cross = None` means "no structural information": the modulation is then exactly 1.0 and the feeling anchors are reproduced bit for bit.
///
/// The four shape quantities are gated **here**, through [`shape_args`], so a caller passing raw values for a 4K map still gets the unmodulated star: the "4K is never touched" rule has exactly one implementation.
#[allow(clippy::too_many_arguments)]
pub fn effective_star(
    r: f64,
    l: f64,
    keys: i32,
    ln_gap_cross: Option<f64>,
    wall_frac: Option<f64>,
    rice_cut: Option<f64>,
    mean_chord: Option<f64>,
    ln_ratio: Option<f64>,
) -> f64 {
    let w = w_m3_keys(keys) * coord_transfer_mod(ln_gap_cross, keys);
    let boost = star_key_boost(keys);
    let (wall, cut, chord, ln) = shape_args(keys, wall_frac, rice_cut, mean_chord, ln_ratio);
    let star = (spec().channels.r_scale * r * rice_cut_mod(cut) + w * wall_cut_mod(wall) * l)
        * (1.0 + boost);
    star * stack_boost_mod(chord, ln)
}

/// The accuracy channel: a multiplier derived **directly from the judgement window**.
///
/// ```text
/// ratio  = perfect_window / w_ref factor = clamp(ratio^(-gamma) * key_acc_boost(keys, mean_chord), clamp_lo, clamp_hi) gamma  = gamma_wide (ratio > 1) | gamma_tight (ratio < 1)
/// ```
///
/// `w_ref` **must be the same map without mods** (`windows_for(od, "")`), not an absolute constant: the map's own OD is already priced by the star rating, so a fixed reference would charge OD twice (a NM score's factor would climb from 0.50 at OD 2 to 1.00 at OD 8). With the map-relative reference, an NM score is exactly 1.0.
///
/// Because `HR`/`EZ`/`DA` all reach the OD and the window through the *same* path (see [`crate::windows`]), a mod-name multiplier is neither needed nor sufficient — `DA` can reproduce an EZ window exactly, so a name-based discount could be bypassed.
pub fn accuracy_factor(
    perfect_window: f64,
    keys: i32,
    w_ref: Option<f64>,
    mean_chord: Option<f64>,
) -> f64 {
    let acc = &spec().accuracy;
    let reference = w_ref.unwrap_or(acc.w_ref);
    if !(perfect_window > 0.0) || !(reference > 0.0) {
        return 1.0;
    }
    let ratio = perfect_window / reference;
    let gamma = if ratio > 1.0 {
        acc.gamma_wide
    } else {
        acc.gamma_tight
    };
    let factor = ratio.powf(-gamma) * key_acc_boost(keys, mean_chord);
    clamp_py(factor, acc.factor_clamp[0], acc.factor_clamp[1])
}

/// Flat PP multiplier of a mod set (forwarded to the mods module: one mechanism, one place).
pub fn mod_multiplier(m: &ModSet) -> f64 {
    flat_pp_multiplier(m)
}

/// No-Fail factor of a score (forwarded to the mods module).
///
/// `1.0` without `NF`, the official flat `0.75` when the map's HP is unknown, and the risk model otherwise.
pub fn nf_factor(m: &ModSet, hp: Option<f64>, counts: &Counts, ln_hold_share: f64) -> f64 {
    nf_multiplier(m, hp, counts, ln_hold_share)
}

/// The sunny "rebirth" body (with this project's mod split), `None` when an input is missing.
///
/// # Why `Option`
///
/// The reference returns `None` when the star, the variety or the accuracy scalar is missing. An `f64` cannot be absent, so the "missing" case is expressed as **NaN** here: a NaN star, variety or scalar returns `None`, which is what a caller with absent difficulty attributes needs (the CLI reports "no pp" rather than a meaningless number). A zero proportion (an accuracy at or below the gate) is *not* missing and returns `Some(0.0)`.
///
/// The multiplication order of the reference is preserved term by term; the `nf_factor` is applied here, once, and not again by the three-channel combination.
#[allow(clippy::too_many_arguments)]
pub fn sunny_rebirth_pp(
    star: f64,
    variety: f64,
    acc_scalar: f64,
    total_notes: f64,
    counts: &Counts,
    m: &ModSet,
    hp: Option<f64>,
    ln_hold_share: f64,
) -> Option<f64> {
    if star.is_nan() || variety.is_nan() || acc_scalar.is_nan() {
        return None;
    }
    let acc = custom_accuracy(counts);
    let proportion = performance_proportion(acc);
    if proportion == 0.0 {
        return Some(0.0);
    }
    let diff_value = star_value(star) * proportion;
    Some(
        diff_value
            * mod_multiplier(m)
            * nf_factor(m, hp, counts, ln_hold_share)
            * variety_multiplier(variety)
            * acc_multiplier(acc, acc_scalar)
            * length_multiplier(total_notes, star),
    )
}

/// The final three-channel price.
///
/// 1. `eff_star = effective_star(R, L, keys, ln_gap_cross, wall_frac, rice_cut, mean_chord, ln_ratio)`,
/// 2. `base = sunny_rebirth_pp(eff_star, variety, 1.0, ...)` — which already carries the flat
///    mod multiplier and the No-Fail factor,
/// 3. `PP = base * (1 + ACC_WEIGHT * (acc_factor - 1))`.
///
/// The last step is the A-channel volume knob: `ACC_WEIGHT = 1` is the current behaviour, `0` switches the accuracy channel off entirely, and values above 1 amplify it. It only scales the *window-derived* factor — the score's own accuracy curve ([`performance_proportion`]) is never touched by it.
///
/// A missing difficulty attribute (NaN `R`/`L`/`variety`, see [`sunny_rebirth_pp`]) yields NaN, the `f64` spelling of the reference's `None`.
#[allow(clippy::too_many_arguments)]
pub fn three_channel_pp_final(
    r: f64,
    l: f64,
    keys: i32,
    variety: f64,
    acc_factor: f64,
    total_notes: f64,
    counts: &Counts,
    m: &ModSet,
    hp: Option<f64>,
    ln_hold_share: f64,
    ln_gap_cross: Option<f64>,
    wall_frac: Option<f64>,
    rice_cut: Option<f64>,
    mean_chord: Option<f64>,
    ln_ratio: Option<f64>,
) -> f64 {
    let eff = effective_star(
        r,
        l,
        keys,
        ln_gap_cross,
        wall_frac,
        rice_cut,
        mean_chord,
        ln_ratio,
    );
    let Some(base) = sunny_rebirth_pp(eff, variety, 1.0, total_notes, counts, m, hp, ln_hold_share)
    else {
        return f64::NAN;
    };
    let acc_factor_w = 1.0 + spec().channels.acc_weight * (acc_factor - 1.0);
    base * acc_factor_w
}

/// Normalized "loss" of a judgement distribution (the expected-loss signal of the accuracy diagnostics, ported from the rust fork's per-judgement timing adjustment).
///
/// Each judgement contributes the amount by which it pulls the accuracy below 1.0, weighted by an asymmetric penalty (`1.0, 1.1, 1.2, 1.4, 1.8, 2.6`). Unlike 305 accuracy, this is *unsaturated* near the top, which is why it can drive an accuracy channel that OD, mods and key count all feed into.
pub fn judgement_loss(counts: &Counts) -> f64 {
    let as_f64: [f64; 6] = [
        f64::from(counts[0]),
        f64::from(counts[1]),
        f64::from(counts[2]),
        f64::from(counts[3]),
        f64::from(counts[4]),
        f64::from(counts[5]),
    ];
    judgement_loss_f64(&as_f64)
}

/// [`judgement_loss`] over fractional (expected) counts.
fn judgement_loss_f64(counts: &[f64]) -> f64 {
    let total: f64 = counts.iter().sum();
    if total <= 0.0 {
        return 0.0;
    }
    let d = &spec().diagnostics;
    let mut loss = 0.0;
    for (i, count) in counts.iter().enumerate() {
        loss += (*count / total) * (1.0 - d.acc_weights[i]) * d.penalty_weights[i];
    }
    loss
}

/// Score-conditioned timing adjustment, clamped to `timing_clamp`.
///
/// Compares the player's judgement distribution with the map's expected one: a player who loses less than expected gets a multiplier above 1, one who loses more gets below 1. `1.0` when either distribution is empty.
pub fn timing_adjustment_multiplier(player_counts: &Counts, expected_counts: &[f64]) -> f64 {
    if total_of(player_counts) <= 0.0 {
        return 1.0;
    }
    if expected_counts.iter().sum::<f64>() <= 0.0 {
        return 1.0;
    }
    let loss_diff = judgement_loss(player_counts) - judgement_loss_f64(expected_counts);
    let d = &spec().diagnostics;
    let multiplier = 1.0 - loss_diff * d.timing_scale;
    clamp_py(multiplier, d.timing_clamp[0], d.timing_clamp[1])
}

/// Map-intrinsic timing factor, a power law of the expected timing loss.
///
/// ```text
/// factor = clamp((loss / anchor)^gamma, clamp_lo, clamp_hi)
/// ```
///
/// `loss` (the first parameter) is the map's **expected timing loss** — the reference calls it `timing_loss`. The parameter name `expected_accuracy` is historical: the earlier v1.2 form (`1 + 20 * (0.99204 - acc_expected)`) was deleted from the reference in v1.9b and no longer exists, so the power-law loss form is the only behaviour to port. Pass `spec().diagnostics.loss_anchor` / `loss_gamma` for `anchor` / `gain`.
///
/// A non-positive loss or anchor returns the lower clamp (a map that cannot be failed is not rewarded), never a NaN.
pub fn map_timing_factor(expected_accuracy: f64, anchor: f64, gain: f64) -> f64 {
    let d = &spec().diagnostics;
    if !(expected_accuracy > 0.0) || !(anchor > 0.0) {
        return d.map_factor_clamp[0];
    }
    let factor = (expected_accuracy / anchor).powf(gain);
    clamp_py(factor, d.map_factor_clamp[0], d.map_factor_clamp[1])
}
