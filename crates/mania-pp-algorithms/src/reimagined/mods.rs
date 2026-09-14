//! Mods model: every effect a mod has on the algorithm's inputs.
//!
//! Faithful port of the research reference `mania_surface_research/mods.py` (the single source of mod semantics on the Python side). The module owns
//!
//! * the mod acronym table (a fact about osu! itself, read from the game's source, so it
//!   deliberately lives here rather than in `mania-pp-spec`),
//! * [`ModSet::parse`] — substring matching, because two encodings are in the wild:
//!   the API writes `DT+MR`, while the ppysb report writes `EZDTV2` (unseparated),
//! * [`mod_effects`] — the aggregated effect of a mod set,
//! * the health / No-Fail risk model ([`effective_hp`], [`health_delta`],
//!   [`nf_multiplier`]).
//!
//! # Deliberate differences from the official game (documented in the reference)
//!
//! * `EZ` / `HR` get **no** flat PP multiplier here: their price comes from the judgement
//!   windows they produce (see `crate::windows`), because a mod-name multiplier can be bypassed by `DA` setting the same OD.
//! * `NF` is not a flat `0.75`: it is derived from the *failure risk* of the score
//!   (effective HP, per-judgement health deltas, EZ's extra lives), converging to the official `0.75` only when the score really would have failed without the mod.
//! * `HT` / `DC` have **no** PP multiplier. The `0.3` in lazer is a *score* multiplier;
//!   the rate change is already carried by the SR variant (`rate`), so multiplying again would price the speed twice.

use mania_pp_spec::spec;

use crate::reimagined::pp::Counts;

/// One judgement tier of a mania score, best to worst.
///
/// The order is the order of [`Counts`]: `[n320, n300, n200, n100, n50, miss]`, i.e. `Perfect, Great, Good, Ok, Meh, Miss`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Judgement {
    /// 320 — the tightest tier (305-weighted accuracy counts it as `305/305`).
    Perfect,
    /// 300 (`300/305`).
    Great,
    /// 200 (`200/305`).
    Good,
    /// 100 (`100/305`).
    Ok,
    /// 50 (`50/305`).
    Meh,
    /// Miss (`0/305`).
    Miss,
}

/// Mods that can be ranked in osu!mania (21, verified one by one against the game source).
///
/// Note that `HR`, `DA`, `CL`, `V2`, the key-count mods `1K`/`2K`/`3K`/`10K`, `RD`, `DS`, `IN`, `CS`, `HO`, `NR`, `WU`, `WD` and `AS` are **unranked**; this project still models their mathematical effect (model coverage, not ranked coverage).
pub const RANKED_MANIA: &[&str] = &[
    "EZ", "NF", "HT", "DC", // difficulty reduction
    "SD", "PF", "DT", "NC", "FI", "HD", "CO", "FL", "AC", // difficulty increase
    "MR", "4K", "5K", "6K", "7K", "8K", "9K", // conversion (key-count mods ranked for 4K..9K)
    "MU", // fun
];

/// How a mod changes the judgement windows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WindowEffect {
    /// No effect on the windows.
    None,
    /// `HR`: `DifficultyMultiplier = 1.4`, i.e. the windows are divided by 1.4.
    HardRock,
    /// `EZ`: `DifficultyMultiplier = 1/1.4`, i.e. the windows are multiplied by 1.4.
    Easy,
    /// `DA`: does not scale the windows, it *overrides the OD* (the OD value is supplied by the caller through `windows::WindowOptions::da_od`).
    DifficultyAdjust,
    /// `CL`: switches to the stable-legacy window formulas (native and convert differ).
    Classic,
}

/// How a mod changes long notes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LnEffect {
    /// No effect.
    None,
    /// `HO` (Hold Off): holds are rewritten as plain notes, so the LN share drops to zero.
    HoldOff,
    /// `NR` (No Release): the tail of a hold no longer has to be released.
    NoRelease,
}

