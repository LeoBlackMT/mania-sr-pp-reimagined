//! Comparison CLI: reads a fixture score list, computes four algorithms per score, and writes the
//! comparison dataset consumed by the site.
//!
//! Fixture formats (see `docs/usage.md`):
//!
//! * TSV — `uid <TAB> username <TAB> map_id <TAB> mods <TAB> 320 <TAB> 300 <TAB> 200 <TAB> 100 <TAB> 50 <TAB> miss`
//!   (a header row is optional and auto-detected),
//! * JSON — `{"users":[{"uid":…,"username":…,"scores":[{"map_id":…,"mods":…,"counts":[…]}]}]}`.
//!
//! The map directory holds `{map_id}.osu` files and lives outside the repository.
//!
//! Output: `docs/data/index.json` plus `docs/data/players/{uid}.json` — see `emit.rs` for why the
//! dataset is split and columnar.

mod emit;

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use mania_pp_algorithms::{prepare, price_with_detail, Counts, Prepared};
use serde_json::Value;

#[derive(Clone, Debug)]
pub struct ScoreRow {
    pub uid: u64,
    pub username: String,
    pub map_id: String,
    pub mods: String,
    pub counts: Counts,
}

struct Args {
    fixture: PathBuf,
    maps: PathBuf,
    out: PathBuf,
    limit: Option<usize>,
    quiet: bool,
    bench: bool,
}

const USAGE: &str = "\
mania-pp-cli — compare four osu!mania PP algorithms over a fixture score list

USAGE:
    mania-pp-cli --fixture <scores.tsv|scores.json> --maps <map dir> [--out <data dir>]
                 [--limit N] [--bench] [--quiet]

OPTIONS:
    --fixture <path>   score list (TSV with an optional header, or JSON)
    --maps <dir>       directory containing {map_id}.osu files (required; never committed)
    --out <dir|file>   dataset location (default: docs/data; a path ending in index.json is
                       accepted and its parent directory is used)
    --limit N          only the first N scores per user, in input order
    --bench            print per-algorithm single-score timings after the run
    --quiet            suppress the console summary
    -h, --help         print this help

OUTPUT:
    <out>/index.json              engine info, algorithms, per-player totals and shard paths
    <out>/players/{uid}.json      one player's scores, columnar (see docs/usage.md)

NOTES:
    Per-algorithm totals are weighted sums over that algorithm's own ranking of the user's scores
    (weight 0.95^n): what the profile would look like under that algorithm. No bonus PP is applied.
    Map metadata (artist/title/version/keys/OD) is read from the .osu file, not from the fixture.
";

fn parse_args() -> Result<Args, String> {
    let mut fixture: Option<PathBuf> = None;
    let mut maps: Option<PathBuf> = None;
    let mut out = PathBuf::from("docs/data");
    let mut limit = None;
    let mut quiet = false;
    let mut bench = false;

    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "-h" | "--help" => {
                print!("{USAGE}");
                std::process::exit(0);
            }
            "--fixture" => fixture = Some(PathBuf::from(next_value(&mut it, "--fixture")?)),
            "--maps" => maps = Some(PathBuf::from(next_value(&mut it, "--maps")?)),
            "--out" => out = PathBuf::from(next_value(&mut it, "--out")?),
            "--limit" => {
                let raw = next_value(&mut it, "--limit")?;
                limit = Some(
                    raw.parse::<usize>()
                        .map_err(|_| format!("bad --limit: {raw}"))?,
                );
            }
            "--bench" => bench = true,
            "--quiet" => quiet = true,
            other => return Err(format!("unknown argument: {other}\n\n{USAGE}")),
        }
    }

    Ok(Args {
        fixture: fixture.ok_or_else(|| format!("--fixture is required\n\n{USAGE}"))?,
        maps: maps.ok_or_else(|| format!("--maps is required\n\n{USAGE}"))?,
        out,
        limit,
        quiet,
        bench,
    })
}

fn next_value(it: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    it.next().ok_or_else(|| format!("{flag} needs a value"))
}

fn parse_counts(fields: &[&str]) -> Option<Counts> {
    let mut counts = [0u32; 6];
    for (i, slot) in counts.iter_mut().enumerate() {
        *slot = fields.get(i)?.trim().parse().ok()?;
    }
    Some(counts)
}

