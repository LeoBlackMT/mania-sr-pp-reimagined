//! Judgement windows (osu!mania), ported one-to-one from `surface_units.windows_for`.
//!
//! The window of judgement `j` is, exactly as in osu!lazer's `ManiaHitWindows`:
//!
//! ```text
//! totalMultiplier = speedMultiplier / difficultyMultiplier
//! window_j        = DifficultyRange(od, range_j) * totalMultiplier
//! window_j        = floor(window_j) + 0.5        // stable-legacy quantization
//! ```
//!
//! with `difficultyMultiplier` 1.4 for `HR`, 1/1.4 for `EZ`, and `DifficultyRange` the
//! piecewise-linear OD interpolation of `IBeatmapDifficultyInfo` (linear extrapolation
//! outside 0..10, which is what makes `DA`'s extended `[-15, 15]` range work).
//!
//! # Traps this port preserves deliberately
//!
//! * **`round_ties_even()` for the convert threshold.** The classic convert branch picks its
//!   windows with `Math.Round(OD) > 4`. C# `Math.Round(double)` rounds half to **even**, so
//!   `OD = 4.5` becomes `4` (not `5`) and takes the *wide* pair (`great = 47`,
//!   `good = 77`). Rust's `f64::round()` is half-away-from-zero — the upstream `rosu-pp`
//!   bug this project reported — and would take the tight pair instead. Only OD 4.5 differs,
//!   but it shifts the great window by 13 ms.
//! * **The quantization happens last**, after the multiplier, and is a `floor(v) + 0.5`
//!   (1 ms grid with a 0.5 ms offset, inherited from stable), not a rounding.
//! * **The multiplier association.** `speed / difficulty` is computed first and the raw
//!   window is multiplied by that quotient; `raw / difficulty * speed` is *not* the same
//!   float (`sunny_windows` upstream makes exactly that mistake: 106 grid cells off by 1 ms).
//! * **`speed_multiplier` defaults to 1.0.** lazer's `speedMultiplier` is the clock rate,
//!   which keeps the *realtime* window of a DT play identical to the NM one. This project
//!   prices the rate through the SR variant instead, so the production convention is the
//!   rate-normalized one; the two conventions are both correct but must never be mixed
//!   inside one comparison.
//! * **`DT`/`NC` do not narrow mania windows.**
//! * **`V2` skips the classic branch** (`ClassicModActive && !ScoreV2Active`).

use crate::reimagined::mods::{clamp_py, mod_effects, ModSet};

/// Difficulty-range anchors of the lazer mania windows: `(OD 0, OD 5, OD 10)` per judgement.
///
/// These are facts about the game (`ManiaHitWindows.LAZER_RANGES`), not tunables, so they
/// live here rather than in `mania-pp-spec`.
const LAZER_RANGES: [(f64, f64, f64); 6] = [
    (22.4, 19.4, 13.9),    // perfect
    (64.0, 49.0, 34.0),    // great
    (97.0, 82.0, 67.0),    // good
    (127.0, 112.0, 97.0),  // ok
    (151.0, 136.0, 121.0), // meh
    (188.0, 173.0, 158.0), // miss
];

/// Stable-legacy windows for a std -> mania **convert**: only `great`/`good` depend on OD.
const CLASSIC_CONVERT_PERFECT: f64 = 16.0;
/// `great` when `round_ties_even(OD) > 4`.
const CLASSIC_CONVERT_GREAT_HI: f64 = 34.0;
/// `great` when `round_ties_even(OD) <= 4` (the OD 4.5 side).
const CLASSIC_CONVERT_GREAT_LO: f64 = 47.0;
/// `good` when `round_ties_even(OD) > 4`.
const CLASSIC_CONVERT_GOOD_HI: f64 = 67.0;
/// `good` when `round_ties_even(OD) <= 4`.
const CLASSIC_CONVERT_GOOD_LO: f64 = 77.0;
/// `ok`/`meh`/`miss` of the classic convert formula (OD-independent).
const CLASSIC_CONVERT_TAIL: [f64; 3] = [97.0, 121.0, 158.0];

