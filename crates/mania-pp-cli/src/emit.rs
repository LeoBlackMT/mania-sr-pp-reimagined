//! Output: the comparison dataset consumed by the site, plus a console summary.
//!
//! # Why the dataset is split and columnar
//!
//! A bp list fixture is a few hundred scores today, but the intended scale is hundreds of players and tens of thousands of scores. One big JSON document would mean (a) every visitor downloads everything, (b) the whole thing is parsed on load, (c) a single file grows into a merge-conflict magnet in git. So the dataset is written as:
//!
//! ```text
//! docs/data/index.json            engine info, algorithm list, one entry per player + weighted totals docs/data/players/{uid}.json    that player's scores only, in columnar form
//! ```
//!
//! The index is small enough to load eagerly; a player's shard is fetched when it is selected. Inside a shard the column names appear **once**, and each score is a plain array of values in that order — roughly a third of the bytes of an array of objects, and much faster to turn into table rows in the browser.
//!
//! Field order is explicit and scores are sorted deterministically, so re-running over unchanged inputs produces byte-identical files.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use mania_pp_algorithms::{bancho, codexxy, reimagined, sunny, ReimaginedDetail, ScorePp};
use serde_json::{json, Map, Value};

use crate::ScoreRow;

/// Bumped whenever the dataset layout changes in a way a consumer must notice.
///
/// * 1 — single document, array of score objects
/// * 2 — index + per-player columnar shards
/// * 3 — links (score id, beatmapset id), official star column, renamed star columns
pub const SCHEMA_VERSION: u32 = 3;

/// Upstream revision this build compares against.
///
/// Keep in sync with the `rev` in the workspace `Cargo.toml`; it is reported in the dataset so a published page can always be traced back to the algorithms it used.
pub const ROSU_PP_REV: &str = "3530ba7";

/// Columns of a player shard, in order. The site indexes into `scores` with these names.
const COLUMNS: [&str; 32] = [
    // identity and links
    "score_id",
    "beatmap_id",
    "beatmap_set_id",
    // map metadata
    "artist",
    "title",
    "version",
    "mapper",
    "keys",
    "od",
    // mods
    "mods",
    "mods_parts",
    // score quality
    "accuracy",
    "n320",
    "n300",
    "n200",
    "n100",
    "n50",
    "miss",
    // prices, in algorithm order
    "pp_bancho",
    "pp_sunny",
    "pp_codexxy",
    "pp_reimagined",
    // star ratings: Bancho's own, and the two the Reimagined channels are built from
    "star_bancho",
    "star_sunny",
    "star_rice",
    // structure and Reimagined internals
    "ln_ratio",
    "l_share",
    "w",
    "coord_mod",
    "eff_star",
    "acc_factor",
    "nf_factor",
];

