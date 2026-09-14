# The four algorithms

This repository compares four mania PP algorithms on identical inputs. This page records what each one is called, where it comes from, what it computes, and which parts are ours.

| id | name | what it is |
|---|---|---|
| `bancho` | **Bancho** | the official osu! pp, as osu!lazer computes it |
| `sunny` | **Sunny** | the community algorithm by [Crz]sunnyxxy (repository: *Star-Rating-Rebirth*), pattern and accuracy part |
| `codexxy` | **Codexxy** | the same community algorithm plus a map-based timing surface |
| `reimagined` | **Reimagined** | this project's three-channel R / L / A algorithm |

## 1. Bancho — official osu! pp

The pp values osu! itself awards, implemented in osu!lazer's mania ruleset and ported to Rust upstream. It is a single fused difficulty number — a star rating produced by one strain skill — mapped to PP with a power curve, an accuracy term and a length bonus, then multiplied by fixed mod multipliers, and for rate-changing mods the star rating itself is recomputed at the new clock rate.

Two properties are worth remembering whenever its numbers are compared with the other three. First, mania's official star rating does not depend on OD, HP, column count or long notes at all — HR, EZ and Difficulty Adjust leave it untouched, because they only change hit windows and drain rate, and the difficulty calculator that computes it does not read either. Second, the accuracy term is a plain function of the 320-weighted accuracy, so a score's judgement distribution beyond accuracy does not matter.

**Where it comes from, and why that matters.** The pinned fork this repository uses for Sunny and Codexxy does **not** compute the official star rating: its `mania::difficulty` fills `ManiaDifficultyAttributes.stars` from the Community Sunny ("rebirth") parameters, so those attributes fed through the official pp formula would price *Sunny stars on the official curve* and label the column Bancho — which yields a column that tracks Sunny to within a few hundredths of a star on every map instead of the real thing. The Bancho column is therefore computed from the **untouched upstream `rosu-pp`** at the revision the fork is based on, as a second dependency of this workspace. Verified against osu!'s own numbers: across 19,789 un-modded scores the official star rating matches the API's `difficulty_rating` to a median absolute difference of 0.0002 (maximum 0.0005, 100% within 0.02), while the Sunny star differs from it by a median of 0.14.

**Score generation.** osu! keeps two score generations and prices each with its own judgement semantics: the pp of a lazer `solo_score` and of a legacy `score_best_*` entry differ by 3% to 20% on identical judgement counts. The engine takes that from the fixture's `lazer` column and hands it to the performance calculator; with the matching setting the computed pp agrees with the pp osu! reports to within 1% on every sampled score of both generations, while the wrong setting is off on most of them. A fixture that does not carry the column is treated as lazer.

