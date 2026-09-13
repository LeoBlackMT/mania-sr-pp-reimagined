# mania-sr-pp-reimagined — the comparison site

A static, dependency-free page that compares **four osu!mania PP algorithms** over one or more
players' "best performance" (bp) lists, and shows *where* the algorithms disagree rather than only
*that* they do.

| id | label | what it is |
| --- | --- | --- |
| `bancho` | **Bancho** | official osu! pp (osu!lazer mania) |
| `sunny` | **Sunny** | community algorithm by [Crz]sunnyxxy — its repository is named *Star-Rating-Rebirth*; pattern and accuracy part only |
| `codexxy` | **Codexxy** | Sunny plus a map-based timing surface |
| `reimagined` | **Reimagined** | this project's three-channel R / L / A algorithm |

No frameworks, no CDN, no build step, no test fixtures. Three files — `index.html`, `styles.css`,
`app.js` — plus the dataset the engine writes into `data/`.

## Run it locally

GitHub Pages serves `docs/`, so **the site root is `docs/`** and the dataset is fetched from
`data/…` relative to `index.html`. Serve that directory:

```bash
cd docs
python -m http.server 8080
# then open http://127.0.0.1:8080/
```

Any static server works (`python -m http.server`, `npx serve`, `caddy file-server`, …); the port is
arbitrary. Serving over HTTP is the intended path.

### Opening straight from disk (`file://`)

Browsers refuse `fetch()` for `file://` documents, so a page opened that way can never read its own
dataset. It detects this, says so, and offers the **drag-and-drop zone / file picker** instead — a
dataset loaded that way renders exactly as it would over HTTP, except that per-player shards still
come from `data/…` and therefore need HTTP. Nothing is uploaded: the file is read in the browser
with `FileReader`.

## Where the dataset comes from

The Rust engine scores every bp entry with all four algorithms and writes the dataset:

```bash
export CARGO_TARGET_DIR=../_build/mania-sr-pp-reimagined      # PowerShell: $env:CARGO_TARGET_DIR
cargo run --release -p mania-pp-cli -- \
  --fixture fixtures/bp-lists.tsv \
  --maps    /path/to/osu/map/cache \
  --out     docs/data
```

* `--maps` is a directory of `{map_id}.osu` files and lives **outside** this repository.
* `--out` defaults to `docs/data`; a path ending in `index.json` is accepted and its parent is used.
* `--limit N` truncates each bp list, `--bench` prints per-algorithm timings, `--quiet` silences the
  console summary. See [`usage.md`](usage.md) for fixtures and options.
* Per-algorithm totals are weighted sums over *that algorithm's own ranking* of the player's scores
  (weight `0.95^n`) — what the profile would look like under that algorithm. No bonus PP is applied.
* The CLI is offline and deterministic: it never queries the osu! API, and re-running it over
  unchanged inputs produces byte-identical files.

## Data layout (`schema_version: 2`)

The dataset is split so a visitor downloads only what they look at:

```text
docs/data/index.json            engine info, algorithm list, one entry per player + weighted totals
docs/data/players/{uid}.json    that player's scores only, in columnar form (fetched on selection)
```

### `index.json`

```jsonc
{
  "schema_version": 2,
  "generated_at": "2026-09-13T09:22:32Z",
  "engine": { "name": "mania-pp-rs", "version": "0.1.0",
              "spec_version": "v1.14", "rosu_pp_rev": "3530ba7" },
  "algorithms": [
    { "id": "bancho", "label": "Bancho", "description": "osu!lazer mania pp: one fused strain rating…" }
  ],
  "users": [ {
    "uid": 21207706, "username": "Shirasu-Azusa", "fixture": "bp-lists",
    "scores": 100, "file": "players/21207706.json",
    "total_pp": { "bancho": 14923.947, "sunny": 14961.185,
                  "codexxy": 15021.095, "reimagined": 14486.368 }
  } ],
  "score_count": 500,
  "warnings": []
}
```

| field | required | behaviour when missing |
| --- | --- | --- |
| `schema_version` | no | any value other than `2` raises a notice-bar warning; the page still renders |
| `generated_at`, `engine.*` | no | omitted from the header line and shown as `–` in the footer |
| `algorithms[].id` | no | ids are recovered from `total_pp` / `pp_*` keys instead, and the built-in labels are used |
| `algorithms[].label` / `.description` | no | falls back to the built-in description of that id |
| `users[]` | no | an empty list renders "This dataset contains no players", never an error |
| `users[].fixture` | no | shown as a tooltip on the bp-list selector when present |
| `users[].file` | no | the shard is requested from `players/{uid}.json` |
| `users[].total_pp` | no | the totals of that player are derived from the shard with osu!'s 0.95 decay, and the panel says so |
| `users[].scores` | no | `0` means the shard is not fetched at all and the page says the list is empty |
| `warnings[]` | no | skipped; when present, the footer lists them (first 25) |

### `players/{uid}.json`

Column names appear once and every score is a plain array in that order:

