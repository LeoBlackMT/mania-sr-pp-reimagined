//! Dataset-level aggregates for the comparison site.
//!
//! The site's dataset-wide modules (layer medians over every player, the algorithm correlation matrix, price distributions and the worst disagreements) must stay instant once the dataset holds hundreds of players and tens of thousands of scores. Fetching every shard in the browser to compute them would not scale, so the CLI computes them here and publishes them inside `index.json`, which is what the site loads anyway.
//!
//! Everything is emitted as plain numbers so the page can do its own arithmetic for whichever A/B algorithm pair a visitor picks: for every layer we store the median price per algorithm and the median *relative* difference of every ordered algorithm pair, which is what an A/B view needs without re-deriving it from medians (the median of ratios is not the ratio of medians).

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

use crate::emit::{round3, round4};

/// One score reduced to what the aggregates need.
pub struct AggregateScore {
    pub uid: u64,
    pub score_id: Option<i64>,
    pub beatmap_id: i64,
    pub artist: String,
    pub title: String,
    pub version: String,
    pub mods: String,
    pub keys: i32,
    pub ln_ratio: f64,
    /// Price per algorithm id, `None` when the algorithm could not price the score.
    pub pp: BTreeMap<&'static str, Option<f64>>,
}

/// Number of histogram bins per algorithm.
const BINS: usize = 24;

/// Worst disagreements published to the site.
const TOP_DISAGREE: usize = 60;

/// A score only counts as a disagreement when every algorithm prices it above [`DISAGREE_MIN_PP`] and the dearest of them clears [`DISAGREE_MIN_TOP_PP`]; below that the spread measures rounding noise around zero rather than a difference of opinion.
const DISAGREE_MIN_PP: f64 = 50.0;
const DISAGREE_MIN_TOP_PP: f64 = 200.0;