/// One row of the mod table: the facts about a mod taken from the game's source.
struct ModInfo {
    /// Acronym as it appears in mod strings (`"EZ"`, `"10K"`, ...).
    acronym: &'static str,
    /// Official flat PP multiplier (`1.0` = none). `NF`/`EZ`/`HR` are excluded from the product by [`mod_effects`] because they have their own mechanisms.
    pp_mult: f64,
    /// Judgement-window effect.
    window: WindowEffect,
    /// Multiplier applied to the map's HP drain rate.
    hp: f64,
    /// Rate multiplier (`None` = unchanged): `DT`/`NC` 1.5, `HT`/`DC` 0.75.
    rate: Option<f64>,
    /// Forced column count. Only has an effect on std -> mania converts; on native mania maps the key mods are a no-op (`ManiaKeyMod` returns early for the current ruleset).
    keys: Option<i32>,
    /// Long-note effect (`HO` rewrites holds as plain notes, `NR` removes the tail release).
    ///
    /// Kept for fidelity with the reference's mod table, but **not part of the frozen API**: the Rust `ModEffects` exposes neither `hold_off` nor `no_release`, so nothing consumes it here yet.
    #[allow(dead_code)]
    ln: LnEffect,
    /// Extra lives granted (EZ: 2 retries -> a life pool of 3).
    extra_lives: i32,
    /// Whether the mod is ScoreV2 (which skips the classic window branch).
    score_v2: bool,
}

