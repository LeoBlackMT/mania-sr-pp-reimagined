# The four algorithms

This repository compares four mania PP algorithms on identical inputs. This page records where each
one comes from, what it actually computes, and which parts of it are ours.

## 1. `bancho` — official osu! pp

The pp values osu! itself awards, as implemented in osu!lazer's mania ruleset and ported to Rust by
`rosu-pp`. It is a single fused difficulty number (star rating) mapped to PP with accuracy and
length terms; mods enter through fixed multipliers and through the star rating for rate-changing mods.

* Source: `rosu-pp` (maintained port of `ppy/osu`), consumed through the pinned fork dependency.
* Implementation reference: [`reference-csharp-sources.md`](reference-csharp-sources.md) (part A).
* Role in the comparison: the baseline everybody knows, not a target we tune against.

## 2. `sunny` — community Star-Rating-Rebirth (pattern + accuracy part)

sunny replaces the official difficulty model with one built around per-object difficulty, long-note
structure and a window-derived parameter, and prices PP as
`9.8 · max(star − 0.15, 0.05)^2.2 · variety · length · accuracy terms`.

In the engine, `sunny` is the **pattern and accuracy part only**, i.e. the `xxy_pp_pattern +
xxy_pp_accuracy` components of the fork's calculation. That is the honest boundary: it is exactly the
part that exists in the original community algorithm, before surface's timing model is layered on.

* Source: `mania::sunny` in the pinned fork (`sunny.rs`).
* Implementation reference: [`reference-csharp-sources.md`](reference-csharp-sources.md) (part B).

## 3. `surface` — sunny plus the map-based timing surface

surface keeps sunny's pattern term and adds a forward timing model: per-object expected judgement
loss from a fitted error distribution, a map-level timing factor, and a score-conditioned
adjustment clamped to `[0.75, 1.15]`. In the engine, `surface` is the fork's final pp for the same
calculation, i.e. `sunny` plus the `pp_timing` component.

* Source: `mania::sunny::{calculate, calculate_performance}` in the pinned fork.
* Because `sunny` and `surface` share one calculation, their difference isolates the timing model.

## 4. `reimagined` — this project's three-channel algorithm (R / L / A)

Our own algorithm, ported here from the Python research reference. Instead of fusing everything into
one difficulty number, it splits mania play into three channels and fuses them at pricing time:

```text
R = sunny star rating of the map with every hold rewritten as a plain note ("rice")
L = sunny star rating of the full map - R                      (what holding notes adds)

w        = w_m3_keys(keys) * coord_transfer_mod(gap_cross, keys)
eff_star = (R_SCALE * R + w * L) * (1 + star_key_boost(keys))
PP       = sunny_rebirth_pp(eff_star, variety, acc_scalar, notes, counts, mods, hp, ln_share)
           * nf_factor(mods, hp, counts, ln_share)
           * accuracy_factor(perfect_window, keys, w_ref, mean_chord)
```

with the following mechanisms, all of them user-facing knobs exported in `spec/spec.json`:

| Mechanism | What it does |
|---|---|
| LN weight anchors | Feeling-anchored coordination weight per key count (4K 0.95, 5K/6K 1.00, 7K 1.15), linearly interpolated between anchors, gently extrapolated outside them |
| Star key boost | Flat star lift from 7K upward (cross-column coordination keeps growing while hand layout stops changing) |
| Cross-column transfer modulation | Makes the coordination weight follow how fast a player must release one column and press another; sunny's own model only ever looks at the *same* column |
| Accuracy factor | Window-derived multiplier `(w/w_ref)^-gamma * chord_boost`, where `w_ref` is the *same map without mods* so that map OD is not priced twice |
| No-Fail factor | Failure-risk model: effective HP (EZ halves, HR boosts and caps), per-judgement health deltas, life pool with EZ's extra lives, risk-domain exponential curve |
| Chord coupling | Simultaneous-press structure enters both the timing sigma (diagnostics) and, weakly, accuracy pricing |
| Channel volumes | `R_SCALE` and `ACC_WEIGHT` scale how loud the R and A channels are relative to L |

Full formulas, constants and their calibration history live in the research repository
(`docs/algorithm.md`, `docs/user-decisions.md`). The engine only consumes the exported constants.

### The three channels in the output

For every score the CLI reports the channel contributions that make the number explicable
(`pp_R`, `pp_L`, `pp_A` in the research reports), plus the intermediate quantities (`stars_rice`,
`stars_full`, `w`, `acc_factor`, `nf_factor`). Diagnostics that do not affect pricing — the expected
timing loss model — are opt-in, so the default path stays fast and dependency-free.

## How the four are wired together

All four live in `crates/mania-pp-algorithms`, one module each, and share a single preparation step:
for a `(map, mods)` pair the engine parses the map once, derives the rice variant once, and runs each
upstream calculation once. Scores are then priced off that shared state.

That is also what keeps the comparison fair:

1. one parse per map and one mods representation per score — every algorithm sees the same input;
2. `sunny` and `surface` come from a **single** upstream calculation of the same map, so their
   difference is only the timing surface;
3. `reimagined` consumes the same sunny attributes (stars, variety, accuracy scalar, object counts)
   that `sunny` is built from, so the comparison isolates *pricing* differences rather than a
   different difficulty front-end;
4. the rate-changing mods are resolved once by this project (`DT`/`NC` = 1.5x, `HT`/`DC` = 0.75x)
   instead of relying on the dependency's helper, which does not know `DC` (Daycore) and would
   silently treat it as a neutral mod.

## Provenance table

| id | whose difficulty model | whose pricing | whose mods/windows | whose score handling |
|---|---|---|---|---|
| `bancho` | official (lazer) | official | official | official |
| `sunny` | community (SRR) | community | SRR + lazer windows | SRR |
| `surface` | community + surface timing | surface | surface + lazer windows | surface |
| `reimagined` | community (SRR) | ours | ours | ours |