/// Stable-legacy windows for a **native** mania map: `base + slope * inverted_od`.
const CLASSIC_NATIVE_PERFECT: f64 = 16.0;
/// Base values of `great`/`good`/`ok`/`meh`/`miss` at `inverted_od = 0` (OD 10).
const CLASSIC_NATIVE_TAIL: [f64; 5] = [34.0, 67.0, 97.0, 121.0, 158.0];
/// Slope per point of `inverted_od = clamp(10 - OD, 0, 10)`.
const CLASSIC_NATIVE_OD_SLOPE: f64 = 3.0;

/// `DA`'s extended OD range (`ManiaModDifficultyAdjust`).
const DA_OD_MIN: f64 = -15.0;
/// Upper end of `DA`'s extended OD range.
const DA_OD_MAX: f64 = 15.0;

/// Half-width of every judgement window, in milliseconds.
///
/// The windows are nested: `perfect <= great <= good <= ok <= meh <= miss`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HitWindows {
    /// `320` window.
    pub perfect: f64,
    /// `300` window.
    pub great: f64,
    /// `200` window.
    pub good: f64,
    /// `100` window.
    pub ok: f64,
    /// `50` window.
    pub meh: f64,
    /// Miss window (`> meh`).
    pub miss: f64,
}

/// Everything the window formulas need besides the base OD and the mods.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowOptions {
    /// `CL` is active: use the stable-legacy formulas.
    pub classic: bool,
    /// The map is a std -> mania convert (selects the convert variant of the classic branch).
    pub is_convert: bool,
    /// OD overridden by `DA` (already the raw value; it is clamped to `[-15, 15]` here).
    ///
    /// Only [`windows_for`] consumes it: `DA` is a mod, so the "no mods" constructor ignores
    /// it exactly like the reference's `ManiaHitWindows.from_od`, which has no such argument.
    pub da_od: Option<f64>,
    /// Clock rate (lazer's `speedMultiplier`). Defaults to 1.0 = the rate-normalized
    /// convention of this project.
    pub speed_multiplier: f64,
    /// Apply the `floor(v) + 0.5` quantization. Defaults to `true` (client-aligned).
    pub quantize: bool,
    /// `V2` is active: the classic branch is skipped.
    pub score_v2: bool,
}

impl Default for WindowOptions {
    /// The production defaults: no classic, not a convert, no DA, rate-normalized
    /// (`speed_multiplier = 1.0`) with the client-aligned quantization enabled.
    fn default() -> Self {
        WindowOptions {
            classic: false,
            is_convert: false,
            da_od: None,
            speed_multiplier: 1.0,
            quantize: true,
            score_v2: false,
        }
    }
}

/// OD -> window via the game's piecewise-linear `DifficultyRange` (linear outside 0..10).
fn difficulty_range(od: f64, range: (f64, f64, f64)) -> f64 {
    let (od0, od5, od10) = range;
    if od > 5.0 {
        od5 + (od10 - od5) * (od - 5.0) / 5.0
    } else {
        od5 - (od5 - od0) * (5.0 - od) / 5.0
    }
}

/// Build the windows from an OD that already carries every mod effect.
///
/// This is the mod-free constructor: the window difficulty multiplier is 1.0, because `HR`
/// and `EZ` are applied by [`windows_for`] (a bare OD has no mods to apply). `opts.da_od` is
/// ignored here for the same reason — `DA` is a mod and reaches the OD through
/// [`windows_for`]. The remaining options (`classic`, `is_convert`, `score_v2`, `quantize`,
/// `speed_multiplier`) are honoured.
pub fn from_od(od: f64, opts: WindowOptions) -> HitWindows {
    build(od, opts, 1.0)
}