/// The mod table. The order is the reference's `MODS` dict order and is significant: [`ModSet::parse`] looks acronyms up in this order among equal-length ones, exactly like Python's stable `sorted(MODS, key=len, reverse=True)`.
///
/// `rustfmt` is skipped so that the table keeps one mod per line, mirroring the reference's dict (it would otherwise expand to nine lines per row).
#[rustfmt::skip]
static MODS: &[ModInfo] = &[
    // ---- Difficulty reduction ----
    ModInfo { acronym: "EZ", pp_mult: 0.5, window: WindowEffect::Easy, hp: 0.5, rate: None, keys: None, ln: LnEffect::None, extra_lives: 2, score_v2: false },
    ModInfo { acronym: "NF", pp_mult: 0.5, window: WindowEffect::None, hp: 1.0, rate: None, keys: None, ln: LnEffect::None, extra_lives: 0, score_v2: false },
    ModInfo { acronym: "HT", pp_mult: 1.0, window: WindowEffect::None, hp: 1.0, rate: Some(0.75), keys: None, ln: LnEffect::None, extra_lives: 0, score_v2: false },
    ModInfo { acronym: "DC", pp_mult: 1.0, window: WindowEffect::None, hp: 1.0, rate: Some(0.75), keys: None, ln: LnEffect::None, extra_lives: 0, score_v2: false },
    ModInfo { acronym: "NR", pp_mult: 0.9, window: WindowEffect::None, hp: 1.0, rate: None, keys: None, ln: LnEffect::NoRelease, extra_lives: 0, score_v2: false },
    // ---- Difficulty increase ----
    ModInfo { acronym: "HR", pp_mult: 1.0, window: WindowEffect::HardRock, hp: 1.4, rate: None, keys: None, ln: LnEffect::None, extra_lives: 0, score_v2: false },
    ModInfo { acronym: "SD", pp_mult: 1.0, window: WindowEffect::None, hp: 1.0, rate: None, keys: None, ln: LnEffect::None, extra_lives: 0, score_v2: false },
    ModInfo { acronym: "PF", pp_mult: 1.0, window: WindowEffect::None, hp: 1.0, rate: None, keys: None, ln: LnEffect::None, extra_lives: 0, score_v2: false },
    ModInfo { acronym: "DT", pp_mult: 1.0, window: WindowEffect::None, hp: 1.0, rate: Some(1.5), keys: None, ln: LnEffect::None, extra_lives: 0, score_v2: false },
    ModInfo { acronym: "NC", pp_mult: 1.0, window: WindowEffect::None, hp: 1.0, rate: Some(1.5), keys: None, ln: LnEffect::None, extra_lives: 0, score_v2: false },
    ModInfo { acronym: "FI", pp_mult: 1.0, window: WindowEffect::None, hp: 1.0, rate: None, keys: None, ln: LnEffect::None, extra_lives: 0, score_v2: false },
    ModInfo { acronym: "HD", pp_mult: 1.0, window: WindowEffect::None, hp: 1.0, rate: None, keys: None, ln: LnEffect::None, extra_lives: 0, score_v2: false },
    ModInfo { acronym: "CO", pp_mult: 1.0, window: WindowEffect::None, hp: 1.0, rate: None, keys: None, ln: LnEffect::None, extra_lives: 0, score_v2: false },
    ModInfo { acronym: "FL", pp_mult: 1.0, window: WindowEffect::None, hp: 1.0, rate: None, keys: None, ln: LnEffect::None, extra_lives: 0, score_v2: false },
    ModInfo { acronym: "AC", pp_mult: 1.0, window: WindowEffect::None, hp: 1.0, rate: None, keys: None, ln: LnEffect::None, extra_lives: 0, score_v2: false },
    // ---- Conversion ----
    ModInfo { acronym: "RD", pp_mult: 1.0, window: WindowEffect::None, hp: 1.0, rate: None, keys: None, ln: LnEffect::None, extra_lives: 0, score_v2: false },
    ModInfo { acronym: "DS", pp_mult: 1.0, window: WindowEffect::None, hp: 1.0, rate: None, keys: None, ln: LnEffect::None, extra_lives: 0, score_v2: false },
    ModInfo { acronym: "MR", pp_mult: 1.0, window: WindowEffect::None, hp: 1.0, rate: None, keys: None, ln: LnEffect::None, extra_lives: 0, score_v2: false },
    ModInfo { acronym: "DA", pp_mult: 0.5, window: WindowEffect::DifficultyAdjust, hp: 1.0, rate: None, keys: None, ln: LnEffect::None, extra_lives: 0, score_v2: false },
    ModInfo { acronym: "CL", pp_mult: 0.96, window: WindowEffect::Classic, hp: 1.0, rate: None, keys: None, ln: LnEffect::None, extra_lives: 0, score_v2: false },
    ModInfo { acronym: "IN", pp_mult: 1.0, window: WindowEffect::None, hp: 1.0, rate: None, keys: None, ln: LnEffect::None, extra_lives: 0, score_v2: false },
    ModInfo { acronym: "CS", pp_mult: 0.9, window: WindowEffect::None, hp: 1.0, rate: None, keys: None, ln: LnEffect::None, extra_lives: 0, score_v2: false },
    ModInfo { acronym: "HO", pp_mult: 0.9, window: WindowEffect::None, hp: 1.0, rate: None, keys: None, ln: LnEffect::HoldOff, extra_lives: 0, score_v2: false },
    ModInfo { acronym: "1K", pp_mult: 0.9, window: WindowEffect::None, hp: 1.0, rate: None, keys: Some(1), ln: LnEffect::None, extra_lives: 0, score_v2: false },
    ModInfo { acronym: "2K", pp_mult: 0.9, window: WindowEffect::None, hp: 1.0, rate: None, keys: Some(2), ln: LnEffect::None, extra_lives: 0, score_v2: false },
    ModInfo { acronym: "3K", pp_mult: 0.9, window: WindowEffect::None, hp: 1.0, rate: None, keys: Some(3), ln: LnEffect::None, extra_lives: 0, score_v2: false },
    ModInfo { acronym: "4K", pp_mult: 0.9, window: WindowEffect::None, hp: 1.0, rate: None, keys: Some(4), ln: LnEffect::None, extra_lives: 0, score_v2: false },
    ModInfo { acronym: "5K", pp_mult: 0.9, window: WindowEffect::None, hp: 1.0, rate: None, keys: Some(5), ln: LnEffect::None, extra_lives: 0, score_v2: false },
    ModInfo { acronym: "6K", pp_mult: 0.9, window: WindowEffect::None, hp: 1.0, rate: None, keys: Some(6), ln: LnEffect::None, extra_lives: 0, score_v2: false },
    ModInfo { acronym: "7K", pp_mult: 0.9, window: WindowEffect::None, hp: 1.0, rate: None, keys: Some(7), ln: LnEffect::None, extra_lives: 0, score_v2: false },
    ModInfo { acronym: "8K", pp_mult: 0.9, window: WindowEffect::None, hp: 1.0, rate: None, keys: Some(8), ln: LnEffect::None, extra_lives: 0, score_v2: false },
    ModInfo { acronym: "9K", pp_mult: 0.9, window: WindowEffect::None, hp: 1.0, rate: None, keys: Some(9), ln: LnEffect::None, extra_lives: 0, score_v2: false },
    ModInfo { acronym: "10K", pp_mult: 0.9, window: WindowEffect::None, hp: 1.0, rate: None, keys: Some(10), ln: LnEffect::None, extra_lives: 0, score_v2: false },
    // ---- Automation ----
    ModInfo { acronym: "AT", pp_mult: 1.0, window: WindowEffect::None, hp: 1.0, rate: None, keys: None, ln: LnEffect::None, extra_lives: 0, score_v2: false },
    ModInfo { acronym: "CN", pp_mult: 1.0, window: WindowEffect::None, hp: 1.0, rate: None, keys: None, ln: LnEffect::None, extra_lives: 0, score_v2: false },
    // ---- Fun ----
    ModInfo { acronym: "WU", pp_mult: 0.5, window: WindowEffect::None, hp: 1.0, rate: None, keys: None, ln: LnEffect::None, extra_lives: 0, score_v2: false },
    ModInfo { acronym: "WD", pp_mult: 0.5, window: WindowEffect::None, hp: 1.0, rate: None, keys: None, ln: LnEffect::None, extra_lives: 0, score_v2: false },
    ModInfo { acronym: "MU", pp_mult: 1.0, window: WindowEffect::None, hp: 1.0, rate: None, keys: None, ln: LnEffect::None, extra_lives: 0, score_v2: false },
    ModInfo { acronym: "AS", pp_mult: 0.5, window: WindowEffect::None, hp: 1.0, rate: None, keys: None, ln: LnEffect::None, extra_lives: 0, score_v2: false },
    // ---- System ----
    ModInfo { acronym: "V2", pp_mult: 1.0, window: WindowEffect::None, hp: 1.0, rate: None, keys: None, ln: LnEffect::None, extra_lives: 0, score_v2: true },
];