```jsonc
{
  "schema_version": 2, "uid": 21207706, "username": "Shirasu-Azusa",
  "columns": ["beatmap_id", "artist", "title", "version", "keys", "od", "mods", "accuracy",
              "n320", "n300", "n200", "n100", "n50", "miss",
              "pp_bancho", "pp_sunny", "pp_codexxy", "pp_reimagined",
              "stars_full", "stars_rice", "ln_ratio", "l_share", "w", "coord_mod", "eff_star",
              "acc_factor", "nf_factor", "mods_parts"],
  "scores": [ [3449961, "xi", "Akasha", "Primordial Substance", 7, 7.0, "DT", 98.12,
               5200, 210, 14, 2, 0, 1, 512.3, 560.1, 548.2, 540.9,
               8.84, 7.6, 0.545, 0.436, 1.15, 1.02, 8.91, 1.0, 1.0, "DT MR"] ]
}
```

| columns | meaning |
| --- | --- |
| `beatmap_id`, `artist`, `title`, `version` | map identity, read from the `.osu` file |
| `keys`, `od` | key count and OD |
| `mods` | the raw mod string (`"DT+MR"`, `""` = NoMod) |
| `accuracy` | the score's accuracy in percent |
| `n320`, `n300`, `n200`, `n100`, `n50`, `miss` | judgement counts in that order |
| `pp_bancho`, `pp_sunny`, `pp_codexxy`, `pp_reimagined` | one pp value per algorithm; `null` when that algorithm did not price the score |
| `stars_full`, `stars_rice` | the two star ratings behind Reimagined: the full map and the rice variant (every hold read as a tap) |
| `ln_ratio` | share of objects that are long notes |
| `l_share`, `w`, `coord_mod`, `eff_star`, `acc_factor`, `nf_factor` | the Reimagined internals: coordination share, LN weight, cross-column modulation, effective star rating and the two multipliers |
| `mods_parts` | space-separated mod flags the filters use (`"DT MR"`, `"NM"`) |

Unknown columns are ignored, and any optional column that is absent renders as `–`. Extra `pp_*`
columns are picked up as additional algorithms, so an added algorithm does not need a page change.

## What the page shows

1. **Legend** — each algorithm's own label and description from the dataset, marked `A` / `B` with
   the currently selected pair.
2. **Totals** — one row per algorithm: weighted total pp, difference against A (absolute and
   relative), a marked A-baseline row, the explicit `A → B` line (`diff (B − A)`, `relative (B/A)`,
   `ratio`) and a bar chart whose axis is zoomed to the observed range — four totals within a few
   percent of each other would compare nothing from zero.
3. **Scores** — the dense, sortable table: beatmap, keys, OD, mods, accuracy, the six judgement
   counts, `stars_full`, `stars_rice`, `ln_ratio`, both sides of the comparison, `Δ B − A`,
   `Δ % (B/A)`, each algorithm's rank in the list, the rank shift, and the pp of every other
   algorithm. Clicking a row (or its `+` button) expands the detail block: full metadata plus the
   Reimagined internals. Filters: free text, key mode, mod family, style bucket, and "show more"
   pagination. **Export CSV** writes exactly the filtered and sorted view.
4. **Layer summary** — the relative difference aggregated by key mode (4K/6K/7K/other), mod family
   (NM, DT·NC, HT·DC, other) and style bucket (rice / mix / LN), with n, the median relative
   difference and the median pp under A — the same split the research side reports.
5. **Where the algorithms disagree** — the largest normalised spread over all four algorithms, plus
   a scatter of `ln_ratio` (x) against the relative difference of B vs A (y), one dot per score.
6. **All players** — weighted totals, difference against Bancho and each player's rank under each
   algorithm, with `▲`/`▼` showing who moves when the algorithm changes. Clicking a row opens that
   bp list.
7. **Provenance** — engine name and version, spec version, `rosu_pp_rev`, `generated_at`, schema
   version, player and score counts, the dataset source, and any engine warnings.

### Derived numbers

* **A / B pair** — two dropdowns (plus a swap button) initialised to `bancho` and `reimagined`. Every
  comparison on the page follows them: the Δ columns, the bar chart, the score table headers, the
  rank columns, the layer table and the scatter.
* **diff (B − A)** and **relative diff (B/A)** — per score, the second printed as `B / A − 1` in
  percent; `null` (shown as `–`) when either side has no pp value for that score.
* **Rank shift** — each score's position (1 = best) in the player's list ordered by A and by B, and
  the difference `rank B − rank A`: positive means the score drops when the list is ordered by B.
  Ranks always cover the **whole** bp list, not the filtered rows, ties fall back to the shard order
  (so ranks are deterministic), and a score an algorithm did not price has no rank. Shifts are
  highlighted from `|shift| ≥ 4` and strongly from `≥ 10`.
* **Normalised spread** — `(max − min) / mean` over every algorithm that priced that score, i.e. a
  scale-free "how much do they disagree, in percent", ranked descending.
