# mania-sr-pp-reimagined — the site

> **This repository is the algorithm repository of the Reimagined osu!mania pp algorithm, and this
> page renders the dataset that the engine publishes. The four-algorithm comparison is a by-product
> of validating that algorithm against the ones it competes with. It is not what the repository is
> for, and it is not a ranking of osu!mania players.**
>
> The same sentence is printed at the top of the page itself.

A static, dependency-free viewer over the dataset the Rust engine writes. Four algorithms are priced
on the same best-performance lists, and the interesting output is *where* they disagree — because
that is what tells the algorithm author whether the three-channel split behaves.

| id | label | what it is |
| --- | --- | --- |
| `bancho` | **Bancho** | official osu! pp (osu!lazer mania): one fused strain rating, an accuracy term and a length bonus |
| `sunny` | **Sunny** | community algorithm by [Crz]sunnyxxy — repository *Star-Rating-Rebirth*; pattern and accuracy part only |
| `codexxy` | **Codexxy** | Sunny plus a map-based timing surface |
| `reimagined` | **Reimagined** | this project's three-channel R / L / A algorithm |

No frameworks, no CDN, no build step, no test fixtures. **Four files** carry the whole site:

```text
docs/index.html      the page shell: header, empty state, the two views, the syntax panel, the footer
docs/styles.css      both themes, the dense-table typography, the responsive rules
docs/app.js          everything else, in thirteen commented sections (see "Source layout")
docs/web.md          this document
```

`docs/data/` is the published dataset, written by the engine — not part of the site source.

## Run it locally

GitHub Pages serves `docs/`, so **the site root is `docs/`** and every URL is relative: the index is
fetched from `data/index.json` next to `index.html`. Serve that directory — a plain `file://` open
cannot read sibling files, and the page says so instead of failing silently:

```bash
cd docs
python -m http.server 8080
# then open http://127.0.0.1:8080/
```

Any static server works (`python -m http.server`, `npx serve`, `caddy file-server`, …).

## Where the dataset comes from

The Rust engine scores every bp entry with all four algorithms and writes the dataset:

```bash
cargo run --release -p mania-pp-cli -- \
  --fixture fixtures/bp-lists.tsv \
  --maps    /path/to/osu/map/cache \
  --out     docs/data
```

* `--maps` is a directory of `{map_id}.osu` files and lives **outside** this repository.
* `--out` defaults to `docs/data`; a path ending in `index.json` is accepted and its parent is used.
* Per-algorithm totals are weighted sums over *that algorithm's own ranking* of the player's scores
  (weight `0.95^n`) — what the profile would look like under that algorithm. No bonus PP.
* The CLI is offline and deterministic: re-running it over unchanged inputs is byte-identical.

## Data layout (`schema_version: 3`)

The dataset is split so a visitor downloads only what they look at:

```text
docs/data/index.json            engine info, algorithm list, one entry per player + weighted totals
docs/data/players/{uid}.json    that player's scores only, in columnar form (fetched on selection)
```

### `index.json`

```jsonc
{
  "schema_version": 3,
  "generated_at": "2026-09-13T10:40:33Z",
  "engine": { "name": "mania-pp-rs", "version": "0.1.0",
              "spec_version": "v1.14", "rosu_pp_rev": "3530ba7" },
  "algorithms": [
    { "id": "bancho", "label": "Bancho", "description": "osu!lazer mania pp: …" }
  ],
  "users": [ {
    "uid": 21207706, "username": "Shirasu-Azusa", "fixture": "bp-lists",
    "scores": 100, "file": "players/21207706.json",
    "total_pp": { "bancho": 14923.947, "sunny": 14961.185,
                  "codexxy": 15021.095, "reimagined": 14486.368 }
  } ],
  "score_count": 1900,
  "warnings": []
}
```