* Source: the upstream [`rosu-pp`](https://github.com/MaxOhn/rosu-pp) v4.0.1 — **not** the pinned fork, for the reason above — plus the same crate through the fork for the other three columns.
* Implementation reference: [`reference-csharp-sources.md`](reference-csharp-sources.md), part A (formulas, constants, and the off-by-one and rounding traps of the C# original).

## 2. Sunny — the community algorithm

Sunny replaces the official difficulty model with one built around per-object difficulty, long-note structure and a window-derived parameter, and prices PP as

```
PP = 9.8 · max(star − 0.15, 0.05)^2.2 · variety · length · accuracy terms
```

The difficulty is fused from per-column and cross-column components with smoothing and percentile aggregation, and the window parameter `x` comes from the map's own hit windows, so the map's OD and any mod that changes windows do reach the star rating — unlike Bancho.

In this engine **Sunny is the pattern and accuracy part only**: the `xxy_pp_pattern + xxy_pp_accuracy` components of the upstream calculation. That is the honest boundary, because the calculation available in the pinned fork is already integrated with Codexxy's timing model; reporting the components separately is what makes the two columns meaningfully different.

* Source: `mania::sunny` in the pinned fork.
* **A caveat to carry when reading this column**: the fork's `compute_rbar` multiplies each per-object term by a release-collision factor, `(1 + 0.25 · 0.5 · (c_i + c_{i+1}))`, which the C# reference implementation of the algorithm does not contain — the branch documents it as a deliberate, unfitted extension, its reasoning being that fully-colliding releases are common while the original rhythm term under-prices them. The research side of this project uses a JavaScript port that matches the C# reference line for line, so the two sides read the same maps slightly differently: on four-key long-note maps the engine's Sunny star sits a median **+0.42%** above the research side's (pp **+0.34%**), and on pure rice maps the difference is exactly zero, because the factor multiplies a term that is already zero there. That is a modelling difference between two implementations of one algorithm, not a defect on either side: the parity audit in the research repository pins it to that single line, and this repository keeps the pinned revision rather than forking a third-party model decision.

## 3. Codexxy — Sunny plus a timing surface

Codexxy keeps Sunny's pattern term and adds a forward model of *timing* difficulty: per-object expected judgement loss from a fitted error distribution, a map-level timing factor derived during the difficulty pass, and a score-conditioned adjustment clamped to `[0.75, 1.15]`.

The name is the author's; what it adds is a **map-based timing surface** — hence this project's older documents (and the research repository) calling it "surface". If you are looking for where that idea entered this project: the accuracy engine in the research reference was ported from the same code, and the diagnostics it produces are still used there.

* Source: the `pp_timing` component of the same upstream calculation as Sunny.
* Because Sunny and Codexxy share one calculation, their difference on a score isolates the timing model and nothing else.

## 4. Reimagined — this project's three-channel algorithm

Our own algorithm, ported here from a Python research reference. Instead of fusing every difficulty signal into one number, it keeps three operationally distinct channels apart and fuses them at pricing time:

```
R = sunny star rating of the map with every hold rewritten as a tap ("rice")
L = sunny star rating of the full map − R                     what holding notes adds

w         = w_m3_keys(keys) · coord_transfer_mod(rel_gap_cross, keys)
eff_star  = (R_SCALE · R + w · L) · (1 + star_key_boost(keys))
PP        = sunny_rebirth_pp(eff_star, variety, acc_scalar, notes, counts, mods, hp, ln_share)
            · nf_factor(mods, hp, counts, ln_share)
            · accuracy_factor(perfect_window, keys, w_ref, mean_chord)
```

Each mechanism below is a tunable in `spec/spec.json`, exported from the research side:

| Mechanism | What it does |
|---|---|
| LN weight anchors | Feeling-anchored coordination weight per key count (4K 0.95, 5K/6K 1.00, 7K 1.15), interpolated between anchors and gently extrapolated outside them; below 1K the weight tends to zero because a single column has no cross-column coordination |
| Star key boost | Flat star lift from 7K upward: cross-column coordination keeps growing while the hand layout stops changing |
| Cross-column transfer modulation | Makes the coordination weight follow how fast a player must release one column and press another; Sunny's own model only ever looks at the *same* column |
| Accuracy factor | Window-derived multiplier `(w / w_ref)^−γ · chord_boost`, where `w_ref` is the *same map without mods*, so that the map's own OD is not priced twice (Sunny already contains it) |
| No-Fail factor | Failure-risk model: effective HP (EZ halves it, HR boosts it and caps at 10), per-judgement health deltas, a life pool including EZ's extra lives, and a risk-domain exponential curve over the reconstructed net drain |
| Chord coupling | Simultaneous-press structure enters the timing sigma (diagnostics) and, weakly, accuracy pricing |
| Channel volumes | `R_SCALE` and `ACC_WEIGHT` set how loud the R and A channels are relative to L |

Full formulas, constants and their calibration history live in the research repository (`docs/algorithm.md`, `docs/user-decisions.md`); the engine consumes only the exported constants.

### How R is measured, not estimated

`R` is the difficulty of the same object set with holding removed, so it has to be measured on a transformed map rather than derived. The engine rewrites every hold line in the raw `.osu` text so that the object becomes a tap at its head time — clearing the hold bit **and setting the circle bit** — and then runs the same upstream calculator on the result. Two guards keep this honest: the transform preserves the object count exactly, and `prepare()` verifies that the rice map contains as many objects as the original. Both exist because an earlier version cleared the hold bit without setting the circle bit, which makes the decoder reject the line entirely: the "rice" map then silently lost every hold instead of turning it into a tap, and R was measured on a map that no longer contained those objects.

## How the four are wired together

All four live in `crates/mania-pp-algorithms`, one directory each, and share a single preparation step: for a `(map, mods)` pair the engine parses the map once, derives the rice variant once, and runs each upstream calculation once. Scores are then priced off that shared state, and Sunny and Codexxy are two readings of the same performance pass rather than two computations.

That is also what keeps the comparison fair:

1. one parse per map and one mods representation per score — every algorithm sees the same input;
2. Sunny and Codexxy come from a **single** upstream calculation of the same map, so their difference is only the timing surface;
3. Reimagined consumes the same Sunny attributes (stars, variety, accuracy scalar, object counts) that Sunny is built from, so the comparison isolates *pricing* differences rather than a different difficulty front-end;
4. the rate-changing mods are resolved once by this project (`DT`/`NC` ×1.5, `HT`/`DC` ×0.75) instead of relying on the dependency's helper, which does not know Daycore and would silently treat it as a neutral mod.

## Provenance table

| id | whose difficulty model | whose pricing | whose mods/windows | whose score handling |
|---|---|---|---|---|
| `bancho` | official (lazer) | official | official | official |
| `sunny` | community (sunnyxxy) | community | Sunny + lazer windows | Sunny |
| `codexxy` | community + map-based timing | Codexxy | Codexxy + lazer windows | Codexxy |
| `reimagined` | community (sunnyxxy) | ours | ours | ours |