* **Layer buckets** — keys are exact (4/6/7, everything else including missing data is *other K*);
  mods are matched as substrings on `mods_parts` (falling back to `mods`), so `DT`/`NC` are rate-up,
  `HT`/`DC` rate-down, `NM` is NoMod and everything else is *other*; the style buckets are
  `ln_ratio < 0.05` rice, `0.05 ≤ ln_ratio < 0.35` mix, `≥ 0.35` LN, and a score without `ln_ratio`
  is unclassified. Layer rows partition each family, so their n add up. The layer table covers the
  **whole** bp list and deliberately ignores the filters above it; the score table, the disagreement
  list and the scatter respect them.
* **Scatter scaling** — x is the fixed `ln_ratio` domain `[0, 1]` with dashed rules at the 0.05 and
  0.35 cut-offs; y is symmetric linear over `±max|relative difference|` (at least ±2 %) so zero sits
  exactly on the mid-line. The dashed horizontal line is the median; the caption also gives the rice
  and LN medians, and a gap between them is the systematic long-note preference.
* **Cross-player ranks** — dense ranks over the index totals (1 = highest); `▲`/`▼` is the move
  against that player's Bancho rank.

### CSV export

The button next to the score count writes the current filter and sort — not just the visible page —
to a UTF-8 file with a BOM (so Excel reads artist names correctly) and LF-free CRLF rows. The header
carries both algorithm ids, so a file kept next to another comparison stays unambiguous:

```text
beatmap_id,artist,title,version,keys,od,mods,mods_parts,accuracy,n320,…,miss,
pp_bancho,pp_sunny,pp_codexxy,pp_reimagined,
diff_pp_<B>_minus_<A>,rel_pct_<B>_over_<A>,rank_<A>,rank_<B>,rank_shift_<B>_minus_<A>,
spread_rel,stars_full,stars_rice,ln_ratio,l_share,w,coord_mod,eff_star,acc_factor,nf_factor
```

## Loading a file by hand

Drag a `.json` file anywhere on the page, or use either file picker (header, empty state). Two
documents are accepted:

* an **index document** (`users` array) — the normal case; its player shards are still fetched from
  `data/…`, so this is a way to preview a freshly generated dataset without copying it into place;
* a **single player shard** (`columns` + `scores`) — rendered on its own, with the weighted totals
  derived from its scores using osu!'s 0.95 decay (the panel says so).

## GitHub Pages

Pages is configured on the remote side as **Deploy from a branch**, branch `main`, folder `/docs`;
this repository intentionally carries no Pages workflow. Because the published root *is* `docs/`,
the site lives at `https://<owner>.github.io/<repo>/` and `data/index.json` resolves next to
`index.html`. `docs/.nojekyll` keeps Pages from post-processing the directory, and Pages serves
`.json` as `application/json`, so no further configuration is needed.

Publishing is therefore: run the CLI, commit `docs/data/`, push. The dataset is small — ids and
metadata only, no map data. If the dataset is absent, visitors get the empty state and can still load
their own file.

## Failing safely

| situation | what the page does |
| --- | --- |
| `data/index.json` missing or unreadable | empty state: the exact reason (`HTTP 404`, `Failed to fetch`, a JSON parse error), the CLI command that produces the file, the drop zone, and the four algorithm descriptions |
| a player shard fails to load | the totals table still renders from the index, an error panel names the URL and the HTTP status and offers a retry; the per-score panels stay hidden |
| a batch of scores has `null` pp for an algorithm | that cell shows `–`, and the score is excluded from that algorithm's ranks, from the spread maths and from the diff |
| a player whose index entry has `0` scores | the shard is not fetched; "No scores in this bp list" explains the empty list |
| a corrupted or non-JSON file is dropped | the failure is reported in the notice bar (or the empty state) and the rendered dataset is left alone |
| unknown extra columns | ignored |
| missing optional columns (e.g. `stars_rice`, `ln_ratio`) | shown as `–`; style buckets collapse to *unclassified* and the scatter says how many scores it skipped |
| a dataset with `schema_version ≠ 2` | a notice-bar warning; the page still renders what it can |

## Verification

Verified against a temporary copy of `index.html`, `app.js`, `styles.css` and the published `data/`
directory served with `python -m http.server` and driven through headless Chromium (Playwright) —
nothing was generated inside the repository:

* the dataset path, the empty state (missing `data/index.json`), and the `file://` path;
* player switching, and the cross-player overview row click;
* switching A and B (including the swap button): the Δ columns, bar chart, score-table headers, rank
  columns, layer table and scatter all follow;
* the rank-shift column cross-checked against an independent ranking of the shard (100 scores, both
  pairs) and the CSV rank columns against the same;
* the layer table cross-checked against medians computed straight from the shards, for a 4K player
  and for two 4K/6K/7K players (every group's n adds up to the bp list size);
* CSV export captured as a real browser download — 101 rows × 34 columns, UTF-8 BOM verified on disk;
* click-to-sort on numeric and text columns, the free-text filter, all three filter chip groups,
  "show more" pagination, and row expansion;
* missing shard, empty player, dropped columns, an unknown extra column, `null` pp values, a stale
  `schema_version` and engine warnings, each on its own copy outside the repository.

The site is plain static files: what is reviewed locally is exactly what visitors receive.