| field | required | behaviour when missing or different |
| --- | --- | --- |
| `schema_version` | no | anything other than `3` raises a notice-bar warning; **newer** versions still render the fields the page understands, older ones show `–` for what they lack |
| `generated_at`, `engine.*` | no | omitted from the header line, shown as `–` in the footer |
| `algorithms[].id` | no | ids are recovered from the `total_pp` / `pp_*` keys, with built-in labels |
| `algorithms[].label` / `.description` | no | falls back to the built-in description of that id |
| `users[]` | no | an empty list renders "This dataset contains no players", never an error |
| `users[].fixture` | no | shown in the player header when present |
| `users[].file` | no | the shard is requested from `players/{uid}.json` |
| `users[].total_pp` | no | totals are derived from the shard with osu!'s 0.95 decay, and the panel says so |
| `users[].scores` | no | `0` means the shard is still fetched; an empty list renders its own explanation |
| `warnings[]` | no | the footer lists them (first 25) |

### `players/{uid}.json`

Column names appear once and every score is a plain array in that order:

```jsonc
{
  "schema_version": 3, "uid": 21207706, "username": "Shirasu-Azusa",
  "columns": ["score_id", "beatmap_id", "beatmap_set_id", "artist", "title", "version", "keys",
              "od", "mods", "mods_parts", "accuracy", "n320", "n300", "n200", "n100", "n50", "miss",
              "pp_bancho", "pp_sunny", "pp_codexxy", "pp_reimagined",
              "star_bancho", "star_sunny", "star_rice", "ln_ratio", "l_share", "w", "coord_mod",
              "eff_star", "acc_factor", "nf_factor"],
  "scores": [ [3449961, 3525702, 1683685, "shimizushi", "Eternal White", "Eternal White | Extra",
               4, 7.8, "DT+MR", "DT MR", 96.533, 960, 400, 58, 3, 9, 14,
               654.367, 572.824, 569.217, 568.991,
               7.361, 7.371, 6.78, 0.7202, 0.0802, 0.9474, 0.9972, 7.34, 1.0018, 1.0] ]
}
```