fn load_tsv(text: &str) -> Result<Vec<ScoreRow>, String> {
    let mut rows = Vec::new();
    for (lineno, line) in text.lines().enumerate() {
        let line = line.trim_end();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let fields: Vec<&str> = line.split('\t').collect();
        if fields.len() < 10 {
            if lineno == 0 {
                continue; // header
            }
            return Err(format!(
                "line {}: expected 10 tab-separated fields",
                lineno + 1
            ));
        }
        let uid: u64 = match fields[0].trim().parse() {
            Ok(v) => v,
            Err(_) if lineno == 0 => continue, // header row
            Err(_) => return Err(format!("line {}: bad uid {:?}", lineno + 1, fields[0])),
        };
        let counts = parse_counts(&fields[4..10])
            .ok_or_else(|| format!("line {}: bad judgement counts", lineno + 1))?;
        rows.push(ScoreRow {
            uid,
            username: fields[1].trim().to_owned(),
            map_id: fields[2].trim().to_owned(),
            mods: fields[3].trim().to_owned(),
            counts,
        });
    }
    Ok(rows)
}

fn load_json(text: &str) -> Result<Vec<ScoreRow>, String> {
    let value: Value =
        serde_json::from_str(text).map_err(|e| format!("fixture is not valid JSON: {e}"))?;
    let mut rows = Vec::new();
    let users = value
        .get("users")
        .and_then(Value::as_array)
        .ok_or("JSON fixture must have a top-level \"users\" array")?;

    for user in users {
        let uid = user.get("uid").and_then(Value::as_u64).unwrap_or(0);
        let username = user
            .get("username")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_owned();
        let scores = user
            .get("scores")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("user {uid} has no \"scores\" array"))?;

        for score in scores {
            let map_id = score
                .get("map_id")
                .or_else(|| score.get("beatmap_id"))
                .map(|v| match v {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                })
                .ok_or_else(|| format!("user {uid}: a score is missing \"map_id\""))?;
            let mods = score
                .get("mods")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            let counts_arr = score
                .get("counts")
                .and_then(Value::as_array)
                .ok_or_else(|| format!("user {uid} map {map_id}: missing \"counts\""))?;
            let mut counts = [0u32; 6];
            for (i, slot) in counts.iter_mut().enumerate() {
                *slot = counts_arr.get(i).and_then(Value::as_u64).unwrap_or(0) as u32;
            }
            rows.push(ScoreRow {
                uid,
                username: username.clone(),
                map_id,
                mods,
                counts,
            });
        }
    }
    Ok(rows)
}

fn load_fixture(path: &PathBuf) -> Result<Vec<ScoreRow>, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("cannot read fixture {}: {e}", path.display()))?;
    let is_json = path
        .extension()
        .map(|e| e.eq_ignore_ascii_case("json"))
        .unwrap_or(false)
        || text.trim_start().starts_with('{');
    if is_json {
        load_json(&text)
    } else {
        load_tsv(&text)
    }
}

/// Space-separated mod flags the site filters on, e.g. `"DT MR"` or `"NM"`.
///
/// The raw mod string is kept as well; these flags just save the page from re-parsing acronyms
/// whenever a filter changes.
fn mod_flags(mods_str: &str) -> String {
    let set = mania_pp_algorithms::ModSet::parse(mods_str);
    if set.acronyms.is_empty() {
        return "NM".to_owned();
    }
    set.acronyms.join(" ")
}

fn median(values: &mut [Duration]) -> Duration {
    if values.is_empty() {
        return Duration::ZERO;
    }
    values.sort_unstable();
    values[values.len() / 2]
}

fn mean(values: &[Duration]) -> Duration {
    if values.is_empty() {
        return Duration::ZERO;
    }
    let total: u128 = values.iter().map(|d| d.as_nanos()).sum();
    Duration::from_nanos((total / values.len() as u128) as u64)
}

fn percentile(values: &mut [Duration], p: f64) -> Duration {
    if values.is_empty() {
        return Duration::ZERO;
    }
    values.sort_unstable();
    let idx = ((p * values.len() as f64) as usize).min(values.len() - 1);
    values[idx]
}

fn micros(d: Duration) -> String {
    format!("{:.1}µs", d.as_secs_f64() * 1e6)
}

fn millis(d: Duration) -> String {
    format!("{:.1}ms", d.as_secs_f64() * 1e3)
}

