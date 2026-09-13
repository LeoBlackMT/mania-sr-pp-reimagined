# mania PP algorithm comparison — web front-end

A static, dependency-free page that compares **four osu!mania PP algorithms** over one or more
players' "best performance" (bp) lists:

| id | what it is |
| --- | --- |
| `bancho` | official osu! pp (osu!lazer mania) |
| `sunny` | community Star-Rating-Rebirth algorithm (pattern + accuracy part) |
| `surface` | `sunny` plus the surface map-based timing model |
| `reimagined` | this project's own three-channel algorithm (R / L / A) |

No frameworks, no CDN, no build step, no test fixtures. Three files: `index.html`, `styles.css`,
`app.js` — plus the dataset the engine writes into `data/`.

## Run locally

```bash
python -m http.server 8080 --directory web
# then open http://127.0.0.1:8080/
```

Any static server works (`python -m http.server`, `npx serve`, `caddy file-server`, …); port 8080 is
arbitrary. Serving over HTTP is the intended path.

### Opening from disk (`file://`)

Browsers refuse `fetch()` for `file://` documents, so a page opened this way can never read its own
data file. The page detects this, says so, and offers the **drag-and-drop zone / file picker**
instead; a dataset loaded that way renders exactly as it would over HTTP. Nothing is uploaded — the
file is read in the browser with `FileReader`.

## Where `results.json` comes from

The Rust engine scores every bp entry with all four algorithms and writes one JSON document. The page
reads it from a fixed relative URL:

```
web/data/results.json      <- relative URL "data/results.json"
```

Generate it with the CLI:

```bash
cargo run --release -p mania-pp-cli -- \
  --fixture fixtures/bp-21207706/scores.tsv \
  --maps    /path/to/osu/map/cache \
  --out     web/data/results.json
```

(`--out` already defaults to `web/data/results.json`.) See [`docs/usage.md`](../docs/usage.md) for
fixtures, options and the full publishing workflow.

## Empty state

**This repository ships no sample dataset**, so a fresh checkout has nothing to render — and that is
a normal state, not an error. When `data/results.json` is missing or unreadable the page shows:

* a heading saying **No dataset yet** and the exact reason (`HTTP 404`, `Failed to fetch`, or a JSON
  parse error),
* the command that produces the file,
* the drag-and-drop zone / file picker, which loads any `results.json` from the visitor's machine,
* the four algorithm descriptions, so the page still explains what it compares.

The same panel handles a corrupt or unusable file. If a dataset is **already** rendered and a manual
load fails, the failure is reported in the notice bar under the header instead, and the rendered
dataset is left alone.

## JSON schema contract (`schema_version: 1`)

```jsonc
{
  "schema_version": 1,
  "generated_at": "2026-09-13T12:00:00Z",
  "engine": { "name": "mania-pp-rs", "version": "0.1.0", "spec_version": "v1.14", "rosu_pp_rev": "3530ba7" },
  "algorithms": [
    { "id": "bancho", "label": "bancho (official)", "description": "osu!lazer mania pp" }
  ],
  "users": [ {
    "uid": 21207706, "username": "player", "fixture": "bp-21207706/scores.tsv",
    "total_pp": { "bancho": 12345.6, "sunny": 13000.1, "surface": 12800.0, "reimagined": 12600.5 },
    "scores": [ {
      "beatmap_id": 3449961, "artist": "xi", "title": "Akasha", "version": "Primordial Substance",
      "keys": 7, "od": 7.0, "mods": "DT", "accuracy": 98.12, "counts": [5200, 210, 14, 2, 0, 1],
      "pp": { "bancho": 512.3, "sunny": 560.1, "surface": 548.2, "reimagined": 540.9 },
      "detail": { "stars_full": 8.84, "stars_rice": 7.6, "ln_ratio": 0.545, "l_share": 0.436,
                  "w": 1.15, "coord_mod": 1.02, "eff_star": 8.91, "acc_factor": 1.0,
                  "nf_factor": 1.0, "variety": 3.25, "acc_scalar": 0.87 }
    } ]
  } ],
  "warnings": []
}
```

