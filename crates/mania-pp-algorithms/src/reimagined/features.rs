//! Structural features of a map: chord (simultaneous press) statistics, column-aware coordination features, the map shape profile and the two key-type quantities the pricing axes read.
//!
//! Ported from `pp_formula.chord_stats` and `coord_features.{column_of, compute_column_features, map_shape_profile, compute_rice_column_features}`. Most of them are **diagnostic**: they explain a price rather than enter it. Two are not: [`wall_frac`] and [`rice_cut_fraction`] feed the key-type axes of [`crate::reimagined::keys`], and the chord statistics feed the key-count coupling of the accuracy channel through the typical chord of a key count.
//!
//! # Column semantics
//!
//! The column of an object is lazer's `ColumnWidth = 512 / keys` layout: `column = clamp(floor(x * keys / 512), 0, keys - 1)`. The key count must be supplied by the caller (resolved with [`crate::reimagined::keys::effective_keys`]) — a std convert's `CircleSize` is a radius, not a column count.
//!
//! # Rounding
//!
//! The reference rounds its diagnostic outputs with Python's `round(x, n)`, which is decimal rounding of the *exact* binary value with ties to even. `(x * 10^n).round() / 10^n` is **not** equivalent (it rounds ties away from zero and drifts), so [`round_dec`] reproduces the reference through the correctly-rounded decimal formatting of Rust.

use std::collections::BTreeMap;

use mania_pp_spec::spec;

use crate::reimagined::notes::Note;

/// Fraction of the difficulty p90 above which a point counts as "plateau" (the map never lets go: an endurance shape).
///
/// Not exported by the specification: it is a *diagnostic* threshold of the shape profile, like the rest/wall definitions below, and it never reaches the price.
const PLATEAU_FRAC: f64 = 0.85;
/// Fraction of the difficulty p90 below which a point counts as "rest".
const REST_FRAC: f64 = 0.30;
/// A cross-column press gap at or below this many milliseconds counts as a fast hand transfer.
///
/// The key-type C axis reads the fraction of such gaps; see [`rice_cut_fraction`].
pub const FAST_CROSS_MS: f64 = 100.0;

/// Python's `round(x, digits)` for floats.
///
/// Rust's `format!` performs a correctly-rounded decimal conversion with ties to even, which is exactly what Python's round does on the exact binary value; parsing the text back gives the same double. This matters for quantities like `1/16` where a naive `(x * 1000).round() / 1000` would round the tie the other way.
fn round_dec(x: f64, digits: usize) -> f64 {
    if !x.is_finite() {
        return x;
    }
    format!("{x:.digits$}").parse::<f64>().unwrap_or(x)
}

/// Upper median (`sorted(xs)[len // 2]`), the median convention of the research repository (`stats.median`), which differs from averaging the two middle values. NaN for empty input.
fn median(xs: &[f64]) -> f64 {
    if xs.is_empty() {
        return f64::NAN;
    }
    let mut s = xs.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    s[s.len() / 2]
}

/// The reference's local `_med` of the column features: upper median, but **0.0** when the list is empty (the profile's own median returns NaN instead — the two differ on purpose).
fn median_or_zero(xs: &[f64]) -> f64 {
    if xs.is_empty() {
        0.0
    } else {
        median(xs)
    }
}

/// Column index of an object's `x` position, clamped to `0 .. keys - 1`.
///
/// A non-positive key count yields column 0 (the reference's guard); negative `x` truncates towards zero before clamping, exactly like Python's `int()`.
pub fn column_of(x: f64, keys: i32) -> i32 {
    if keys <= 0 {
        return 0;
    }
    let c = (x * f64::from(keys) / 512.0) as i32;
    c.clamp(0, keys - 1)
}

/// Chord (simultaneous press) structure of a map.
#[derive(Debug, Clone, PartialEq)]
pub struct ChordStats {
    /// Number of press events (chord clusters) — the denominator of [`Self::mean_chord`].
    pub events: usize,
    /// Total number of notes (objects).
    pub notes: usize,
    /// Mean simultaneous press count = `notes / events`.
    ///
    /// The denominator is **events, not notes**: a four-key chord is one event of size 4. This is the convention the typical-chord calibration (`chord.reference` = 1.471 for 4K) was measured with; changing the denominator invalidates it.
    pub mean_chord: f64,
    /// 95th percentile of the per-event sizes.
    pub p95_chord: usize,
    /// Largest per-event size.
    pub max_chord: usize,
    /// Share of *notes* that belong to an event of size >= 2.
    pub multi_frac: f64,
    /// Share of *events* with size >= 2.
    pub chord_events_frac: f64,
}