/// `HR`'s window difficulty multiplier (`ManiaModHardRock.HIT_WINDOW_DIFFICULTY_MULTIPLIER`): the windows are divided by it.
const HR_WINDOW_MULTIPLIER: f64 = 1.4;
/// `EZ`'s window difficulty multiplier (`ManiaModEasy`): the windows are multiplied by 1.4.
const EZ_WINDOW_MULTIPLIER: f64 = 1.0 / 1.4;
/// `HR`'s HP drain-rate multiplier (`ModHardRock.ADJUST_RATIO`).
const HR_HP_MULTIPLIER: f64 = 1.4;
/// `EZ`'s HP drain-rate multiplier (`ModEasy.ADJUST_RATIO`).
const EZ_HP_MULTIPLIER: f64 = 0.5;

/// The mod table indexed by acronym.
fn mod_info(acronym: &str) -> Option<&'static ModInfo> {
    MODS.iter().find(|m| m.acronym == acronym)
}

/// Acronyms sorted by descending length, the lookup order of [`ModSet::parse`].
///
/// Python computes `sorted(MODS, key=len, reverse=True)` once at import time; the sort is stable, so equal-length acronyms keep the table order. Longest-first is what makes `"10K"` win over `"1K"` in an unseparated mod string.
fn parse_order() -> &'static [&'static ModInfo] {
    use std::sync::OnceLock;
    static ORDER: OnceLock<Vec<&'static ModInfo>> = OnceLock::new();
    ORDER.get_or_init(|| {
        let mut v: Vec<&'static ModInfo> = MODS.iter().collect();
        v.sort_by_key(|m| std::cmp::Reverse(m.acronym.len()));
        v
    })
}

/// A parsed mod set.
///
/// The acronym list is what [`ModSet::parse`] found, in the reference's lookup order (longest acronym first, table order for ties) — **not** the order in the input string. `ModSet::parse("7K+DT").acronyms == ["DT", "7K"]`, exactly like the Python reference.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ModSet {
    /// Acronyms found in the input, longest first.
    pub acronyms: Vec<String>,
}

