//! Single source of truth for the *tunable* constants of the reimagined algorithm.
//!
//! The Python research repository (`mania_surface_research`) owns the specification. Its `scripts/export_engine_spec.py` writes `spec/spec.json` in this repository, and this crate embeds that file at compile time. Nothing here is hand-maintained: if the research side changes a knob and this repository is not re-synced, the golden-vector replay on the research side fails loudly (this repository ships no test code by policy).
//!
//! Rules of the sync protocol (see `docs/usage.md`, section "Specification sync"):
//! 1. Research repository = specification truth (Python reference implementation).
//! 2. Constants move one way: Python -> `spec/spec.json` -> this crate.
//! 3. Facts about osu! itself (mod acronyms, health deltas that come from the game's
//!    source) live next to the code that uses them, not here; only *tunable* values do.
//!
//! ```no_run
//! let spec = mania_pp_spec::spec(); assert!(spec.accuracy.gamma_wide > 0.0);
//! ```

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Deserialize;

/// Version of the specification this engine build was synced from.
///
/// Bump this together with a research-side export; the unit test below makes a stale engine fail instead of silently reporting numbers from an older specification.
pub const EXPECTED_SPEC_VERSION: &str = "v1.14";

/// Embedded export of the research specification.
const SPEC_JSON: &str = include_str!("../../../spec/spec.json");

/// Reshaping of the 305-weighted accuracy curve (research v1.1).
#[derive(Debug, Clone, Deserialize)]
pub struct AccuracyCurve {
    /// Gate below which a score is worth nothing.
    pub gate: f64,
    /// Gain ratio kept in the 0.98..0.99 band (1.0 = upstream curve).
    pub g98: f64,
    /// Absolute increment of the 0.99..0.995 band.
    pub g995: f64,
    /// Exponent of the >= 0.995 tail (`1 - C * (1 - acc)^k_tail`).
    pub k_tail: f64,
    /// Sigmoid scaler applied when an explicit acc scalar is used (legacy path).
    pub acc_scalar_base: f64,
    /// Amplitude of that sigmoid.
    pub acc_scalar_amp: f64,
    /// Steepness of that sigmoid.
    pub acc_scalar_k: f64,
}

/// Chord (simultaneous press) structure coupling.
#[derive(Debug, Clone, Deserialize)]
pub struct Chord {
    /// Mean chord the coefficients are anchored to (4K measured median).
    pub reference: f64,
    /// Chord delta -> timing sigma scaling.
    pub sigma_beta: f64,
    pub sigma_clamp: [f64; 2],
    /// Chord delta -> accuracy pricing coupling (weak on purpose).
    pub acc_beta: f64,
    pub acc_clamp: [f64; 2],
    /// Objects closer than this are considered one chord.
    pub simultaneity_ms: f64,
    /// Measured typical chord per key count.
    pub typical_measured: BTreeMap<String, f64>,
    /// Linear slope used to extrapolate the typical chord to other key counts.
    pub slope_per_key: f64,
}

/// Key-count handling: LN weight anchors and the >= 7K star boost.
#[derive(Debug, Clone, Deserialize)]
pub struct Keys {
    pub min: i32,
    pub max: i32,
    /// Feeling anchors: key count -> LN weight. Interpolated in between.
    pub ln_w_anchors: BTreeMap<String, f64>,
    /// Weight approached when going below the lowest anchor (1K = no cross-column).
    pub ln_w_key_min: f64,
    /// Cap for key counts above the highest anchor.
    pub ln_w_key_max: f64,
    /// Extra weight added per key above the highest anchor.
    pub ln_w_key_step: f64,
    /// Star boost applied from this key count on.
    pub star_key_boost_from: i32,
    pub star_key_boost: f64,
    /// Key mod acronym -> column count (converts only).
    pub key_mods: BTreeMap<String, i32>,
}

/// Per-channel volume knobs (stage C of the research roadmap).
#[derive(Debug, Clone, Deserialize)]
pub struct Channels {
    pub r_scale: f64,
    pub acc_weight: f64,
}

/// Cross-column transfer modulation of the L (coordination) channel.
#[derive(Debug, Clone, Deserialize)]
pub struct Coord {
    pub transfer_beta: f64,
    /// Reference release->cross-column gap per key count.
    pub gap_ref: BTreeMap<String, f64>,
    pub gap_ref_default: f64,
    pub mod_clamp: [f64; 2],
}

/// Window-derived accuracy multiplier.
#[derive(Debug, Clone, Deserialize)]
pub struct Accuracy {
    /// Fallback reference perfect window (quantized OD8 without mods).
    pub w_ref: f64,
    /// Discount exponent when the window is wider than the reference.
    pub gamma_wide: f64,
    /// Lift exponent when the window is tighter than the reference.
    pub gamma_tight: f64,
    pub factor_clamp: [f64; 2],
}

/// Star -> PP mapping constants (the sunny "rebirth" body).
#[derive(Debug, Clone, Deserialize)]
pub struct Pp {
    pub base: f64,
    pub star_offset: f64,
    pub star_floor: f64,
    /// Lower star floor used by the pattern term.
    pub star_floor_pattern: f64,
    pub exponent: f64,
    pub variety_lo: f64,
    pub variety_hi: f64,
    pub variety_k: f64,
    pub variety_mid: f64,
    pub length_numerator: f64,
}

/// No-Fail risk model tunables.
#[derive(Debug, Clone, Deserialize)]
pub struct Nf {
    /// `"exp"` (current) or `"piecewise"` (exact anchors).
    pub curve: String,
    /// Piecewise anchors: (effective HP, multiplier).
    pub hp_points: Vec<[f64; 2]>,
    /// Curvature of the risk-domain exponential.
    pub exp_k: f64,
    pub mult_min: f64,
    pub mult_max: f64,
    pub risk_r0: f64,
    pub risk_r1: f64,
    /// Extra lives granted by EZ (default configuration).
    pub ez_extra_lives: i32,
    /// Upper clamp of the effective HP.
    pub hp_max: f64,
}

/// Diagnostic-only constants (the expected-loss timing model).
#[derive(Debug, Clone, Deserialize)]
pub struct Diagnostics {
    pub acc_weights: Vec<f64>,
    pub penalty_weights: Vec<f64>,
    pub timing_scale: f64,
    pub timing_clamp: [f64; 2],
    pub loss_anchor: f64,
    pub loss_gamma: f64,
    pub map_factor_clamp: [f64; 2],
}

/// The whole exported specification.
#[derive(Debug, Clone, Deserialize)]
pub struct Spec {
    pub spec_version: String,
    /// Where the export came from (research repo revision).
    pub source: String,
    pub accuracy_curve: AccuracyCurve,
    pub chord: Chord,
    pub keys: Keys,
    pub channels: Channels,
    pub coord: Coord,
    pub accuracy: Accuracy,
    pub pp: Pp,
    pub nf: Nf,
    pub diagnostics: Diagnostics,
}

static SPEC: OnceLock<Spec> = OnceLock::new();

/// Parsed specification, embedded at compile time.
///
/// Panics only if the embedded JSON is malformed, which the unit tests rule out.
pub fn spec() -> &'static Spec {
    SPEC.get_or_init(|| {
        serde_json::from_str(SPEC_JSON).expect("embedded spec/spec.json must deserialize")
    })
}

/// Raw JSON of the embedded specification (useful for `--version` style output).
pub fn raw_json() -> &'static str {
    SPEC_JSON
}