/// Column-aware coordination features (all of them averaged/median-ed over the holds).
#[derive(Debug, Clone, PartialEq)]
pub struct ColumnFeatures {
    /// Key count the columns were computed with.
    pub keys: i32,
    /// Number of holds in the map.
    pub n_holds: usize,
    /// Presses in **other columns** while a hold is sustained, per second (mean over holds): how much the remaining fingers have to do while one is held down.
    pub c_hold_busy: f64,
    /// Share of holds during which a press happens in the **same column** (a physical conflict: the finger must release before it can press again).
    pub c_same_col_conflict: f64,
    /// Median gap from a hold's release to the next press in a **different column** (ms): the cross-column transfer speed, which sunny's own model cannot see.
    pub c_rel_gap_cross: f64,
    /// Median hold duration (ms): how long a finger stays occupied.
    ///
    /// The reference's docstring once said "mean"; the implementation is a **median**, and the port follows the implementation.
    pub c_hold_col_span: f64,
}

/// Shape profile of a map: its key-pattern form compressed into comparable scalars.
#[derive(Debug, Clone, PartialEq)]
pub struct ShapeProfile {
    /// Map duration in seconds (the last object's end, rounded half to even).
    pub dur_s: f64,
    /// Median per-note difficulty.
    pub d_med: f64,
    /// 90th percentile of the per-note difficulty.
    pub d_p90: f64,
    /// Share of points with `D >= 0.85 * D_p90` -> 1.0 means no breathing room anywhere.
    pub plateau: f64,
    /// Share of points with `D <= 0.30 * D_p90` -> high means explicit rests.
    pub rest: f64,
    /// Share of seconds in which at least half of the columns are occupied by a hold -> 1.0 is a full long-note wall.
    pub wall: f64,
    /// 90th percentile of the object density per second.
    pub dens_p90: i32,
}

/// Chord statistics of a note list (`None` for an empty list).
///
/// Objects are clustered by **start time** with an anchor rule: a member must be within `chord.simultaneity_ms` of the cluster's **first** object, not of the previous one — otherwise an evenly spaced stream at 0.9 ms would collapse into a single "chord" of hundreds of notes.
pub fn chord_stats(notes: &[Note]) -> Option<ChordStats> {
    if notes.is_empty() {
        return None;
    }
    let simultaneity = spec().chord.simultaneity_ms;
    let mut ordered: Vec<&Note> = notes.iter().collect();
    ordered.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));

    let mut sizes: Vec<usize> = Vec::new();
    let mut anchor = ordered[0].t;
    let mut current = 1usize;
    for n in &ordered[1..] {
        if n.t - anchor <= simultaneity {
            current += 1;
        } else {
            sizes.push(current);
            anchor = n.t;
            current = 1;
        }
    }
    sizes.push(current);

    let total: usize = sizes.iter().sum();
    if total == 0 {
        return None;
    }
    let big: usize = sizes.iter().filter(|&&s| s >= 2).sum();
    let mut sorted = sizes.clone();
    sorted.sort_unstable();
    let p95_index = ((0.95 * sorted.len() as f64) as usize).min(sorted.len() - 1);
    Some(ChordStats {
        events: sizes.len(),
        notes: total,
        mean_chord: total as f64 / sizes.len() as f64,
        p95_chord: sorted[p95_index],
        max_chord: sorted[sorted.len() - 1],
        multi_frac: big as f64 / total as f64,
        chord_events_frac: sizes.iter().filter(|&&s| s >= 2).count() as f64 / sizes.len() as f64,
    })
}