impl ModSet {
    /// Parse a mod string into its acronyms.
    ///
    /// Matching is **substring based** (case-insensitive), because this project consumes two encodings: the osu! API writes `DT+MR`, the ppysb report writes `EZDTV2` with no separators at all. A token split would silently drop every mod of the second kind.
    ///
    /// The lookup order is longest acronym first so that `"10K"` is not matched as `"1K"`.
    pub fn parse(s: &str) -> Self {
        let upper = s.to_uppercase();
        let mut acronyms = Vec::new();
        for info in parse_order() {
            if upper.contains(info.acronym) {
                acronyms.push(info.acronym.to_string());
            }
        }
        ModSet { acronyms }
    }

    /// Whether the set contains a mod, by acronym (case-insensitive).
    ///
    /// The reference tests membership with `name.upper() in mods.upper()` on the raw string. For every acronym of the table this is equivalent to membership in the parsed list (a known acronym is found by parsing if and only if it occurs as a substring), which is why the parsed set is enough here.
    pub fn has(&self, acronym: &str) -> bool {
        let upper = acronym.to_uppercase();
        self.acronyms.contains(&upper)
    }

    /// Whether no mod was parsed (`"NM"`, `""` and unknown text all yield an empty set).
    pub fn is_empty(&self) -> bool {
        self.acronyms.is_empty()
    }

    /// Render the set as an osu!-style `+`-joined list (`"DT+MR"`).
    ///
    /// The order follows the lookup order of [`ModSet::parse`], so this does **not** round-trip the input spelling of an unseparated string; it round-trips the mod *set*.
    pub fn display(&self) -> String {
        self.acronyms.join("+")
    }
}

/// The aggregated effect of a mod set on the algorithm's inputs.
#[derive(Debug, Clone, PartialEq)]
pub struct ModEffects {
    /// Window difficulty multiplier as the game defines it: `HR` 1.4, `EZ` 1/1.4, else 1.0. The windows are `base * (speed / difficulty_multiplier)`; `DA` and `CL` do not appear here (see `crate::windows`).
    pub window_multiplier: f64,
    /// HP drain-rate multiplier (`EZ` 0.5, `HR` 1.4).
    pub hp_multiplier: f64,
    /// Extra lives (EZ's default 2 retries, i.e. a life pool of 3).
    pub extra_lives: i32,
    /// Rate multiplier (`DT`/`NC` 1.5, `HT`/`DC` 0.75, else 1.0).
    pub rate: f64,
    /// Column count forced by a key mod. Only meaningful for std -> mania converts.
    pub key_columns: Option<i32>,
    /// Product of the official flat PP multipliers, **excluding** `NF`/`EZ`/`HR`.
    pub flat_pp_mult: f64,
    /// `CL` (Classic): use the stable-legacy window formulas.
    pub classic: bool,
    /// `V2` (ScoreV2): skips the classic window branch.
    pub score_v2: bool,
    /// OD overridden by `DA`.
    ///
    /// The reference takes this from a function argument (`mod_effects(mods, da_od)`), not from the mod string; the frozen Rust signature has no such argument, so this mirrors the reference's default and stays `None`. The DA OD is threaded through `windows::WindowOptions::da_od` instead.
    pub da_od: Option<f64>,
}

/// Aggregate every mod of a set into its effects (the single entry point).
///
/// `NF`/`EZ`/`HR` are deliberately kept out of `flat_pp_mult`: `NF` goes through the failure risk model ([`nf_multiplier`]) and `EZ`/`HR` through the judgement windows.
pub fn mod_effects(m: &ModSet) -> ModEffects {
    let mut window_multiplier = 1.0;
    let mut hp_multiplier = 1.0;
    let mut extra_lives = 0;
    let mut rate = 1.0;
    let mut flat_pp_mult = 1.0;
    let mut key_columns: Option<i32> = None;
    let mut classic = false;
    let mut score_v2 = false;

    for acronym in &m.acronyms {
        // The reference skips acronyms it does not know; `parse` never produces any, but the acronym list is public, so a hand-built set must not panic either.
        let Some(info) = mod_info(acronym) else {
            continue;
        };
        match info.window {
            WindowEffect::HardRock => window_multiplier = HR_WINDOW_MULTIPLIER,
            WindowEffect::Easy => window_multiplier = EZ_WINDOW_MULTIPLIER,
            // `DA` carries no multiplier of its own: it overrides the OD (see the field doc).
            WindowEffect::DifficultyAdjust | WindowEffect::None => {}
            WindowEffect::Classic => classic = true,
        }
        hp_multiplier *= info.hp;
        extra_lives += info.extra_lives;
        if let Some(r) = info.rate {
            rate = r;
        }
        if let Some(k) = info.keys {
            key_columns = Some(k);
        }
        if info.score_v2 {
            score_v2 = true;
        }
        // NF/EZ/HR have their own mechanisms, so they must not enter the flat product.
        if !matches!(info.acronym, "NF" | "EZ" | "HR") {
            flat_pp_mult *= info.pp_mult;
        }
    }

    // HR and EZ are mutually exclusive in the game; when both are present the reference resolves the conflict in favour of HR and applies *both* HP multipliers.
    if m.has("HR") && m.has("EZ") {
        window_multiplier = HR_WINDOW_MULTIPLIER;
        hp_multiplier = EZ_HP_MULTIPLIER * HR_HP_MULTIPLIER;
    }

    ModEffects {
        window_multiplier,
        hp_multiplier,
        extra_lives,
        rate,
        key_columns,
        flat_pp_mult,
        classic,
        score_v2,
        da_od: None,
    }
}