/// Build the windows for a base OD plus a mod set (the reference's `windows_for`).
///
/// * `HR` divides the windows by 1.4, `EZ` multiplies them by 1.4 (mutually exclusive in the
///   game; when both are present the reference resolves in favour of `HR`).
/// * `DA` overrides the OD entirely (clamped to `[-15, 15]`) and drops the difficulty
///   multiplier — this is the mechanism that makes "a mod-name multiplier for EZ/HR"
///   pointless, and the reason the accuracy channel is derived from the windows.
/// * `CL` selects the stable-legacy formulas and `V2` disables them again.
pub fn windows_for(od: f64, m: &ModSet, opts: WindowOptions) -> HitWindows {
    let effects = mod_effects(m);
    let mut opts = opts;
    opts.classic = effects.classic;
    opts.score_v2 = effects.score_v2;
    match opts.da_od {
        Some(da) => {
            let od = clamp_py(da, DA_OD_MIN, DA_OD_MAX);
            build(od, opts, 1.0)
        }
        None => build(od, opts, effects.window_multiplier),
    }
}

/// The shared body of both constructors.
fn build(od: f64, opts: WindowOptions, difficulty_multiplier: f64) -> HitWindows {
    // `speed / difficulty` first: the reference writes `totalMultiplier` as one quotient and
    // then multiplies every raw window by it, which is not the same float as dividing each
    // window separately (the upstream `sunny_windows` variant is off by 1 ms in 106 cells).
    let total = if difficulty_multiplier != 0.0 {
        opts.speed_multiplier / difficulty_multiplier
    } else {
        1.0
    };

    let mut values = if opts.classic && !opts.score_v2 {
        if opts.is_convert {
            // Stable-legacy convert windows. `round_ties_even` is the C# `Math.Round`
            // behaviour: OD 4.5 rounds to 4 and therefore takes the *wide* pair. Using
            // `f64::round()` here reproduces the upstream rosu-pp defect instead.
            let hi = od.round_ties_even() > 4.0;
            [
                CLASSIC_CONVERT_PERFECT,
                if hi {
                    CLASSIC_CONVERT_GREAT_HI
                } else {
                    CLASSIC_CONVERT_GREAT_LO
                },
                if hi {
                    CLASSIC_CONVERT_GOOD_HI
                } else {
                    CLASSIC_CONVERT_GOOD_LO
                },
                CLASSIC_CONVERT_TAIL[0],
                CLASSIC_CONVERT_TAIL[1],
                CLASSIC_CONVERT_TAIL[2],
            ]
        } else {
            // Stable-legacy native windows: linear in `inverted_od = clamp(10 - OD, 0, 10)`.
            // For OD in 0..10 this is bit-identical to the lazer interpolation for
            // great..miss, so the real differences are the perfect window (16 always) and
            // the convert pair above.
            let inverted = clamp_py(10.0 - od, 0.0, 10.0);
            [
                CLASSIC_NATIVE_PERFECT,
                CLASSIC_NATIVE_TAIL[0] + CLASSIC_NATIVE_OD_SLOPE * inverted,
                CLASSIC_NATIVE_TAIL[1] + CLASSIC_NATIVE_OD_SLOPE * inverted,
                CLASSIC_NATIVE_TAIL[2] + CLASSIC_NATIVE_OD_SLOPE * inverted,
                CLASSIC_NATIVE_TAIL[3] + CLASSIC_NATIVE_OD_SLOPE * inverted,
                CLASSIC_NATIVE_TAIL[4] + CLASSIC_NATIVE_OD_SLOPE * inverted,
            ]
        }
    } else {
        let mut values = [0.0f64; 6];
        for (i, range) in LAZER_RANGES.iter().enumerate() {
            values[i] = difficulty_range(od, *range);
        }
        values
    };

    for v in values.iter_mut() {
        *v *= total;
        if opts.quantize {
            // Client-aligned quantization: 1 ms grid, offset by half a millisecond.
            *v = v.floor() + 0.5;
        }
    }

    HitWindows {
        perfect: values[0],
        great: values[1],
        good: values[2],
        ok: values[3],
        meh: values[4],
        miss: values[5],
    }
}