/// Column-aware coordination features (`None` without notes, without holds, or without a valid key count — a pure rice map has no coordination content to describe).
///
/// Presses are circles and hold **heads** (a hold tail is a release, not a press).
pub fn compute_column_features(notes: &[Note], keys: i32) -> Option<ColumnFeatures> {
    if notes.is_empty() || keys <= 0 {
        return None;
    }
    let holds: Vec<&Note> = notes.iter().filter(|n| n.is_hold).collect();
    if holds.is_empty() {
        return None;
    }

    // Press events: circles plus hold heads, sorted by (time, column) like the reference's `list.sort()` on `(t, column)` tuples (the tie order is observable in the "next press in another column" scan below).
    let mut presses: Vec<(f64, i32)> = notes
        .iter()
        .filter(|n| !n.is_hold)
        .map(|n| (n.t, column_of(n.x, keys)))
        .collect();
    presses.extend(holds.iter().map(|n| (n.t, column_of(n.x, keys))));
    presses.sort_by(|a, b| {
        a.0.partial_cmp(&b.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.1.cmp(&b.1))
    });

    let times_all: Vec<f64> = presses.iter().map(|(t, _)| *t).collect();
    let mut by_col: BTreeMap<i32, Vec<f64>> = BTreeMap::new();
    for (t, c) in &presses {
        by_col.entry(*c).or_default().push(*t);
    }

    let eps = 1e-6;
    let mut busy_list: Vec<f64> = Vec::new();
    let mut conflicts = 0usize;
    let mut gaps_cross: Vec<f64> = Vec::new();
    let mut spans: Vec<f64> = Vec::new();

    for h in &holds {
        let col = column_of(h.x, keys);
        let span = (h.end - h.t).max(0.0);
        spans.push(span);

        // Presses strictly inside (t, end]: merged count minus the same-column count, both excluding the hold's own head.
        let lo = times_all.partition_point(|&t| t <= h.t + eps);
        let hi = times_all.partition_point(|&t| t <= h.end + eps);
        let total_in = hi - lo;
        let col_times: &[f64] = by_col.get(&col).map(|v| v.as_slice()).unwrap_or(&[]);
        let lo_c = col_times.partition_point(|&t| t <= h.t + eps);
        let hi_c = col_times.partition_point(|&t| t <= h.end + eps);
        let same_in = hi_c - lo_c;
        let other = total_in.saturating_sub(same_in);
        if span > 0.0 {
            busy_list.push(other as f64 / (span / 1000.0));
        }
        if same_in > 0 {
            conflicts += 1;
        }

        // Release -> first press in a different column.
        let mut j = times_all.partition_point(|&t| t <= h.end + eps);
        while j < presses.len() {
            let (tj, cj) = presses[j];
            if cj != col {
                gaps_cross.push(tj - h.end);
                break;
            }
            j += 1;
        }
    }

    let n_holds = holds.len();
    Some(ColumnFeatures {
        keys,
        n_holds,
        c_hold_busy: if busy_list.is_empty() {
            0.0
        } else {
            round_dec(busy_list.iter().sum::<f64>() / busy_list.len() as f64, 3)
        },
        c_same_col_conflict: round_dec(conflicts as f64 / n_holds as f64, 4),
        c_rel_gap_cross: round_dec(median_or_zero(&gaps_cross), 2),
        c_hold_col_span: round_dec(median_or_zero(&spans), 2),
    })
}

/// Shape profile of a map (`None` without notes, without positive difficulty values, or without a valid key count).
///
/// * `d_values` are the per-note difficulty values of the map's difficulty graph (the NM
///   variant); non-positive and NaN entries are dropped, like the reference's `x > 0` filter.
/// * `wall` is counted per second: a second counts as walled when at least half of the
///   columns are occupied by a hold during it (`bin(o).count("1") >= ceil(keys / 2)`).
/// * The occupancy bitmask is a `u32`, so `keys` above 32 is outside the domain (the game
///   supports up to 18 columns); such columns contribute no bit.
pub fn map_shape_profile(notes: &[Note], keys: i32, d_values: &[f64]) -> Option<ShapeProfile> {
    if notes.is_empty() || keys <= 0 {
        return None;
    }
    let vals: Vec<f64> = d_values.iter().copied().filter(|x| *x > 0.0).collect();
    if vals.is_empty() {
        return None;
    }
    let last_ms = notes
        .iter()
        .map(|n| n.end)
        .fold(f64::NEG_INFINITY, f64::max);
    let dur_bins = (last_ms / 1000.0) as i64 + 1;
    if dur_bins <= 0 {
        return None;
    }
    let n_bins = dur_bins as usize;

    let mut sorted_vals = vals.clone();
    sorted_vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let p90 = sorted_vals[((0.90 * sorted_vals.len() as f64) as usize).min(sorted_vals.len() - 1)];

    // Long-note wall: delegated so "wall" has exactly one definition (see [`wall_frac`]).
    // The guards above already returned `None` for every case that would make it `None` here.
    let wall = wall_frac(notes, keys)?;

    // Object density per second.
    let mut density = vec![0i32; n_bins];
    for n in notes {
        let b = (n.t / 1000.0).floor() as i64;
        if let Some(slot) = density.get_mut(b as usize) {
            *slot += 1;
        }
    }
    let mut sorted_density = density.clone();
    sorted_density.sort_unstable();
    let dens_p90 = sorted_density[((0.90 * n_bins as f64) as usize).min(n_bins - 1)];

    let plateau =
        vals.iter().filter(|x| **x >= PLATEAU_FRAC * p90).count() as f64 / vals.len() as f64;
    let rest = vals.iter().filter(|x| **x <= REST_FRAC * p90).count() as f64 / vals.len() as f64;

    Some(ShapeProfile {
        dur_s: (last_ms / 1000.0).round_ties_even(),
        d_med: round_dec(median(&vals), 2),
        d_p90: round_dec(p90, 2),
        plateau: round_dec(plateau, 3),
        rest: round_dec(rest, 3),
        wall,
        dens_p90,
    })
}