/// Lowest HP drain rate of the game's health domain (0..10).
///
/// The spec export only carries the *tunable* upper clamp (`nf.hp_max`); the lower bound is a fact about the health domain.
const HP_MIN: f64 = 0.0;

/// Python's `min(hi, max(lo, v))` clamp.
///
/// Kept instead of `f64::clamp` because the two differ for NaN: Python's `max`/`min` never select a NaN *second* operand, so the reference's clamp collapses NaN to the lower bound, while `f64::clamp` propagates it. Rust's `f64::max`/`f64::min` ignore a NaN operand in the same way, so writing the clamp in the reference's order reproduces it exactly.
pub(crate) fn clamp_py(v: f64, lo: f64, hi: f64) -> f64 {
    hi.min(lo.max(v))
}

/// Effective HP drain rate: the map's HP, adjusted by `EZ` (x0.5) and `HR` (x1.4, capped).
pub fn effective_hp(hp: f64, m: &ModSet) -> f64 {
    let effects = mod_effects(m);
    clamp_py(hp * effects.hp_multiplier, HP_MIN, spec().nf.hp_max)
}

/// No-Fail multiplier coming from the HP curve alone (no score information).
///
/// The curve is the *risk-domain exponential* the research specification chose over a literal exponential decay: `g(x) = (e^(k*x) - 1) / (e^k - 1)` with `x = hp/10`, so the slope *grows* with HP (HP 8 and 9 are the knees where the risk of failing jumps) while the endpoints stay exact: HP 0 -> `nf.mult_max` (0.98, NF always keeps a small price) and HP 10 -> `nf.mult_min` (0.75, the official flat anchor).
///
/// Note the deliberate consequence of the exponential form: HP 9 is 0.8359 rather than the 0.855 of the piecewise anchors (the form cannot hit four anchors at once). The spec's `nf.curve` switches to the exact piecewise form if that is ever wanted.
pub fn nf_hp_multiplier(effective_hp: f64) -> f64 {
    let nf = &spec().nf;
    if nf.curve == "exp" {
        let x = clamp_py(effective_hp, HP_MIN, nf.hp_max) / nf.hp_max;
        let denom = nf.exp_k.exp() - 1.0;
        let g = ((nf.exp_k * x).exp() - 1.0) / denom;
        nf.mult_max - (nf.mult_max - nf.mult_min) * g
    } else {
        nf_piecewise(effective_hp, &nf.hp_points)
    }
}

/// Piecewise-linear HP anchors (the fallback curve: hits all four anchors exactly).
fn nf_piecewise(hp_eff: f64, points: &[[f64; 2]]) -> f64 {
    if points.is_empty() {
        return spec().nf.mult_min;
    }
    let first = points[0];
    let last = points[points.len() - 1];
    if hp_eff <= first[0] {
        return first[1];
    }
    if hp_eff >= last[0] {
        return last[1];
    }
    for pair in points.windows(2) {
        let (h0, v0) = (pair[0][0], pair[0][1]);
        let (h1, v1) = (pair[1][0], pair[1][1]);
        if h0 <= hp_eff && hp_eff <= h1 {
            let t = (hp_eff - h0) / (h1 - h0);
            return v0 + (v1 - v0) * t;
        }
    }
    last[1]
}

