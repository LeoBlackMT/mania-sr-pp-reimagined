//! Key-count resolution and the key-count side of the coordination weight.
//!
//! Ported from `pp_formula.effective_keys` / `w_m3_keys` / `coord_transfer_mod` / `STAR_KEY_BOOST`.
//!
//! # Why key resolution takes six arguments
//!
//! The CS field of a **std -> mania convert** is the circle *radius*, not a column count, so a convert's key count has to be derived from the official conversion rule — which needs OD and the slider/spinner share as well. An audit of the research scripts found three call sites passing only the first three arguments, which misclassified 284 of 286 converts as 6K. Hence: all six parameters are mandatory and none of them may be dropped.
//!
//! Priority, verified against the game's source:
//!
//! 1. **native mania (`Mode = 3`)** -> `clamp(round(CS), 1, 18)`; key mods are a no-op there
//!    (`ManiaKeyMod.ApplyToBeatmapConverter` returns early when the map already is for the current ruleset).
//! 2. **std convert** -> a key mod, if present, is authoritative.
//! 3. **std convert** -> the official rule (`getColumnCount`): slider/spinner share plus OD,
//!    with CS only entering the `roundedCircleSize >= 5` test.

use std::sync::OnceLock;

use mania_pp_spec::{shape, spec};

use crate::reimagined::mods::{clamp_py, ModSet};

/// Upper bound used by the official convert rule when the object counts are unknown.
const CONVERT_FALLBACK_MIN_KEYS: i32 = 4;
/// Upper bound of the same fallback.
const CONVERT_FALLBACK_MAX_KEYS: i32 = 7;
/// Slider/spinner share below which a std map converts to the maximum column count.
const SPECIAL_FRACTION_SPARSE: f64 = 0.2;
/// Share below which (or `CS >= 5`, which) selects the 6/7-column pair.
const SPECIAL_FRACTION_MEDIUM: f64 = 0.3;
/// Share above which the smallest column counts are used.
const SPECIAL_FRACTION_DENSE: f64 = 0.6;

/// The map mode that means "already mania": key mods do not apply.
const MODE_MANIA: i32 = 3;

/// Anchor table of [`w_m3_keys`], sorted by key count ascending.
fn ln_w_anchors() -> &'static [(i32, f64)] {
    static ANCHORS: OnceLock<Vec<(i32, f64)>> = OnceLock::new();
    ANCHORS.get_or_init(|| {
        let mut v: Vec<(i32, f64)> = spec()
            .keys
            .ln_w_anchors
            .iter()
            .filter_map(|(k, v)| k.parse::<i32>().ok().map(|k| (k, *v)))
            .collect();
        v.sort_by_key(|(k, _)| *k);
        v
    })
}

