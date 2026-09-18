//! `reimagined` — this project's three-channel algorithm: R (regular), L (coordination), A (accuracy).
//!
//! Instead of fusing every difficulty signal into one number, the algorithm keeps the three operationally distinct channels apart and fuses them at pricing time:
//!
//! ```text
//! R = sunny star rating of the map with every hold rewritten as a tap ("rice") L = sunny star rating of the full map - R
//!
//! w         = w_m3_keys(keys) * coord_transfer_mod(rel_gap_cross, keys) eff_star  = (R_SCALE * R + w * L) * (1 + star_key_boost(keys)) PP        = sunny_rebirth_pp(eff_star, variety, acc_scalar, notes, counts, mods, hp, ln_share)
//!             * nf_factor(mods, hp, counts, ln_share)
//!             * accuracy_factor(perfect_window, keys, w_ref, mean_chord)
//! ```
//!
//! Each mechanism and its tunables (LN weight anchors, cross-column modulation, accuracy gamma, chord coupling, No-Fail curve, channel volumes) are documented in [`pp`], [`keys`], [`mods`] and [`windows`]; the values themselves come from `mania-pp-spec`, which is exported from the Python research reference.
//!
//! Submodules are ports of the research reference, one Python module each:
//!
//! | here | research side |
//! |---|---|
//! | [`pp`] | `pp_formula.py` |
//! | [`mods`] | `mods.py` |
//! | [`windows`] | `surface_units.py` (`windows_for`, `ManiaHitWindows`) |
//! | [`keys`] | `pp_formula.py` (`effective_keys`, `w_m3_keys`, `coord_transfer_mod`) |
//! | [`notes`] | `osu_parser.py` |
//! | [`features`] | `coord_features.py` |

/// Algorithm id used in the results document.
pub const ID: &str = "reimagined";

/// Human-readable name for the comparison site.
pub const LABEL: &str = "Reimagined";

/// One-line description shown next to the algorithm.
pub const DESCRIPTION: &str = "three-channel R/L/A algorithm of this project: regular pressing, coordination and accuracy priced separately";

pub mod features;
pub mod keys;
pub mod mods;
pub mod notes;
pub mod pp;
pub mod windows;

use crate::reimagined::windows::WindowOptions;
use crate::{Counts, MapInfo, Prepared, ReimaginedDetail};

/// The channels and derived weights of one score, in the order the pipeline uses them.
pub struct Channels {
    /// Regular pressing difficulty (`sr_rice`).
    pub r: f64,
    /// Coordination increment (`sr_full - sr_rice`).
    pub l: f64,
    /// Coordination weight after key anchoring and cross-column modulation.
    pub w: f64,
    /// Fused star rating fed to the PP mapping.
    pub eff_star: f64,
    /// Window-derived accuracy multiplier.
    pub acc_factor: f64,
    /// No-Fail risk multiplier.
    pub nf_factor: f64,
    /// Share of long-note objects, as consumed by the No-Fail model.
    pub ln_hold_share: f64,
}

/// Derive every intermediate of the pipeline for one score.
pub fn channels(prepared: &Prepared, counts: &Counts) -> Channels {
    let info: &MapInfo = &prepared.map_info;
    let r = prepared.sunny_rice.stars;
    let l = (prepared.sunny_full.stars - prepared.sunny_rice.stars).max(0.0);

    let coord_mod = keys::coord_transfer_mod(info.rel_gap_cross, info.keys);
    let w = keys::w_m3_keys(info.keys) * coord_mod;
    let eff_star = pp::effective_star(
        r,
        l,
        info.keys,
        info.rel_gap_cross,
        info.wall_frac,
        info.rice_cut,
        Some(info.mean_chord),
        Some(info.ln_ratio),
    );

    // w_ref is the *same map without mods*, so the map's own OD is not priced a second time (sunny already contains it through its window parameter).
    let w_mod = windows::windows_for(info.od, &prepared.mod_set, WindowOptions::default()).perfect;
    let w_ref =
        windows::windows_for(info.od, &mods::ModSet::default(), WindowOptions::default()).perfect;
    let acc_factor = pp::accuracy_factor(w_mod, info.keys, Some(w_ref), Some(info.mean_chord));

    let ln_hold_share = mods::ln_hold_share_from_ratio(info.ln_ratio);
    let nf_factor = pp::nf_factor(&prepared.mod_set, Some(info.hp), counts, ln_hold_share);

    Channels {
        r,
        l,
        w,
        eff_star,
        acc_factor,
        nf_factor,
        ln_hold_share,
    }
}

/// Reimagined PP for one score.
pub fn pp(prepared: &Prepared, counts: &Counts) -> f64 {
    let c = channels(prepared, counts);
    let info = &prepared.map_info;

    pp::three_channel_pp_final(
        c.r,
        c.l,
        info.keys,
        prepared.sunny_full.variety,
        c.acc_factor,
        prepared.sunny_full.n_objects as f64,
        counts,
        &prepared.mod_set,
        Some(info.hp),
        c.ln_hold_share,
        info.rel_gap_cross,
        info.wall_frac,
        info.rice_cut,
        Some(info.mean_chord),
        Some(info.ln_ratio),
    )
}

/// The numbers behind [`pp`], for explanations and diagnostics.
pub fn detail(prepared: &Prepared, counts: &Counts) -> ReimaginedDetail {
    let c = channels(prepared, counts);
    let info = &prepared.map_info;
    let total = c.r + c.l;

    ReimaginedDetail {
        stars_full: prepared.sunny_full.stars,
        stars_rice: c.r,
        ln_ratio: info.ln_ratio,
        l_share: if total > 0.0 { c.l / total } else { 0.0 },
        w: c.w,
        coord_mod: keys::coord_transfer_mod(info.rel_gap_cross, info.keys),
        eff_star: c.eff_star,
        acc_factor: c.acc_factor,
        nf_factor: c.nf_factor,
        variety: prepared.sunny_full.variety,
        acc_scalar: prepared.sunny_full.acc_scalar,
    }
}