fn median(values: &mut [f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mid = values.len() / 2;
    Some(if values.len() % 2 == 0 {
        (values[mid - 1] + values[mid]) / 2.0
    } else {
        values[mid]
    })
}

/// Layer keys a score belongs to: key mode, mod family and long-note style.
///
/// The thresholds match the site (`utils` in the page): RC below 10% holds, HB in between, LN above 90%. Families partition the dataset, so a layer's `n` values add up across a family.
fn layers_of(score: &AggregateScore) -> Vec<(&'static str, String)> {
    let keys = match score.keys {
        4 => "4K".to_owned(),
        6 => "6K".to_owned(),
        7 => "7K".to_owned(),
        k => format!("{k}K"),
    };
    let mods = score.mods.to_uppercase();
    let family = if mods.is_empty() || mods == "NM" {
        "NM"
    } else if mods.contains("DT") || mods.contains("NC") {
        "Rate-up"
    } else if mods.contains("HT") || mods.contains("DC") {
        "Rate-down"
    } else {
        "Other mods"
    };
    let style = if score.ln_ratio < 0.10 {
        "RC"
    } else if score.ln_ratio > 0.90 {
        "LN"
    } else {
        "HB"
    };
    vec![
        ("key mode", keys),
        ("mod family", family.to_owned()),
        ("long notes", style.to_owned()),
    ]
}

fn pearson(xs: &[f64], ys: &[f64]) -> Option<f64> {
    let n = xs.len().min(ys.len());
    if n < 3 {
        return None;
    }
    let (mx, my) = (
        xs.iter().sum::<f64>() / n as f64,
        ys.iter().sum::<f64>() / n as f64,
    );
    let mut sxy = 0.0;
    let mut sxx = 0.0;
    let mut syy = 0.0;
    for i in 0..n {
        let dx = xs[i] - mx;
        let dy = ys[i] - my;
        sxy += dx * dy;
        sxx += dx * dx;
        syy += dy * dy;
    }
    if sxx <= 0.0 || syy <= 0.0 {
        return None;
    }
    Some(sxy / (sxx.sqrt() * syy.sqrt()))
}

/// Build the `aggregates` object for `index.json`.
pub fn build(scores: &[AggregateScore], algorithm_ids: &[&'static str]) -> Value {
    // --- layers -----------------------------------------------------------------------------
    let mut layers: BTreeMap<(&'static str, String), Vec<&AggregateScore>> = BTreeMap::new();
    for score in scores {
        for key in layers_of(score) {
            layers.entry(key).or_default().push(score);
        }
    }

    let mut layer_rows: Vec<Value> = Vec::new();
    for ((family, layer), members) in &layers {
        let mut medians = Map::new();
        for id in algorithm_ids {
            let mut values: Vec<f64> = members
                .iter()
                .filter_map(|s| s.pp.get(id).copied().flatten())
                .collect();
            if let Some(m) = median(&mut values) {
                medians.insert((*id).to_owned(), json!(round3(m)));
            }
        }

        // Median relative difference for every ordered pair: how much B pays against A on the same scores. Stored for all pairs so the page never has to guess.
        let mut rel = Map::new();
        for a in algorithm_ids {
            let mut row = Map::new();
            for b in algorithm_ids {
                if a == b {
                    continue;
                }
                let mut ratios: Vec<f64> = members
                    .iter()
                    .filter_map(|s| {
                        let pa = s.pp.get(a).copied().flatten()?;
                        let pb = s.pp.get(b).copied().flatten()?;
                        if pa > 0.0 {
                            Some((pb / pa - 1.0) * 100.0)
                        } else {
                            None
                        }
                    })
                    .collect();
                if let Some(m) = median(&mut ratios) {
                    row.insert((*b).to_owned(), json!(round4(m)));
                }
            }
            if !row.is_empty() {
                rel.insert((*a).to_owned(), Value::Object(row));
            }
        }

        layer_rows.push(json!({
            "family": family,
            "layer": layer,
            "n": members.len(),
            "median_pp": Value::Object(medians),
            "rel_pct": Value::Object(rel),
        }));
    }

    // --- correlation between algorithms, over every score ------------------------------------
    let mut correlation = Map::new();
    for a in algorithm_ids {
        let mut row = Map::new();
        for b in algorithm_ids {
            let pairs: Vec<(f64, f64)> = scores
                .iter()
                .filter_map(|s| {
                    let pa = s.pp.get(a).copied().flatten()?;
                    let pb = s.pp.get(b).copied().flatten()?;
                    Some((pa, pb))
                })
                .collect();
            let xs: Vec<f64> = pairs.iter().map(|p| p.0).collect();
            let ys: Vec<f64> = pairs.iter().map(|p| p.1).collect();
            if let Some(r) = pearson(&xs, &ys) {
                row.insert((*b).to_owned(), json!(round4(r)));
            }
        }
        correlation.insert((*a).to_owned(), Value::Object(row));
    }

    // --- price distribution per algorithm ----------------------------------------------------
    let mut distribution = Map::new();
    for id in algorithm_ids {
        let mut values: Vec<f64> = scores
            .iter()
            .filter_map(|s| s.pp.get(id).copied().flatten())
            .collect();
        if values.is_empty() {
            continue;
        }
        values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let min = values[0];
        let max = values[values.len() - 1];
        let width = ((max - min) / BINS as f64).max(f64::MIN_POSITIVE);
        let mut bins = vec![0u32; BINS];
        for v in &values {
            let idx = (((v - min) / width) as usize).min(BINS - 1);
            bins[idx] += 1;
        }
        let q = |p: f64| {
            let idx = ((p * (values.len() - 1) as f64).round() as usize).min(values.len() - 1);
            round3(values[idx])
        };
        distribution.insert(
            (*id).to_owned(),
            json!({
                "n": values.len(),
                "min": round3(min),
                "max": round3(max),
                "p25": q(0.25),
                "median": q(0.5),
                "p75": q(0.75),
                "p95": q(0.95),
                "bins": bins,
                "bin_min": round3(min),
                "bin_max": round3(max),
            }),
        );
    }

    // --- worst disagreements across the whole dataset ----------------------------------------
    // A score only counts when every algorithm priced it meaningfully. When one of them bottoms out
    // near zero pp — a trivial map, or a play so bad the curve flattens — the spread jumps towards
    // 400% and says nothing about the algorithms; those rows used to fill the whole list.
    let mut ranked: Vec<(f64, &AggregateScore)> = scores
        .iter()
        .filter_map(|s| {
            let values: Vec<f64> = algorithm_ids
                .iter()
                .filter_map(|id| s.pp.get(id).copied().flatten())
                .collect();
            if values.len() < algorithm_ids.len() || values.iter().any(|v| *v <= DISAGREE_MIN_PP) {
                return None;
            }
            let top = values.iter().cloned().fold(f64::MIN, f64::max);
            if top < DISAGREE_MIN_TOP_PP {
                return None;
            }
            let mean = values.iter().sum::<f64>() / values.len() as f64;
            if mean <= 0.0 {
                return None;
            }
            let spread = (top - values.iter().cloned().fold(f64::MAX, f64::min)) / mean;
            Some((spread, s))
        })
        .collect();
    ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    let disagreements: Vec<Value> = ranked
        .iter()
        .take(TOP_DISAGREE)
        .map(|(spread, s)| {
            let mut pp = Map::new();
            for id in algorithm_ids {
                if let Some(v) = s.pp.get(id).copied().flatten() {
                    pp.insert((*id).to_owned(), json!(round3(v)));
                }
            }
            json!({
                "uid": s.uid,
                "score_id": s.score_id,
                "beatmap_id": s.beatmap_id,
                "artist": s.artist,
                "title": s.title,
                "version": s.version,
                "mods": s.mods,
                "keys": s.keys,
                "ln_ratio": round4(s.ln_ratio),
                "spread": round4(spread * 100.0),
                "pp": Value::Object(pp),
            })
        })
        .collect();

    json!({
        "score_count": scores.len(),
        "layers": layer_rows,
        "correlation": Value::Object(correlation),
        "distribution": Value::Object(distribution),
        "top_disagreements": disagreements,
    })
}