/// The actual column count of a mania score (1..18).
///
/// # Parameters (all six required, see the module docs)
///
/// * `mode` — the map's `Mode` header (`3` = native mania, anything else is a convert here),
/// * `cs` — the map's `CircleSize` (the *key count* on native mania, the circle radius on a
///   std map; never use it directly),
/// * `m` — the score's mods (key mods only matter for converts),
/// * `od` — the map's base `OverallDifficulty` (the official convert rule rounds it),
/// * `total_objects` — number of hit objects. Pass `0` when unknown: that reproduces the
///   reference's fallback branch, which the Python `None` also reaches.
/// * `end_time_objects` — number of objects **with an end time** (sliders and spinners on a
///   std map, i.e. lazer's `EndTimeObjectCount`). This is a real count, not an optional: `0` (a map with plain notes only) is a meaningful input that sends the official rule to the 7-column branch.
///
/// # Historical traps
///
/// * The `Math.Round(OD)` of the convert rule is C#'s **half-to-even** rounding, and the
///   threshold is `> 4`: OD 4.5 rounds to 4 and therefore lands on the `+1` fallback rather than the next branch. `round_ties_even()` is used here for exactly that reason.
/// * Key-mod detection is substring based on the upper-cased mod string in the reference.
///   It is expressed here as membership in the parsed [`ModSet`], which is equivalent for every acronym of the mod table. `10K` must not be matched as `1K`: the acronyms are looked up by ascending key count, and `"1K"` is not a substring of `"10K"` anyway.
pub fn effective_keys(
    mode: i32,
    cs: f64,
    m: &ModSet,
    od: f64,
    total_objects: usize,
    end_time_objects: usize,
) -> i32 {
    let keys = &spec().keys;

    // The reference rounds CS unconditionally, before deciding which branch to take.
    let rounded_cs = cs.round_ties_even();

    // ---- 1. native mania: CS is the key count, key mods are ignored ----
    if mode == MODE_MANIA {
        let k = rounded_cs.max(1.0) as i32;
        return k.clamp(keys.min, keys.max);
    }

    // ---- 2. std convert: an explicit key mod wins ---- Ascending key count mirrors the reference's `KEY_MODS` dict order.
    let mut key_mods: Vec<(&String, i32)> = keys.key_mods.iter().map(|(k, v)| (k, *v)).collect();
    key_mods.sort_by_key(|(_, v)| *v);
    for (acronym, columns) in key_mods {
        if m.has(acronym) {
            return columns.clamp(keys.min, keys.max);
        }
    }

    // ---- 3. std convert: the official rule ----
    let rounded_od = od.round_ties_even();
    // `max(4, min(round(od) + 1, 7))`, used both by the last branch and as the fallback for maps whose object counts are unknown. `saturating_add` keeps an absurd OD finite where Python would compute with a bignum (the result is 7 either way).
    let fallback = CONVERT_FALLBACK_MIN_KEYS
        .max(CONVERT_FALLBACK_MAX_KEYS.min((rounded_od as i32).saturating_add(1)));

    let k = if total_objects > 0 {
        let pct = end_time_objects as f64 / total_objects as f64;
        if pct < SPECIAL_FRACTION_SPARSE {
            7
        } else if pct < SPECIAL_FRACTION_MEDIUM || rounded_cs >= 5.0 {
            if rounded_od > 5.0 {
                7
            } else {
                6
            }
        } else if pct > SPECIAL_FRACTION_DENSE {
            if rounded_od > 4.0 {
                5
            } else {
                4
            }
        } else {
            fallback
        }
    } else {
        fallback
    };
    k.clamp(keys.min, keys.max)
}

/// Key-count dependent LN (coordination) weight: feeling anchors, linearly interpolated.
///
/// The anchors are the user's feeling specification — 4K 0.95, 5K/6K 1.00, 7K 1.15 — and are exported in the spec; they must not be "improved". Outside them the reference extrapolates structurally rather than pretending to have data:
///
/// * below the lowest anchor: linear from `ln_w_key_min` at `keys.min` (1K: a single column
///   has no cross-column coordination at all) to the anchor,
/// * above the highest anchor: `+ln_w_key_step` per key, capped by `ln_w_key_max`.
pub fn w_m3_keys(keys: i32) -> f64 {
    let k = &spec().keys;
    let anchors = ln_w_anchors();
    if anchors.is_empty() {
        // Unreachable with an exported spec; a neutral weight is the safe degradation.
        return 1.0;
    }
    if let Some((_, v)) = anchors.iter().find(|(a, _)| *a == keys) {
        return *v;
    }
    let (anchor_lo, value_lo) = anchors[0];
    let (anchor_hi, value_hi) = anchors[anchors.len() - 1];
    if keys < anchor_lo {
        // `ln_w_key_min` at the lowest supported key count (the reference's `LN_W_KEY_FLOOR_K`, which equals `keys.min`), rising to the lowest anchor.
        let floor_k = k.min;
        let t = f64::from(keys - floor_k) / f64::from(anchor_lo - floor_k);
        return k
            .ln_w_key_min
            .max(k.ln_w_key_min + (value_lo - k.ln_w_key_min) * t);
    }
    if keys > anchor_hi {
        let v = value_hi + k.ln_w_key_step * f64::from(keys - anchor_hi);
        return k.ln_w_key_max.min(v);
    }
    for pair in anchors.windows(2) {
        let (a, va) = pair[0];
        let (b, vb) = pair[1];
        if a < keys && keys < b {
            let t = f64::from(keys - a) / f64::from(b - a);
            return va + (vb - va) * t;
        }
    }
    // The reference's final fallback (`LN_W_ANCHORS.get(k, 1.0)`): unreachable while the anchors are integers and `keys` is an integer strictly inside them.
    1.0
}