// Per-judgement health deltas of `ManiaHealthProcessor.GetHealthIncreaseFor` (positive = healing, negative = damage). Mania has no passive drain.
/// Damage of a missed plain note (relative to `HP + 1`).
const HEALTH_MISS_NOTE: f64 = 0.0075;
/// Damage of a missed hold head/tail — exactly half of a plain-note miss.
const HEALTH_MISS_LN: f64 = 0.00375;
/// Damage of a `50` (`Meh`).
const HEALTH_MEH: f64 = 0.0016;
/// `200` (`Good`): `base - hp * slope`.
const HEALTH_GOOD: (f64, f64) = (0.004, 0.0004);
/// `300` (`Great`): `base - hp * slope`.
const HEALTH_GREAT: (f64, f64) = (0.005, 0.0005);
/// `320` (`Perfect`): `base - hp * slope`.
const HEALTH_PERFECT: (f64, f64) = (0.0055, 0.0005);

/// Health change of a single judgement at the given **effective** HP (full health = 1.0).
///
/// `is_ln` selects the hold variant of a miss: a hold head/tail only costs half of what a plain note costs (`HEALTH_MISS_LN`). The parameter is the HP *after* [`effective_hp`] (`EZ` halves it, `HR` boosts and caps it) — the reference takes the same effective value.
pub fn health_delta(hp: f64, judgement: Judgement, is_ln: bool) -> f64 {
    match judgement {
        Judgement::Perfect => HEALTH_PERFECT.0 - hp * HEALTH_PERFECT.1,
        Judgement::Great => HEALTH_GREAT.0 - hp * HEALTH_GREAT.1,
        Judgement::Good => HEALTH_GOOD.0 - hp * HEALTH_GOOD.1,
        // `100` (`Ok`) is exactly neutral in mania.
        Judgement::Ok => 0.0,
        Judgement::Meh => -(hp + 1.0) * HEALTH_MEH,
        Judgement::Miss => {
            let per_note = if is_ln {
                HEALTH_MISS_LN
            } else {
                HEALTH_MISS_NOTE
            };
            -(hp + 1.0) * per_note
        }
    }
}

/// The score's net health consumption, in health units, at the given effective HP.
///
/// Mirrors the reference's `-health_delta(...) * total` *including its rounding*: the reference first averages the per-judgement deltas over the note count and then multiplies the average back by it, so the result can differ from the raw sum by a last-bit rounding. The miss blend is kept as written there: `ln_hold_share` attributes half of its share to the half-damage hold variant, `0.0075 * (1 - 0.5 * share) + 0.00375 * (0.5 * share)`.
fn consumed_health(hp: f64, counts: &Counts, ln_hold_share: f64) -> f64 {
    let total: f64 = counts.iter().map(|&c| f64::from(c)).sum();
    if total <= 0.0 {
        return 0.0;
    }
    let n320 = f64::from(counts[0]);
    let n300 = f64::from(counts[1]);
    let n200 = f64::from(counts[2]);
    let n100 = f64::from(counts[3]);
    let n50 = f64::from(counts[4]);
    let miss = f64::from(counts[5]);
    let p = hp;
    let d_miss = -(p + 1.0)
        * (HEALTH_MISS_NOTE * (1.0 - 0.5 * ln_hold_share) + HEALTH_MISS_LN * (0.5 * ln_hold_share));
    let d_meh = -(p + 1.0) * HEALTH_MEH;
    let d_good = HEALTH_GOOD.0 - p * HEALTH_GOOD.1;
    let d_great = HEALTH_GREAT.0 - p * HEALTH_GREAT.1;
    let d_perfect = HEALTH_PERFECT.0 - p * HEALTH_PERFECT.1;
    let average = (n320 * d_perfect
        + n300 * d_great
        + n200 * d_good
        + n100 * 0.0
        + n50 * d_meh
        + miss * d_miss)
        / total;
    -average * total
}