| columns | meaning |
| --- | --- |
| `score_id`, `beatmap_id`, `beatmap_set_id` | ids; any of them may be `null`, and the page then prints plain text instead of a link |
| `artist`, `title`, `version` | map identity, read from the `.osu` file |
| `keys`, `od` | key count and OD |
| `mods`, `mods_parts` | the raw mod string (`"DT+MR"`, `""` = NoMod) and the space-separated flags (`"DT MR"`, `"NM"`) |
| `accuracy`, `n320`…`miss` | accuracy in percent and the six judgement counts |
| `pp_bancho`, `pp_sunny`, `pp_codexxy`, `pp_reimagined` | one pp value per algorithm; `null` when that algorithm did not price the score |
| `star_bancho` | the official osu! star rating (the difficulty source behind Bancho's pp) |
| `star_sunny`, `star_rice` | Sunny's star rating and its rice variant — the difficulty sources behind Reimagined's R and L channels |
| `ln_ratio` | share of objects that are long notes, 0–1 |
| `l_share`, `w`, `coord_mod`, `eff_star`, `acc_factor`, `nf_factor` | the Reimagined internals |

**Unknown columns are ignored, missing optional columns render `–`, and extra `pp_*` columns are
picked up as additional algorithms** — so the engine can add an algorithm without a page change.
There is deliberately **no `creator` / `mapper` column in schema 3**: map identity is artist, title
and difficulty only. The page documents that fact wherever the absent field would otherwise be
mysterious (see "Search syntax").

## The two views

Navigation is hash routing; the rankings and a player are separate views, not a dropdown.

| URL | view |
| --- | --- |
| `#/players` | **Rankings**: every player in the index |
| `#/player/{uid}` | **Player**: one bp list in full |

Query keys: `q` (search), `sort`, `dir` (`asc` / `desc`), `a` (algorithm A), `b` (algorithm B).
**State lives in the URL**, so any view can be linked exactly as it looks — including the A/B pair,
which is written into every hash the page produces. A hash *without* `a`/`b` falls back to the
defaults (A = Bancho, B = Reimagined) rather than keeping whatever was on screen before, so a bare
`#/player/21207706` always opens the same thing. Typing in a search box rewrites the hash with
`replaceState`, so the back button is not flooded with one entry per keystroke.

The header carries `← Rankings`, and clicking anywhere on a rankings row (or pressing Enter on it)
opens that player.

### Rankings

One row per player, straight from `index.json` — **no shard is fetched for this view**:

* **Player** (`username #uid`) and **Scores**.
* Per algorithm: the **weighted total**, the player's **rank** in this dataset (1 = highest) with a
  `▲n` / `▼n` / `=` badge for the move against the anchor's rank, and **Δ** against the anchor as an
  absolute figure plus a percentage in the same cell. The anchor is Bancho, or A once A has been
  changed away from Bancho.
* Sortable on every column (numeric columns sort descending on the first click, text ascending);
  the default is Bancho's weighted total, descending.
* The player search uses the same syntax as the score search (see below).

Sorting re-renders only the table body and patches the header attributes in place, so hundreds of
players stay responsive; a keystroke in the search box is debounced by 120 ms.

### Player

Everything derived from the shard, all following the A/B pair:

1. **Totals** — one row per algorithm with the weighted total, the difference against A (absolute
   and relative), plus the explicit `A → B` line (`diff (B − A)`, `relative (B / A − 1)`, `ratio`).
2. **Scores** — the dense sortable table described below.
3. **Layer summary** — the median relative difference by layer.
4. **Where the algorithms disagree** — the largest normalised spread over all four algorithms
   (`(max − min) / mean`), each row expandable to the same detail block as the score table, beside a
   scatter of `ln_ratio` (x) against the relative difference of B vs A (y).

## Search syntax

The search box replaces what used to be three rows of filter chips. It follows
[osu!'s beatmap search](https://osu.ppy.sh/wiki/en/Beatmap_search): free text plus
`field<operator>value`, operators `=`, `==`, `:`, `!=`, `<`, `>`, `<=`, `>=`, all case-insensitive,
several terms **ANDed**. `:` means the same as `=`. Quote a value containing spaces:
`title:"eternal white"`.

* **Free text** matches artist, title, difficulty, mapper and the mod string of a score, or the
  username and uid of a player.
* **A numeric field** accepts every operator. **A text field** accepts `=` (exact, case-insensitive)
  and `!=`. A value that is not a number against a numeric field matches nothing.
* **A name the page does not know falls back to free text** (as osu!'s search does), so a typo
  narrows nothing instead of silently matching nothing.
* **A null value fails every operator, `!=` included** — "has no value" can never masquerade as a
  match.

The collapsible **Search syntax** panel next to the box lists every field with an example, and its
example chips are computed from the loaded shard (plus the ones quoted in the repository
instructions: `mod=DT key=4 star<7`, `lns>90`, `delta<-20`, `pp>500`).

### Score fields

| field | matches |
| --- | --- |
| `artist`, `title` | that field as free text |
| `diff`, `version` | difficulty name |
| `creator`, `mapper` | map creator — **the dataset does not carry one, so these match nothing**; the page says so in amber under the box rather than pretending |
| `key`, `keys` | key mode |
| `od` | overall difficulty |
| `ln`, `lns` | share of holds in **percent** (0–100), so `lns>90` reads naturally |
| `ln_ratio` | the same share as a 0–1 fraction |
| `mod`, `mods` | mod acronyms as substrings of `mods_parts`, so `mod=DT` also finds `"DT MR"`; `mod=NM` means no mods |
| `acc`, `accuracy` | accuracy in percent |
| `pp` | B's pp — the compared algorithm |
| `pp_bancho`, `pp_sunny`, `pp_codexxy`, `pp_reimagined` | a named algorithm's pp |
| `rank` | the score's rank under B (the current sort's default algorithm) |
| `delta` | B − A in pp |
| `rel` | `B / A − 1` in percent |
| `star`, `stars`, `sr`, `star_bancho`, `sr_bancho` | the official osu! star rating |
| `star_sunny`, `sr_sunny` | Sunny's star rating |
| `star_rice`, `sr_rice` | the rice star rating |
| `score_id`, `map_id`, `set_id` (+ `beatmap_id`, `beatmap_set_id`) | identifiers, compared as numbers |
| `eff_star`, `l_share`, `w`, `coord_mod`, `acc_factor`, `nf_factor` | Reimagined internals |

### Player fields (rankings view)

| field | matches |
| --- | --- |
| `uid` | osu! user id |
| `username`, `user`, `name` | the username (`=` exact, or free text) |
| `scores`, `score_count` | how many scores the dataset holds for that player |
| `fixture` | the fixture name |
| `pp`, `pp_<algo>` (`total_<algo>`, `total_pp_<algo>`) | weighted total |
| `rank`, `rank_<algo>` | rank over the players in this dataset |
| `delta`, `delta_<algo>` | total minus A |
| `rel`, `rel_<algo>` | total against A in percent |
| `move`, `move_<algo>` | rank movement against A (positive = climbs) |

`<algo>` is generated from `algorithms` / `total_pp`, so an added algorithm is searchable without a
page change. `pp`, `rank`, `delta`, `rel` and `move` without a suffix always mean "under B".

## Layers

Every layer family **partitions** the bp list, and only the buckets that actually occur are
rendered — as many layers as there are, no more, no fewer. A player whose list is entirely 4K gets a
single row.

| family | buckets (derived from the data) |
| --- | --- |
| key mode | 4K / 6K / 7K when present, plus *Other key modes* for anything else (including a missing key count) |
| mod family | *NM* (no mods), *Rate-up* (DT · NC), *Rate-down* (HT · DC), and *Other mods* — the remainder, which in the shipped dataset means MR / HD / SD |
| LN share (`ln_ratio`) | **RC** `ln_ratio < 0.10`, **HB** `0.10 ≤ ln_ratio ≤ 0.90`, **LN** `ln_ratio > 0.90`; a score with no `ln_ratio` gets its own *No ln_ratio* row |

Mods are matched as substrings of `mods_parts` (falling back to `mods`), because the engine emits
both `EZDT` and `EZDT V2` style strings.

The three LN cut-offs are the **only** LN split on the page: the same numbers appear in the layer
table, in the scatter's dashed reference lines, and in the per-score detail row. The earlier 0.05 /
0.35 cut-offs are gone. (They do differ in spirit from the research side's *rice / mix / LN* naming:
RC is "almost no holds", HB ("hybrid") is the middle, LN is "almost all holds".)

**The layer table is computed over the whole bp list and deliberately ignores the search box**;
filtering to one key mode would empty the other rows and the summary would stop describing the
player. The score table, the disagreement list and the scatter all follow the search. The table's
own caption says which is which.

## The score table

Columns in the owner's order, with the Reimagined internals in the expanded detail row:

| group | columns |
| --- | --- |
| rank first | `Rank B` (the default sort column, ascending), `Rank A`, `Shift` = rank B − rank A — positive means the score drops under B, highlighted from \|shift\| ≥ 4 and strongly from ≥ 10 |
| map identity | artist – title [difficulty], linked to `https://osu.ppy.sh/beatmapsets/{beatmap_set_id}#mania/{beatmap_id}`; underneath: difficulty, mapper (`mapper not in dataset` for schema 3), `b{beatmap_id} · s{beatmap_set_id}` |
| identity | `Keys`, `Mods` |
| the pp group | A's pp, B's pp, `Δ pp`, `Δ %` (B / A − 1), then the two algorithms that are neither A nor B |
| breakdown | `Acc %`, the six judgement counts 320 / 300 / 200 / 100 / 50 / miss, **`LN %`** (a percentage, not a fraction), `★ Bancho`, `★ Sunny` |

Clicking a row (or its `+` button, which carries `aria-expanded`) opens a detail block with four
sections:

* **Identity and links** — `score_id`, `beatmap_id`, `beatmap_set_id`, mapper, artist, title,
  version, keys / OD, both mod strings, and the osu! links.
* **Pp per algorithm** — every algorithm's pp with its delta against A and against the mean, the
  spread, `Δ B − A`, the B/A ratio, both ranks and the shift.
* **Accuracy and judgements** — accuracy, the counts, `ln_ratio` with its percentage, the LN bucket
  and both star ratings.
* **Reimagined internals** — `eff_star`, `★ rice`, `l_share`, `w`, `coord_mod`, `acc_factor`,
  `nf_factor`.

Numerals are monospace with `tabular-nums` and every numeric column is right-aligned; the header is
sticky; `aria-sort` tracks the active column; nulls sort last in either direction and render `–`.
`Show more` adds 150 rows at a time when a list is longer than that.

### osu! links

| link | form |
| --- | --- |
| map | `https://osu.ppy.sh/beatmapsets/{beatmap_set_id}#mania/{beatmap_id}` |
| score | `https://osu.ppy.sh/scores/{score_id}` |
| player | `https://osu.ppy.sh/users/{uid}` |

Only the map link needs two ids, and the page renders **plain text** when either is `null` — a
guessed or broken `href` is worse than none.

## Theme

The button in the header cycles **Auto → Light → Dark**, stores the choice in
`localStorage['mania-sr-pp.theme']`, and drives `color-scheme` plus `<html data-theme>`. *Auto*
follows `prefers-color-scheme`; the explicit states override it in both directions. The choice is
applied by a tiny inline script in `<head>`, before the first paint, so a reload does not flash the
wrong theme. Both palettes are complete — the stylesheet is written against tokens, and SVG text
uses `fill` rather than `color`, so the scatter and the sign colours are themed too.

## Keyboard

| key | action |
| --- | --- |
| `/` | focus the search box of the current view (and open the syntax panel on a player view) |
| `Esc` | clear that box and leave it |
| `Enter` | in the rankings search: open the first matching player |
| `Tab` / `Enter` / `Space` | rankings rows are focusable and open on Enter or Space |

Focus is always visible (`:focus-visible` outline), there is a skip link, table captions and
`scope` on headers, `aria-live` status text for the row counts, and a `prefers-reduced-motion` block.

## CSV export

**Export CSV** writes the current search and sort — not just the visible page — with a UTF-8 BOM so
Excel reads artist names correctly:

```text
SCORE_ID,BEATMAP_ID,BEATMAP_SET_ID,ARTIST,TITLE,VERSION,MAPPER,KEYS,OD,MODS,ACCURACY,
N320,N300,N200,N100,N50,MISS,STAR_BANCHO,STAR_SUNNY,STAR_RICE,LN_RATIO,L_SHARE,W,COORD_MOD,
EFF_STAR,ACC_FACTOR,NF_FACTOR,PP_BANCHO,PP_SUNNY,PP_CODEXXY,PP_REIMAGINED,
DIFF_PP,REL_PCT,RANK_BANCHO,RANK_REIMAGINED,RANK_SHIFT,SPREAD_REL_PCT,OSU_LINKS
```

`MAPPER` is empty for every row of a schema-3 dataset, which is the honest answer rather than a
missing column. `OSU_LINKS` carries the three osu! URLs space-separated. A rankings export exists in
the same shape (identity, then per algorithm the total, rank, delta, relative and move) but is not
wired to a button, because the rankings toolbar deliberately has a single control — `Reset`.

## Loading a file by hand

Drop a `.json` anywhere on the page, or use **Load index.json** in the header (the empty state has
its own button that opens the same picker). Two documents are accepted:

* an **index document** (`users` array) — its shards are still fetched from `data/…`, so this is a
  way to preview a freshly generated dataset without copying it into place;
* a **single player shard** (`columns` + `scores`) — rendered on its own, with the weighted totals
  derived from its scores using osu!'s 0.95 decay, and the totals panel says so.

Nothing is uploaded: the file is read in the browser with `FileReader`.

## Failing safely

| situation | what the page does |
| --- | --- |
| `data/index.json` missing or unreadable | the **empty state**: the exact reason (`HTTP 404`, `Failed to fetch`, a JSON parse error), the CLI command that produces the file, the drop zone and a file picker, and the four algorithm descriptions. No view is rendered at all |
| a player shard fails to load | the totals still render from the index, an error panel names the URL and the HTTP status and offers **Retry this player**; the per-score panels stay hidden |
| a player whose index entry has `0` scores | "This player has no scores" explains the empty list and says it is a normal state, not an error |
| a batch of scores has `null` pp for an algorithm | that cell shows `–`; the score is excluded from that algorithm's ranks, from the spread maths and from the diff |
| `null` ids | plain text instead of a link |
| unknown extra columns | ignored |
| missing optional columns | shown as `–`; the LN layer rows stay coherent and the scatter reports how many scores it skipped |
| a newer `schema_version` | a notice-bar warning; the fields it understands are rendered |
| a corrupted or non-JSON file is dropped | the failure is reported in the notice bar (or the empty state) and the rendered dataset is left alone |
| an unknown route or uid | falls back to the rankings / a plain page title, no error |

## Source layout

`app.js` is a single ES module, ~1 900 lines (~92 KB), organised in thirteen numbered sections so it
stays navigable: configuration, helpers, state and accessors, the search language, normalisation,
layers, tables, routing, panels, views, CSV, loading, events. **It is deliberately not split**: the
repository's file list stays minimal (four files), and every section is independent enough to be
found by its banner comment. If it grows past a comfortable size, the natural cut is
`app-search.js` (search language + field maps) plus `app.js`, loaded as two modules — the page
already uses `<script type="module">`, so nothing else would change.

## Verification

Verified against a temporary copy of `index.html`, `app.js`, `styles.css` and the published `data/`
directory, **outside the repository**, served with
`python -m http.server --directory <tmp>` and driven through Chromium (Playwright). A second copy
without `data/` served the empty state. Nothing was generated inside the repository, and no test
file, fixture or sample dataset was added to it.

What was actually run and observed:

* **Navigation** — `#/players` → click a row → `#/player/{uid}` → `← Rankings`; Enter on a focused
  row and Enter in the rankings search box both open the first match; `#/player/21207706` as a cold
  deep link opens Shirasu-Azusa with 100 scores; an unknown uid and an unknown route fall back
  without an error.
* **URL is state** — a pair-carrying link (`?a=sunny&b=codexxy`) reproduced Sunny vs Codexxy on a
  cold load, and the same URL without `a`/`b` opened Bancho vs Reimagined, proving the hash alone
  decides the page.
* **A/B** — the swap button, both dropdowns and the reset all followed through to the totals table,
  the score-table headers and `Δ` columns, the rank columns (Rank B then Rank A after a swap), the
  layer table and the scatter. Ranks were cross-checked against an independent ranking of the shard.
* **Derived totals** — the index's four totals for uid 21207706 reproduce exactly from the shard
  (`Σ pp_i · 0.95^i` per algorithm: 14923.947 / 14961.184 / 15021.095 / 14486.368).
* **Search** — 36 queries were run through the page and compared against an independent Python
  oracle reading the same shard; **every count agreed**, including `mod=DT key=4 star<7` (1 row:
  Andy Lau — Gong Xi Fa Cai, DT, 4K, `star_bancho` 6.922), `lns>90` (6), `delta<-20` (56),
  `pp>500` (100), `acc>=99 mod=NM` (13), `star<7` (16), `diff:extra` (2), `artist:camellia` (11),
  `ln_ratio<0.1` (2), `rank<=10` (10), `eff_star>7` (84), `coord_mod>1` (69), `pp_sunny>700` (42),
  and the case-insensitive free text (`ludicin` = `LUDICIN` = 7).
* **Empty results are honest** — `mod=NC`, `od>=9`, `l_share>0.5`, `nf_factor<1`, `w>1` and
  `score_id=567317304` (a Tre score, not this player's) all returned 0 and matched the oracle's 0;
  `mapper:foo` returned 0 and raised the amber "this dataset carries no map creator" note.
* **Layers** — for uid 21207706 the table rendered exactly the buckets present: key mode 4K (100);
  mod family NM 53 / Rate-up 33 / Rate-down 2 / Other 12; LN share RC 2 / HB 92 / LN 6; total 100.
  Every n and both medians matched the Python oracle exactly (e.g. LN median −2.03 %, median
  `pp_bancho` 741.96), and the LN buckets used the new 0.10 / 0.90 cut-offs (the old 0.05 / 0.35
  split gives 430 / 812 / 658 over the dataset instead of 710 / 1181 / 9).
* **Filter independence** — with `mod=DT` applied, the score table dropped to 19 of 100 rows and the
  scatter to 19 points, while the layer table stayed at the full 100-row rows, as documented.
* **Links** — a score detail showed
  `beatmapsets/2312406#mania/5088628`, `scores/5862454444` and `users/21207706`, and the CSV's
  `OSU_LINKS` column repeated all three.
* **CSV** — the export after a filter produced one row for one match, 38 columns, a UTF-8 BOM
  (`\uFEFF`), CRLF rows, both algorithm ids in the header, and the correct `RANK_BANCHO` (87) /
  `RANK_REIMAGINED` (93) / `RANK_SHIFT` (6) for that row.
* **Dark mode** — the cycle Auto → Light → Dark → Auto changed `data-theme`, `color-scheme`, the
  computed body background (`rgb(255,255,255)` → `rgb(20,22,26)`) and the text colour; an explicit
  Dark survived a reload with `localStorage` set, and Auto honoured the (light) system preference.
* **Keyboard** — `/` focused the score search (and opened the syntax panel), `Esc` cleared it and
  left the box, `Enter` in the rankings search opened the first match.
* **Sorting** — every header is clickable, `aria-sort` follows, first click on a numeric column
  sorts descending and clicking again flips it; on the rankings the same held for `username`,
  `delta:bancho` and `rank:codexxy`, and the URL kept the sort.
* **Paging** — verified with a temporary `PAGE_SIZE = 12` copy served on its own port: 24 of 100
  shown (the first page), `Show more (12 of 76 remaining)`, then 36 and 48; a sort reset the window
  to 12; a search reset it to 12 of 53.
* **Responsive** — at 390 × 800 the document did not scroll horizontally (`scrollWidth` 375 ≤ 390),
  the tables scrolled inside their own `.table-wrap`, the header buttons stacked, and the layout
  stayed legible.
* **Empty state** — the copy without `data/` showed "No dataset", the exact reason
  (`data/index.json is not available: HTTP 404 File not found.`), the CLI command, the drop zone,
  the four algorithm cards, no view, and `no dataset loaded` in the header. Its only console output
  was the browser's own 404 for the missing file.
* **Failing safely** — an index whose shard paths all 404 produced the error panel ("Could not read
  the scores of Shirasu-Azusa — data/players/missing-21207706.json — HTTP 404 File not found"), kept
  the four totals from the index, hid the per-score panels, and offered Retry; the same file with
  `schema_version: 99` and two warnings rendered with a notice-bar warning and the warnings listed
  in the footer; a lone player shard dropped on the empty page rendered a one-player rankings view
  and, when opened, totals derived from the shard with the panel saying so.
* **Console** — zero page errors and zero console errors across those runs, the only console entries
  being the browser's own 404s for deliberately missing files.

## GitHub Pages

Pages is configured on the remote side as **Deploy from a branch**, folder `/docs`; this repository
intentionally carries no Pages workflow. Because the published root *is* `docs/`, the site lives at
`https://<owner>.github.io/<repo>/` and `data/index.json` resolves next to `index.html`;
`docs/.nojekyll` keeps Pages from post-processing the directory, and Pages serves `.json` as
`application/json`. Publishing is: run the CLI, commit `docs/data/`, push.
