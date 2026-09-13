//! Output: the `results.json` document consumed by the site, and a console summary.
//!
//! The document follows `docs/usage.md`. Field order is explicit and scores are sorted
//! deterministically, so re-running over unchanged inputs produces a byte-identical file.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use mania_pp_algorithms::{bancho, reimagined, sunny, surface, ReimaginedDetail, ScorePp};
use serde_json::{json, Map, Value};

use crate::ScoreRow;

/// Upstream revision this build compares against.
///
/// Keep in sync with the `rev` in the workspace `Cargo.toml`; it is reported in the data document so
/// a published page can always be traced back to the algorithms it used.
pub const ROSU_PP_REV: &str = "3530ba7";

/// (module id, label, description) in presentation order.
fn algorithm_table() -> [(&'static str, &'static str, &'static str); 4] {
    [
        (bancho::ID, bancho::LABEL, bancho::DESCRIPTION),
        (sunny::ID, sunny::LABEL, sunny::DESCRIPTION),
        (surface::ID, surface::LABEL, surface::DESCRIPTION),
        (reimagined::ID, reimagined::LABEL, reimagined::DESCRIPTION),
    ]
}

pub struct ScoreOut {
    pub row: ScoreRow,
    pub pp: ScorePp,
    pub detail: ReimaginedDetail,
    pub artist: String,
    pub title: String,
    pub version: String,
    pub keys: i32,
    pub od: f64,
    pub accuracy: f64,
}

pub struct UserOut {
    pub uid: u64,
    pub username: String,
    pub fixture: String,
    pub scores: Vec<ScoreOut>,
}

/// osu!-style weighted total over that algorithm's own ranking of the user's scores.
fn weighted_total(pps: &[f64]) -> f64 {
    let mut sorted: Vec<f64> = pps.to_vec();
    sorted.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
    sorted
        .iter()
        .enumerate()
        .map(|(i, pp)| pp * 0.95_f64.powi(i as i32))
        .sum()
}

fn sort_scores(scores: &mut [ScoreOut]) {
    scores.sort_by(|a, b| {
        let key = |s: &ScoreOut| {
            (
                s.pp.reimagined.unwrap_or(f64::MIN),
                s.pp.bancho.unwrap_or(f64::MIN),
            )
        };
        let (ra, ba) = key(a);
        let (rb, bb) = key(b);
        rb.partial_cmp(&ra)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(bb.partial_cmp(&ba).unwrap_or(std::cmp::Ordering::Equal))
            .then_with(|| a.row.map_id.cmp(&b.row.map_id))
    });
}

pub fn build_document(users: &mut [UserOut], warnings: Vec<String>) -> Value {
    for user in users.iter_mut() {
        sort_scores(&mut user.scores);
    }

    let algorithms: Vec<Value> = algorithm_table()
        .iter()
        .map(|(id, label, description)| {
            json!({ "id": id, "label": label, "description": description })
        })
        .collect();

    let users_json: Vec<Value> = users
        .iter()
        .map(|user| {
            let mut totals = Map::new();
            for (id, _, _) in algorithm_table() {
                let pps: Vec<f64> = user.scores.iter().filter_map(|s| s.pp.get(id)).collect();
                if !pps.is_empty() {
                    totals.insert(id.to_owned(), json!(round3(weighted_total(&pps))));
                }
            }

            let scores: Vec<Value> = user
                .scores
                .iter()
                .map(|score| {
                    let mut pp = Map::new();
                    for (id, _, _) in algorithm_table() {
                        if let Some(value) = score.pp.get(id) {
                            pp.insert(id.to_owned(), json!(round3(value)));
                        }
                    }
                    let d = &score.detail;
                    json!({
                        "beatmap_id": score.row.map_id.parse::<i64>().unwrap_or(0),
                        "artist": score.artist,
                        "title": score.title,
                        "version": score.version,
                        "keys": score.keys,
                        "od": score.od,
                        "mods": score.row.mods,
                        "accuracy": round3(score.accuracy),
                        "counts": score.row.counts,
                        "pp": Value::Object(pp),
                        "detail": {
                            "stars_full": round3(d.stars_full),
                            "stars_rice": round3(d.stars_rice),
                            "ln_ratio": round4(d.ln_ratio),
                            "l_share": round4(d.l_share),
                            "w": round4(d.w),
                            "coord_mod": round4(d.coord_mod),
                            "eff_star": round3(d.eff_star),
                            "acc_factor": round4(d.acc_factor),
                            "nf_factor": round4(d.nf_factor),
                            "variety": round3(d.variety),
                            "acc_scalar": round4(d.acc_scalar),
                        },
                    })
                })
                .collect();

            json!({
                "uid": user.uid,
                "username": user.username,
                "fixture": user.fixture,
                "total_pp": Value::Object(totals),
                "scores": scores,
            })
        })
        .collect();

    json!({
        "schema_version": 1,
        "generated_at": rfc3339_now(),
        "engine": {
            "name": "mania-pp-rs",
            "version": env!("CARGO_PKG_VERSION"),
            "spec_version": mania_pp_spec::spec().spec_version,
            "rosu_pp_rev": ROSU_PP_REV,
        },
        "algorithms": algorithms,
        "users": users_json,
        "warnings": warnings,
    })
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

fn round4(v: f64) -> f64 {
    (v * 10_000.0).round() / 10_000.0
}

pub fn write_json(document: &Value, path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
        }
    }
    let text = serde_json::to_string_pretty(document)
        .map_err(|e| format!("cannot serialize the results document: {e}"))?;
    std::fs::write(path, format!("{text}\n"))
        .map_err(|e| format!("cannot write {}: {e}", path.display()))
}