/// No-Fail PP multiplier of a score: HP curve times "did NF actually save this run?".
///
/// * no `NF` in the mod set -> `1.0` (the mechanism does not apply at all),
/// * `NF` with an unknown map HP -> the official flat `0.75` (the spec's `nf.mult_min`), so
///   missing HP data degrades to the official anchor instead of silently cancelling the penalty,
/// * otherwise the risk model below (`0.98 - (0.98 - f_hp) * risk`).
///
/// `hp` is the map's raw HP drain rate (not yet mod-adjusted); `ln_hold_share` is the share of the judgements that are hold heads/tails (see [`ln_hold_share_from_ratio`]).
pub fn nf_multiplier(m: &ModSet, hp: Option<f64>, counts: &Counts, ln_hold_share: f64) -> f64 {
    if !m.has("NF") {
        return 1.0;
    }
    match hp {
        None => spec().nf.mult_min,
        Some(hp) => nf_multiplier_for_hp(hp, m, counts, ln_hold_share),
    }
}

/// The risk model itself: `0.98 - (0.98 - f_hp) * risk`.
///
/// Not part of the frozen public API: the reference exposes it as `mods.nf_multiplier`, but its Rust counterpart takes `Option<f64>` for the HP and therefore has to carry the "no NF at all" / "HP unknown" handling of `pp_formula.nf_factor`. Keeping the private half separate keeps both behaviours in one place.
///
/// `risk` asks a threshold question rather than "how badly did you play": a No-Fail score is a *censored sample* — runs that would have failed only exist in the data because NF was on. So the penalty interpolates between "NF did nothing" (`risk = 0`, net healing over the whole run -> `mult_max`) and "NF saved you" (`risk >= 1`, the run is worth only the HP curve's price -> `f_hp`), with a smoothstep in between. The middle band is deliberately narrow (`nf.risk_r0`/`risk_r1`) so the model does not double-count the score accuracy curve.
///
/// The consumption is a **reconstruction**, not a measurement: score data carries no health telemetry, so it is simulated from the map HP, the judgement distribution and the per-judgement deltas, assuming judgements arrive at a uniform rate. Clustered misses would fail earlier, so the estimate is a lower bound on the risk.
fn nf_multiplier_for_hp(hp: f64, m: &ModSet, counts: &Counts, ln_hold_share: f64) -> f64 {
    let nf = &spec().nf;
    let hp_eff = effective_hp(hp, m);
    let f_hp = nf_hp_multiplier(hp_eff);

    let total: f64 = counts.iter().map(|&c| f64::from(c)).sum();
    if total <= 0.0 {
        return f_hp;
    }
    let consumed = consumed_health(hp_eff, counts, ln_hold_share);
    if consumed <= 0.0 {
        // Net healing over the whole run: NF never mattered here.
        return nf.mult_max;
    }
    let extra_lives = mod_effects(m).extra_lives.max(0);
    let life_pool = 1.0 + f64::from(extra_lives);
    let r = consumed / life_pool;
    let risk = if r >= nf.risk_r1 {
        1.0
    } else if r <= nf.risk_r0 {
        0.0
    } else {
        let u = (r - nf.risk_r0) / (nf.risk_r1 - nf.risk_r0);
        u * u * (3.0 - 2.0 * u)
    };
    let mult = nf.mult_max - (nf.mult_max - f_hp) * risk;
    clamp_py(mult, nf.mult_min, nf.mult_max)
}

/// Official flat PP multiplier of a mod set (without `NF`/`EZ`/`HR`).
pub fn flat_pp_multiplier(m: &ModSet) -> f64 {
    mod_effects(m).flat_pp_mult
}

/// sunny's `ln_ratio` (hold objects / total objects) -> share of *judgements* that are hold heads or tails.
///
/// A hold contributes two judgement slots (head and tail) and a circle one, so `share = 2H / (C + 2H) = 2 * ln_ratio / (1 + ln_ratio)`. The share only enters the No-Fail model, where a missed hold head/tail costs half of a plain-note miss.
///
/// The ratio is clamped to 1.0 first (a ratio above 1 is not representable as holds/notes, but a caller may pass one) and a non-positive ratio yields 0.0.
pub fn ln_hold_share_from_ratio(ln_ratio: f64) -> f64 {
    if !(ln_ratio > 0.0) {
        return 0.0;
    }
    let r = ln_ratio.min(1.0);
    2.0 * r / (1.0 + r)
}