/// Flat star lift applied from 7K upward (the cross-column load keeps growing while the hand layout stops changing).
///
/// Returns 0.0 outside `star_key_boost_from ..= keys.max`: the reference reads this from a dict keyed by 7..18, so 19K+ has *no* boost even though [`w_m3_keys`] keeps rising.
///
/// That dict is **empty since v1.18** — the owner's feedback was that 7K was priced too high, with a target of roughly sunny +5% — and an empty dict is 0.0 everywhere. The code path is unchanged, the value is simply zero; the spec exports `star_key_boost_from = 7` with `star_key_boost = 0.0` so this branch still reads naturally. The research side keeps the feeling anchor 0.03 as `STAR_KEY_BOOST_RECOMMENDED` for a future swing back, and its liveness check still proves the mechanism alive by setting a value at runtime.
pub fn star_key_boost(keys: i32) -> f64 {
    let k = &spec().keys;
    if keys >= k.star_key_boost_from && keys <= k.max {
        k.star_key_boost
    } else {
        0.0
    }
}

// ---------------------------------------------------------------------------
// Key-type axes (v1.17, research `pp_formula.{wall_cut_mod, rice_cut_mod,
// stack_boost_mod, shape_args}`)
// ---------------------------------------------------------------------------
//
// Three shape modulations of the fused star rating. Their **attachment points are dictated by
// structure**, not by taste, and the research measurements are the reason:
//
// * `wall_cut_mod` (A) multiplies `w * L`. The L channel is where the markup of a long-note
//   wall lives (residual against `wall` +0.78, against `ln_ratio` +0.83).
// * `rice_cut_mod` (C) multiplies `R`. A rice cut is pure tapping (`L ~ 0`), so multiplying
//   `w * L` would be a no-op.
// * `stack_boost_mod` (B) multiplies the **whole star**. Stack maps are almost entirely rice,
//   and applying the chord factor to `w * L` measured exactly 0.00% change.
//
// All three are gated to `keys >= shape.min_keys` (i.e. above 4K): the owner's ruling is to
// compress the multi-key side, never to lift 4K. That gate lives **inside** `effective_star`
// via [`shape_args`], so a caller cannot bypass it by passing raw quantities.

/// A 4-tuple of the shape quantities, gated by key count.
///
/// `None` in every slot means "no shape modulation": either the map is 4K or below (the gate), or the caller has no structural information. Returns `(wall_frac, rice_cut, mean_chord, ln_ratio)`, ready to spread into [`effective_star`](crate::reimagined::pp::effective_star).
///
/// This is the **only** place the "4K stays bit-for-bit unchanged" rule is implemented, and `effective_star` calls it internally rather than trusting its caller.
pub fn shape_args(
    keys: i32,
    wall_frac: Option<f64>,
    rice_cut: Option<f64>,
    mean_chord: Option<f64>,
    ln_ratio: Option<f64>,
) -> (Option<f64>, Option<f64>, Option<f64>, Option<f64>) {
    if keys < shape().min_keys {
        return (None, None, None, None);
    }
    (wall_frac, rice_cut, mean_chord, ln_ratio)
}

/// **A axis — compress long-note walls.** Multiplies `w * L`; neutral at or below `shape.wall_ref`, full `shape.beta` at a complete wall.
///
/// `None` yields the neutral 1.0 (no information, no extrapolation).
pub fn wall_cut_mod(wall_frac: Option<f64>) -> f64 {
    let s = shape();
    let Some(wall) = wall_frac else {
        return 1.0;
    };
    if !wall.is_finite() {
        return 1.0;
    }
    let span = (wall - s.wall_ref) / (1.0 - s.wall_ref);
    clamp_py(1.0 - s.beta * clamp_py(span, 0.0, 1.0), 1.0 - s.beta, 1.0)
}