fn main() {
    if let Err(err) = run() {
        eprintln!("error: {err}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args = parse_args()?;
    let rows = load_fixture(&args.fixture)?;
    if rows.is_empty() {
        return Err(format!(
            "fixture {} contains no scores",
            args.fixture.display()
        ));
    }

    let mut order: Vec<u64> = Vec::new();
    let mut by_user: BTreeMap<u64, Vec<ScoreRow>> = BTreeMap::new();
    for row in rows {
        if !by_user.contains_key(&row.uid) {
            order.push(row.uid);
        }
        by_user.entry(row.uid).or_default().push(row);
    }

    // A bp list reuses maps heavily; both the raw text and the prepared state are cached.
    let mut text_cache: HashMap<String, String> = HashMap::new();
    let mut prepared_cache: HashMap<(String, String), Prepared> = HashMap::new();

    let mut users_out = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    // Bench accumulators (filled only when --bench is given).
    let mut t_prepare: Vec<Duration> = Vec::new();
    let mut t_bancho: Vec<Duration> = Vec::new();
    let mut t_sunny: Vec<Duration> = Vec::new();
    let mut t_reimagined: Vec<Duration> = Vec::new();
    let mut t_score: Vec<Duration> = Vec::new();

    for uid in &order {
        let mut rows = by_user.remove(uid).unwrap_or_default();
        if let Some(limit) = args.limit {
            rows.truncate(limit);
        }
        let username = rows.first().map(|r| r.username.clone()).unwrap_or_default();
        let mut scores_out = Vec::new();

        for row in &rows {
            let text = match text_cache.get(&row.map_id) {
                Some(text) => text.clone(),
                None => {
                    let path = args.maps.join(format!("{}.osu", row.map_id));
                    match std::fs::read_to_string(&path) {
                        Ok(text) => {
                            text_cache.insert(row.map_id.clone(), text.clone());
                            text
                        }
                        Err(err) => {
                            warnings.push(format!(
                                "map {} of user {uid} is not in the map cache ({err})",
                                row.map_id
                            ));
                            continue;
                        }
                    }
                }
            };

            let key = (row.map_id.clone(), row.mods.clone());
            if !prepared_cache.contains_key(&key) {
                let started = Instant::now();
                match prepare(&text, &row.mods) {
                    Ok(prepared) => {
                        t_prepare.push(started.elapsed());
                        prepared_cache.insert(key.clone(), prepared);
                    }
                    Err(err) => {
                        warnings.push(format!("map {} ({}): {err}", row.map_id, row.mods));
                        continue;
                    }
                }
            }
            let prepared = prepared_cache.get(&key).expect("just inserted");

            let score_started = Instant::now();
            let (pp, detail) = price_with_detail(prepared, &row.counts);
            t_score.push(score_started.elapsed());

            if args.bench {
                let counts = row.counts;
                let started = Instant::now();
                let _ = mania_pp_algorithms::bancho::pp(prepared, &counts);
                t_bancho.push(started.elapsed());

                let started = Instant::now();
                let perf = mania_pp_algorithms::sunny::performance(prepared, &counts);
                let _ = mania_pp_algorithms::sunny::pattern_pp_from(&perf);
                let _ = mania_pp_algorithms::codexxy::pp_from(&perf);
                t_sunny.push(started.elapsed());

                let started = Instant::now();
                let _ = mania_pp_algorithms::reimagined::pp(prepared, &counts);
                t_reimagined.push(started.elapsed());
            }

            let info = prepared.map_info();
            scores_out.push(emit::ScoreOut {
                row: row.clone(),
                pp,
                detail,
                artist: info.artist.clone(),
                title: info.title.clone(),
                version: info.version.clone(),
                keys: info.keys,
                od: info.od,
                accuracy: mania_pp_algorithms::reimagined::pp::custom_accuracy(&row.counts) * 100.0,
                mods_parts: mod_flags(&row.mods),
            });
        }

        users_out.push(emit::UserOut {
            uid: *uid,
            username,
            fixture: args
                .fixture
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default(),
            scores: scores_out,
        });
    }

    let document = emit::write_dataset(&mut users_out, warnings, &args.out)?;
    if !args.quiet {
        emit::print_summary(&document, &args.out);
    }
    if args.bench {
        print_bench(
            &mut t_prepare,
            &mut t_bancho,
            &mut t_sunny,
            &mut t_reimagined,
            &mut t_score,
        );
    }
    Ok(())
}

fn print_bench(
    t_prepare: &mut [Duration],
    t_bancho: &mut [Duration],
    t_sunny: &mut [Duration],
    t_reimagined: &mut [Duration],
    t_score: &mut [Duration],
) {
    let pairs = t_prepare.len();
    println!("\n=== single-score timings (release build) ===");
    println!(
        "  {:<34} {:>10} {:>10} {:>10}",
        "stage", "median", "mean", "p95"
    );
    println!(
        "  {:<34} {:>10} {:>10} {:>10}",
        format!("prepare per (map, mods) [n={pairs}]"),
        millis(median(t_prepare)),
        millis(mean(t_prepare)),
        millis(percentile(t_prepare, 0.95))
    );
    let rows: [(&str, &mut [Duration]); 4] = [
        ("bancho::pp", t_bancho),
        ("sunny + Codexxy (one pass)", t_sunny),
        ("reimagined::pp", t_reimagined),
        ("total per score (four columns)", t_score),
    ];
    for (label, samples) in rows {
        println!(
            "  {:<34} {:>10} {:>10} {:>10}",
            label,
            micros(median(samples)),
            micros(mean(samples)),
            micros(percentile(samples, 0.95))
        );
    }
    println!(
        "  note: `prepare` is paid once per (map, mods) and cached; sunny and Codexxy share one\n\
         \x20       upstream performance pass, so they are timed together."
    );
}