Fields the page reads, and how it behaves when one is absent:

| field | required | behaviour when missing |
| --- | --- | --- |
| `schema_version` | no | a value other than `1` raises a warning banner; the page still renders |
| `generated_at`, `engine.*` | no | omitted from the header line |
| `algorithms[].id` | no | algorithm ids are recovered from the `pp` / `total_pp` keys instead |
| `algorithms[].label` / `.description` | no | falls back to the built-in description of that algorithm id |
| `users[]` | no | an empty list renders "This file contains no users", never an error |
| `users[].fixture` | no | shown as a tooltip on the bp-list selector when present |
| `users[].total_pp` | no | totals are approximated from the scores with osu!'s 0.95 decay, and the panel says so |
| `scores[].keys` / `.od` / `.accuracy` | no | shown as `–` and sorted to the bottom |
| `scores[].mods` | no | treated as `NM` — an empty mod string is NoMod in osu! |
| `scores[].counts` | no | judgement counts are omitted from the expanded detail |
| `scores[].pp[algo]` | no | that cell shows `–`; the score is excluded from spread maths for that algorithm |
| `scores[].detail.*` | no | every present key is listed in the expanded detail, in file order |
| `warnings[]` | no | skipped; when present, the first three are shown in the notice bar |

Unknown fields are ignored and unknown `detail` keys are rendered as-is. The page never invents
fields and never mutates the input. Note that `pp` only carries the algorithms that succeeded for
that score, so a score may have fewer than four entries — the page handles two or three algorithms
throughout (delta header, chart, spread).

### How the layers are derived

* **keys** — `4K` = `keys === 4`, `7K` = `keys === 7`, everything else (including missing) = *other K*.
* **mods** — substring match, because the engine emits both `EZDT` and the unseparated `EZDTV2`:
  `DT`/`NC` → *DT·NC*, `HT`/`DC` → *HT·DC*, empty or `NM` → *NM*, anything else → *other*.
* **LN vs rice** — `detail.ln_ratio >= 0.2` is an LN map, below that rice. A score with no `ln_ratio`
  is *unclassified*: visible under "LN + rice" but under neither single layer.

### Derived numbers

* **Δ vs bancho** (summary table and score table) — `focus − base`, where base is `bancho` when
  present and otherwise the first algorithm in the file; focus is `reimagined` when present,
  otherwise the last. The column header names both ids, so the table is never ambiguous.
* **Normalised spread** (disagreement view) — `(max − min) / mean` over the algorithms that priced
  that score, i.e. a scale-free "how much do they disagree, in percent". This matches the metric the
  CLI prints in its own console summary. The view also shows the `max/min` ratio, ranks descending,
  respects the filters above it, and expands to the per-algorithm deviation from the score mean.
* **Bar chart** — one bar per algorithm. The axis is zoomed to the observed range (35 % of the spread
  as padding on each side) because four totals within a few percent of each other would look
  identical as zero-based bars. Every bar prints its exact figure and the caption states where the
  axis starts.

## GitHub Pages

GitHub Pages is configured on the remote side; this repository intentionally carries no Pages
workflow. Publishing is: run the CLI, commit `web/data/results.json`, push. The dataset is small —
ids and metadata only, no map data.

Because the site is plain static files with relative paths, it is served at
`https://<user>.github.io/<repo>/web/` when Pages serves the repository root. The engine output must
be committed next to `index.html`; that is the only path the page fetches automatically. Pages serves
`.json` as `application/json`, so no extra configuration is needed. If the file is absent, visitors
see the empty state and can still load their own file.

## Verification

Verified with the repository served over HTTP (`python -m http.server`) and driven through headless
Chromium: the empty state, the primary `data/results.json` path, click-to-sort on every numeric
column, the free-text filter, all three layer filters, "show more" pagination on a 300-score list,
user switching, the disagreement ranking and its row expansion, the `file://` path, and the
drag-and-drop / file-input loaders. Datasets used for the verification were generated outside the
repository.