/// **C axis — compress rice cuts.** Multiplies `R`; neutral at or below `shape.rice_cut_ref`.
///
/// The input is the fast cross-column transfer fraction of the rice side
/// ([`crate::reimagined::features::rice_cut_fraction`]), which is what distinguishes a rice cut
/// from a stack without leaning on density.
pub fn rice_cut_mod(rice_cut: Option<f64>) -> f64 {
    let s = shape();
    let Some(cut) = rice_cut else {
        return 1.0;
    };
    if !cut.is_finite() {
        return 1.0;
    }
    let span = (cut - s.rice_cut_ref) / (1.0 - s.rice_cut_ref);
    clamp_py(1.0 - s.beta * clamp_py(span, 0.0, 1.0), 1.0 - s.beta, 1.0)
}

/// **B axis — lift stacks.** Multiplies the **whole star**; neutral at or below `shape.chord_ref_med`, capped at `shape.beta` from `shape.chord_ref_p90` on.
///
/// Scope-gated as well, and deliberately so: only **rice stacks** are lifted (`ln_ratio < shape.stack_ln_max` and `mean_chord >= shape.stack_chord_min`). The chord structure of a *mixed* map (long-note wall plus chords) is already priced by the L channel, so lifting it again would be double counting — and in practice it pushed the very maps the owner called overestimated even higher (3449961 +3.30%, 4973092 +3.42%, the latter ending up net **positive** under A+B+C). With the gate those two land at −3.86% / −2.72% while stacks still gain +9.08%.
///
/// A missing `ln_ratio` fails the gate: better to lift nothing than to lift the wrong maps.
pub fn stack_boost_mod(mean_chord: Option<f64>, ln_ratio: Option<f64>) -> f64 {
    let s = shape();
    let Some(chord) = mean_chord else {
        return 1.0;
    };
    let Some(ln) = ln_ratio else {
        return 1.0;
    };
    if !chord.is_finite() || !ln.is_finite() {
        return 1.0;
    }
    if ln >= s.stack_ln_max || chord < s.stack_chord_min {
        return 1.0;
    }
    let span = (chord - s.chord_ref_med) / (s.chord_ref_p90 - s.chord_ref_med);
    clamp_py(1.0 + s.beta * clamp_py(span, 0.0, 1.0), 1.0, 1.0 + s.beta)
}

/// Structural modulation of the LN weight by how fast the player must release one column and press another (`release -> next press in a different column`, median in ms).
///
/// sunny's own long-note model only ever looks at the *same* column (its `Rbar` term uses the release-to-next-press gap restricted to one column), so cross-column transfer is invisible to it; this factor supplies that missing dimension. `mod > 1` = faster transfer = harder.
///
/// The reference value is the map's own key count's typical gap (`coord.gap_ref`), so a map with a typical gap gets exactly 1.0 and the feeling anchors are left untouched. `None`, non-finite or non-positive gaps yield the neutral 1.0 (no information, no extrapolation), and the result is clamped to `coord.mod_clamp`.
pub fn coord_transfer_mod(ln_gap_cross: Option<f64>, keys: i32) -> f64 {
    let coord = &spec().coord;
    let Some(gap) = ln_gap_cross else {
        return 1.0;
    };
    // NaN fails this test too, exactly like the reference's `not (gap > 0)`.
    if !(gap > 0.0) {
        return 1.0;
    }
    let reference = coord
        .gap_ref
        .get(&keys.to_string())
        .copied()
        .unwrap_or(coord.gap_ref_default);
    let idx = reference / gap - 1.0;
    let modulation = 1.0 + coord.transfer_beta * idx;
    clamp_py(modulation, coord.mod_clamp[0], coord.mod_clamp[1])
}
