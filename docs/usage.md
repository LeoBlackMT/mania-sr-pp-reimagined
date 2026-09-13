# Usage

## Requirements

* Rust stable (1.77+; the toolchain file pins the channel).
* Beatmap files (`.osu`) for the maps you want to compare — supplied from a local cache directory.

This repository deliberately contains **no build artefacts, no local caches and no test files**:
every tracked file is either source, documentation, the published dataset, or the specification.
That has two practical consequences:

```bash
# build output goes outside the repository so `git status` stays clean
export CARGO_TARGET_DIR=../_build/mania-sr-pp-reimagined     # PowerShell: $env:CARGO_TARGET_DIR
cargo build --release
```

and verification lives on the research side (see [Verification](#verification)).

## Layout

```
Cargo.toml                  workspace
spec/spec.json              tunable specification, exported from the research repository
crates/mania-pp-spec/       typed access to the specification (embedded at compile time)
crates/mania-pp-algorithms/ the four algorithms, one module each
crates/mania-pp-cli/        fixture -> results JSON
fixtures/                   bp-list fixtures (score lists, no map data)
web/                        static comparison site
docs/                       algorithms.md (descriptions), reference-csharp-sources.md, usage.md
```

## Fixtures

A fixture is a score list plus out-of-repository beatmaps.

```
fixtures/
  bp-21207706/
    scores.tsv          # the fixture itself, tracked
    README.md           # optional provenance notes
maps/                   # NOT here: keep the .osu cache outside the repository
```

Score list, tab separated (a header row is auto-detected and skipped):

```
uid	username	map_id	mods	320	300	200	100	50	miss
21207706	player	3449961	DT	5200	210	14	2	0	1
```

`mods` uses the usual acronyms, joined with `+` (`DT+MR`, `HDHR`) or unseparated
(`EZDTV2`) — both are accepted. Map metadata (artist, title, version, key count, OD, HP) is read
from the `.osu` file, never from the fixture.

The JSON form is equivalent:

```json
{ "users": [ { "uid": 21207706, "username": "player",
  "scores": [ { "map_id": 3449961, "mods": "DT", "counts": [5200, 210, 14, 2, 0, 1] } ] } ] }
```

## Running the comparison

```bash
cargo run --release -p mania-pp-cli -- \
  --fixture fixtures/bp-21207706/scores.tsv \
  --maps    /path/to/osu/map/cache \
  --out     web/data/results.json
```

| Option | Meaning |
|---|---|
| `--fixture <path>` | score list (TSV or JSON), required |
| `--maps <dir>` | directory containing `{map_id}.osu`, required |
| `--out <path>` | output document (default `web/data/results.json`) |
| `--limit N` | only the first `N` scores per user |
| `--quiet` | no console summary |

The console prints, per user, the weighted total of each algorithm and the delta against `bancho`,
followed by the scores where the algorithms disagree most — those are usually the interesting ones.

**Totals**: per algorithm, the user's scores are ranked by *that algorithm's* PP and summed with
weight `0.95^n`, i.e. what the profile would look like if that algorithm were the one in use. No
bonus PP is applied.

## `results.json`

The document written by the CLI and read by the site. Extend it additively and bump
`schema_version` when a consumer would break.

```jsonc
{
  "schema_version": 1,
  "generated_at": "2026-09-13T12:00:00Z",
  "engine": { "name": "mania-pp-rs", "version": "0.1.0",
              "spec_version": "v1.14", "rosu_pp_rev": "3530ba7" },
  "algorithms": [ { "id": "bancho", "label": "bancho (official)",
                    "description": "osu!lazer mania pp" } ],
  "users": [ {
    "uid": 21207706, "username": "player", "fixture": "scores",
    "total_pp": { "bancho": 12345.6, "sunny": 13000.1, "surface": 12800.0, "reimagined": 12600.5 },
    "scores": [ {
      "beatmap_id": 3449961, "artist": "xi", "title": "Akasha",
      "version": "Primordial Substance", "keys": 7, "od": 7.0, "mods": "DT",
      "accuracy": 98.12, "counts": [5200, 210, 14, 2, 0, 1],
      "pp": { "bancho": 512.3, "sunny": 560.1, "surface": 548.2, "reimagined": 540.9 },
      "detail": { "stars_full": 8.84, "stars_rice": 7.60, "ln_ratio": 0.545, "w": 1.15,
                  "coord_mod": 1.02, "eff_star": 8.91, "acc_factor": 1.0, "nf_factor": 1.0 }
    } ]
  } ],
  "warnings": []
}
```

Conventions: `pp` objects always carry every algorithm id (a score whose algorithm failed is skipped
and reported in `warnings`); scores are sorted by `reimagined`, then `bancho`, then map id, so the
file is stable across runs; map data is never embedded.

## The comparison site

`web/` is plain static files (`index.html`, `app.js`, `styles.css`) plus the dataset. Serve it
locally with any static server:

```bash
python -m http.server 8080 --directory web
```

GitHub Pages is configured on the remote side; this repository intentionally carries no Pages
workflow. Publishing is therefore: run the CLI, commit `web/data/results.json`, push. The data file
is small because it contains ids and metadata only.

Two ways to serve this directory, both without adding a workflow here:

* **Deploy from a branch** — repository *Settings → Pages → Source: Deploy from a branch*, branch
  `main`, folder `/ (root)`. The site is then reachable at
  `https://<owner>.github.io/<repo>/web/`, and `web/data/results.json` resolves relative to it.
* **GitHub Actions (remote-generated workflow)** — if the remote generates a static-site workflow,
  point its upload step at `web` (`path: web`) so the deployed root is the site itself and the URL
  becomes `https://<owner>.github.io/<repo>/`.

Either way the site is plain static files: no build step runs, so what is reviewed locally is
exactly what visitors receive.

Before committing a refreshed dataset, validate it — CI runs the same check:

```bash
python3 tools/validate_results.py web/data/results.json
```

## Specification sync

`spec/spec.json` is generated by the research repository (`scripts/export_engine_spec.py`) and
embedded into the engine at compile time; no tunable is hand-maintained here. After a research-side
change:

1. export the spec on the research side (and bump the version there),
2. update `EXPECTED_SPEC_VERSION` in `crates/mania-pp-spec/src/lib.rs` if the version moved,
3. re-run the CLI and commit the refreshed `web/data/results.json`,
4. tag the engine so published numbers remain traceable to a specification version.

## Verification

Correctness is verified from the research repository, which owns both the Python reference
implementation and the golden vectors exported from it
(`langs/engine_check/` — a harness that replays those vectors against these crates). This keeps the
engine free of test code while still failing loudly on any behavioural drift.

Two layers are checked, and it is worth knowing which one catches what:

| Layer | What it pins | Tool |
|---|---|---|
| **Formula layer** | every function of the reimagined algorithm against the Python reference: windows, mods, key resolution, chord/column features, `.osu` parsing, the rice variant, the No-Fail model and the full pricing pipeline (685 cases / 1880 assertions) | `langs/engine_check` (research side) |
| **End-to-end parity** | the published `reimagined` column against the research report for the same scores, i.e. whether the engine reproduces the specification's numbers with *its own* difficulty front-end | `scripts/compare_engine_vs_research.py` (research side) |

The second layer exists because R and L are measured, not copied: the engine derives them from the
pinned fork's sunny implementation, while the research reference derives them from its vendored
sunny build. Two independent implementations of the same algorithm do not agree bit-for-bit, so the
parity check quantifies the difference instead of assuming it away. Measured on the current fixture
(100 scores, 4K, NM/DT/MR):

| Comparison | median | p5 | p95 |
|---|---|---|---|
| engine star rating / research star rating | 1.0016 | 1.0000 | 1.0045 |
| engine rice star rating / research rice star rating | 1.0001 | 0.9988 | 1.0017 |
| **engine `reimagined` PP / research `pp_final_surface`** | **1.0034** | 1.0005 | 1.0099 |

In other words the engine reproduces the research specification's production number to within about
0.3% at the median and 1% at p95, and the residual is explained by the two sunny implementations
disagreeing by ~0.16% on these maps. Re-run the parity check whenever the fork revision is bumped,
because that is exactly when this residual can change.