pub fn print_summary(document: &Value, out: &Path) {
    let empty = Vec::new();
    let users = document["users"].as_array().unwrap_or(&empty);
    let table = algorithm_table();
    println!();

    for user in users {
        let uid = user["uid"].as_u64().unwrap_or(0);
        let name = user["username"].as_str().unwrap_or("unknown");
        let scores = user["scores"].as_array().map(|s| s.len()).unwrap_or(0);
        println!("user {name} ({uid}) — {scores} scores");
        let baseline = user["total_pp"]["bancho"].as_f64();
        println!(
            "  {:<22} {:>12} {:>10}",
            "algorithm", "total pp", "vs bancho"
        );
        for (id, _, _) in table {
            let total = user["total_pp"][id].as_f64();
            let delta = match (total, baseline) {
                (Some(t), Some(b)) if b > 0.0 => format!("{:+.2}%", (t / b - 1.0) * 100.0),
                _ => "—".to_owned(),
            };
            let total_text = total
                .map(|t| format!("{t:.2}"))
                .unwrap_or_else(|| "—".to_owned());
            println!("  {:<22} {:>12} {:>10}", id, total_text, delta);
        }
    }

    // The interesting cases: where the algorithms disagree the most.
    let mut disagreements: Vec<(f64, String, String, f64, f64)> = Vec::new();
    for user in users {
        for score in user["scores"].as_array().unwrap_or(&empty) {
            let values: Vec<f64> = table
                .iter()
                .filter_map(|(id, _, _)| score["pp"][id].as_f64())
                .collect();
            if values.len() < 2 {
                continue;
            }
            let max = values.iter().cloned().fold(f64::MIN, f64::max);
            let min = values.iter().cloned().fold(f64::MAX, f64::min);
            let mean = values.iter().sum::<f64>() / values.len() as f64;
            if mean <= 0.0 {
                continue;
            }
            disagreements.push((
                (max - min) / mean,
                user["username"].as_str().unwrap_or("").to_owned(),
                format!(
                    "{} - {} [{}] {}K {}",
                    score["artist"].as_str().unwrap_or(""),
                    score["title"].as_str().unwrap_or(""),
                    score["version"].as_str().unwrap_or(""),
                    score["keys"],
                    score["mods"].as_str().unwrap_or("")
                ),
                min,
                max,
            ));
        }
    }
    disagreements.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    if !disagreements.is_empty() {
        println!("\ntop disagreements (normalised spread across the four algorithms)");
        for (spread, user, label, min, max) in disagreements.iter().take(8) {
            println!(
                "  {:>6.1}%  {:<18} {:.1} … {:.1}  {}",
                spread * 100.0,
                user,
                min,
                max,
                label
            );
        }
    }

    let warnings = document["warnings"].as_array().cloned().unwrap_or_default();
    if !warnings.is_empty() {
        println!("\n{} warning(s):", warnings.len());
        for w in warnings.iter().take(5) {
            println!("  {}", w.as_str().unwrap_or(""));
        }
    }

    println!("\nwrote {}", out.display());
}

/// Minimal RFC 3339 UTC timestamp (avoids a date-time dependency for one formatted field).
fn rfc3339_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Howard Hinnant's days -> civil date algorithm (public domain).
fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}