/// Long-note wall fraction: the share of seconds during which at least half of the columns are held.
///
/// The key-type A axis (`wall_cut_mod`) compresses the coordination channel by this quantity, because the research scan found the L channel's markup concentrated on walled maps (residual against `wall` +0.78).
///
/// This exists separately from [`map_shape_profile`] on purpose: the profile needs the per-note difficulty values and returns `None` without them, while the wall fraction is a pure property of the holds. Deriving it here — and having the profile call *this* — keeps one definition of "wall" instead of two that could drift apart.
///
/// `None` for an empty note list, a non-positive key count, or a duration that yields no bins (the reference's own guards).
pub fn wall_frac(notes: &[Note], keys: i32) -> Option<f64> {
    if notes.is_empty() || keys <= 0 {
        return None;
    }
    let last_ms = notes
        .iter()
        .map(|n| n.end)
        .fold(f64::NEG_INFINITY, f64::max);
    let dur_bins = (last_ms / 1000.0) as i64 + 1;
    if dur_bins <= 0 {
        return None;
    }
    let n_bins = dur_bins as usize;

    // Which columns a hold occupies, per second.
    let mut occupied = vec![0u32; n_bins];
    for n in notes {
        if !n.is_hold {
            continue;
        }
        let bit = 1u32.checked_shl(column_of(n.x, keys) as u32).unwrap_or(0);
        let from = (n.t / 1000.0).floor() as i64;
        let to = ((n.end / 1000.0).floor() as i64 + 1).min(dur_bins);
        for b in from..to {
            // The reference wraps negative indices around the list (Python semantics); a negative timestamp cannot occur in a valid `.osu`, so such bins are skipped.
            if let Some(slot) = occupied.get_mut(b as usize) {
                *slot |= bit;
            }
        }
    }
    let half = keys / 2 + (keys & 1);
    let walled = occupied
        .iter()
        .filter(|o| o.count_ones() as i32 >= half)
        .count();
    Some(round_dec(walled as f64 / n_bins as f64, 3))
}

/// Rice-side split fraction: the share of adjacent cross-column press gaps at or below [`FAST_CROSS_MS`].
///
/// Ported from `coord_features.compute_rice_column_features(...)["R_frac_cross_fast"]`. The key-type C axis (`rice_cut_mod`) reads it to compress rice-cutting maps **without** using density — density cannot tell a rice cut from a stack, because both are dense; the research measurement showed the density proxy misfiling maps in both directions (10 of 12 "rice cuts" were stacks, and 7 real cuts were missed).
///
/// "Rice side" means holds are treated as taps, matching the R channel (`sr_rice`): every object contributes one press, and a press is one *event* per column per timestamp. Adjacent events separated by a different column give a transfer gap; a gap counts as fast when it is positive and at most [`FAST_CROSS_MS`].
///
/// `None` for an empty note list, a non-positive key count, or when no cross-column pair exists (the reference returns 0.0 there; `None` keeps "no information" distinct from "measured, and it is zero").
pub fn rice_cut_fraction(notes: &[Note], keys: i32) -> Option<f64> {
    if notes.is_empty() || keys <= 0 {
        return None;
    }

    // One press per object (a hold contributes its head), sorted by time; ties keep the input order, as in the reference's `sorted()`.
    let mut presses: Vec<(f64, i32)> = notes.iter().map(|n| (n.t, column_of(n.x, keys))).collect();
    presses.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    // Collapse same-timestamp, same-column duplicates into one event; `size[i]` is the number of columns pressed at that instant, and 0 marks a repeat already accounted for by the first event of its instant (the reference's `sizes` marker).
    let mut events: Vec<(f64, i32)> = Vec::with_capacity(presses.len());
    for p in presses {
        if let Some(last) = events.last() {
            if last.0 == p.0 && last.1 == p.1 {
                continue;
            }
        }
        events.push(p);
    }
    let mut sizes = vec![1usize; events.len()];
    let mut i = 0usize;
    while i < events.len() {
        let mut j = i + 1;
        while j < events.len() && events[j].0 == events[i].0 {
            j += 1;
        }
        if j - i > 1 {
            sizes[i] = j - i;
            for slot in sizes.iter_mut().take(j).skip(i + 1) {
                *slot = 0;
            }
        }
        i = j;
    }

    let mut total = 0usize;
    let mut fast = 0usize;
    for a in 1..events.len() {
        // Same-instant events belong to one chord, and a repeat carries no gap of its own.
        if sizes[a] == 0 || events[a].0 == events[a - 1].0 {
            continue;
        }
        if events[a].1 == events[a - 1].1 {
            continue;
        }
        let gap = events[a].0 - events[a - 1].0;
        if gap > 0.0 {
            total += 1;
            if gap <= FAST_CROSS_MS {
                fast += 1;
            }
        }
    }
    if total == 0 {
        return None;
    }
    Some(round_dec(fast as f64 / total as f64, 3))
}