/// (module id, label, description) in presentation order.
fn algorithm_table() -> [(&'static str, &'static str, &'static str); 4] {
    [
        (bancho::ID, bancho::LABEL, bancho::DESCRIPTION),
        (sunny::ID, sunny::LABEL, sunny::DESCRIPTION),
        (codexxy::ID, codexxy::LABEL, codexxy::DESCRIPTION),
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
    /// Difficulty author (`Creator`), for the map column and `creator=`/`mapper=` search.
    pub mapper: String,
    pub keys: i32,
    pub od: f64,
    pub accuracy: f64,
    /// Official (Bancho) star rating of the map with the score's mods.
    pub star_bancho: f64,
    /// Beatmapset id, for the canonical `beatmapsets/{set}#mania/{id}` link.
    pub beatmap_set_id: i64,
    /// Space-separated mod flags the site filters on (e.g. `"DT EZ NF"`).
    pub mods_parts: String,
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

pub(crate) fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

pub(crate) fn round4(v: f64) -> f64 {
    (v * 10_000.0).round() / 10_000.0
}

fn opt(v: Option<f64>) -> Value {
    match v {
        Some(x) => json!(round3(x)),
        None => Value::Null,
    }
}

/// Write `index.json` plus one shard per player, and return the index document.
pub fn write_dataset(
    users: &mut [UserOut],
    warnings: Vec<String>,
    out: &Path,
) -> Result<Value, String> {
    for user in users.iter_mut() {
        sort_scores(&mut user.scores);
    }

    // `--out` may be the data directory itself or the index file inside it.
    let data_dir = if out.file_name().and_then(|n| n.to_str()) == Some("index.json") {
        out.parent().unwrap_or(Path::new(".")).to_path_buf()
    } else {
        out.to_path_buf()
    };
    let players_dir = data_dir.join("players");
    std::fs::create_dir_all(&players_dir)
        .map_err(|e| format!("cannot create {}: {e}", players_dir.display()))?;

    let algorithms: Vec<Value> = algorithm_table()
        .iter()
        .map(|(id, label, description)| {
            json!({ "id": id, "label": label, "description": description })
        })
        .collect();

    let mut index_users: Vec<Value> = Vec::new();
    let mut total_scores = 0usize;

    for user in users.iter() {
        let mut totals = Map::new();
        for (id, _, _) in algorithm_table() {
            let pps: Vec<f64> = user.scores.iter().filter_map(|s| s.pp.get(id)).collect();
            if !pps.is_empty() {
                totals.insert(id.to_owned(), json!(round3(weighted_total(&pps))));
            }
        }

        let rows: Vec<Value> = user
            .scores
            .iter()
            .map(|s| {
                let d = &s.detail;
                json!([
                    // identity and links
                    s.row.score_id,
                    s.row.map_id.parse::<i64>().unwrap_or(0),
                    s.beatmap_set_id,
                    // map metadata
                    s.artist,
                    s.title,
                    s.version,
                    s.mapper,
                    s.keys,
                    s.od,
                    // mods
                    s.row.mods,
                    s.mods_parts,
                    // score quality
                    round3(s.accuracy),
                    s.row.counts[0],
                    s.row.counts[1],
                    s.row.counts[2],
                    s.row.counts[3],
                    s.row.counts[4],
                    s.row.counts[5],
                    // prices, in algorithm order
                    opt(s.pp.bancho),
                    opt(s.pp.sunny),
                    opt(s.pp.codexxy),
                    opt(s.pp.reimagined),
                    // star ratings
                    round3(s.star_bancho),
                    round3(d.stars_full),
                    round3(d.stars_rice),
                    // structure and Reimagined internals
                    round4(d.ln_ratio),
                    round4(d.l_share),
                    round4(d.w),
                    round4(d.coord_mod),
                    round3(d.eff_star),
                    round4(d.acc_factor),
                    round4(d.nf_factor),
                ])
            })
            .collect();

        total_scores += rows.len();

        let shard = json!({
            "schema_version": SCHEMA_VERSION,
            "uid": user.uid,
            "username": user.username,
            "columns": COLUMNS,
            "scores": rows,
        });
        let shard_path = players_dir.join(format!("{}.json", user.uid));
        write_json(&shard, &shard_path)?;

        index_users.push(json!({
            "uid": user.uid,
            "username": user.username,
            "fixture": user.fixture,
            "scores": user.scores.len(),
            "file": format!("players/{}.json", user.uid),
            "total_pp": Value::Object(totals),
        }));
    }

    let aggregate_ids: Vec<&'static str> = algorithm_table().iter().map(|(id, _, _)| *id).collect();
    let aggregate_scores: Vec<crate::aggregates::AggregateScore> = users
        .iter()
        .flat_map(|user| {
            user.scores.iter().map(|s| {
                let mut pp = BTreeMap::new();
                for id in &aggregate_ids {
                    pp.insert(*id, s.pp.get(id));
                }
                crate::aggregates::AggregateScore {
                    uid: user.uid,
                    score_id: s.row.score_id,
                    beatmap_id: s.row.map_id.parse::<i64>().unwrap_or(0),
                    artist: s.artist.clone(),
                    title: s.title.clone(),
                    version: s.version.clone(),
                    mods: s.row.mods.clone(),
                    keys: s.keys,
                    ln_ratio: s.detail.ln_ratio,
                    pp,
                }
            })
        })
        .collect();

    let index = json!({
        "schema_version": SCHEMA_VERSION,
        "generated_at": rfc3339_now(),
        "engine": {
            "name": "mania-pp-rs",
            "version": env!("CARGO_PKG_VERSION"),
            "spec_version": mania_pp_spec::spec().spec_version,
            "rosu_pp_rev": ROSU_PP_REV,
        },
        "algorithms": algorithms,
        "users": index_users,
        "score_count": total_scores,
        "aggregates": crate::aggregates::build(&aggregate_scores, &aggregate_ids),
        "warnings": warnings,
    });

    let index_path = data_dir.join("index.json");
    write_json(&index, &index_path)?;
    Ok(index)
}

pub fn write_json(document: &Value, path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
        }
    }
    let text = serde_json::to_string_pretty(document)
        .map_err(|e| format!("cannot serialize the dataset: {e}"))?;
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
        let scores = user["scores"].as_u64().unwrap_or(0);
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

    let warnings = document["warnings"].as_array().cloned().unwrap_or_default();
    if !warnings.is_empty() {
        println!("\n{} warning(s):", warnings.len());
        for w in warnings.iter().take(5) {
            println!("  {}", w.as_str().unwrap_or(""));
        }
    }

    println!(
        "\nwrote {} (+ {} player shard(s))",
        out.display(),
        users.len()
    );
}

/// Minimal RFC 3339 UTC timestamp (avoids a date-time dependency for one formatted field).
pub fn rfc3339_now() -> String {
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
