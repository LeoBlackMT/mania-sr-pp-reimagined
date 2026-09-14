# mania-sr-pp-reimagined — the site

A static, dependency-free viewer over the dataset the Rust engine writes. Four algorithms are priced on the same best-performance lists — **Bancho**, **Sunny**, **Codexxy** and **Reimagined** — and what the page makes readable is *where* they disagree, because that is what tells the algorithm author whether the three-channel split behaves.

| id | label | what it is |
| --- | --- | --- |
| `bancho` | **Bancho** | official osu! pp (osu!lazer mania): one fused strain rating, an accuracy term and a length bonus |
| `sunny` | **Sunny** | community algorithm by [Crz]sunnyxxy — repository *Star-Rating-Rebirth*; pattern and accuracy part only |
| `codexxy` | **Codexxy** | Sunny plus a map-based timing surface |
| `reimagined` | **Reimagined** | this project's three-channel R / L / A algorithm |

The repository's own positioning — that the algorithm is the product and this comparison is a by-product of validating it — lives in `README.md` and `AGENTS.md`, not on the page. The page says what it shows and nothing about why the repository exists.

No frameworks, no CDN, no build step, no test fixtures and no sample data. The site is a handful of ES modules under `docs/js/`:

```text
docs/index.html            the page shell: header, nav slot, empty state, the three views, the shared syntax panel, the footer
docs/styles.css            Linear's design tokens, both themes, the dense-table typography, the responsive rules
docs/js/main.js            entry point: builds the views, wires the page-wide events, boots
docs/js/core.js            state, algorithms, normalisation, layers, tables, the view registry + router, data loading
docs/js/format.js          numbers, strings, osu! links, CSV cells and file download
docs/js/search.js          the query language, the field maps and the syntax panel
docs/js/dom.js             element lookup for the page shell
docs/js/theme.js           Auto / Light / Dark, persisted
docs/js/views/players.js   #/players  — the rankings
docs/js/views/player.js    #/player/{uid} — one bp list in full
docs/js/views/dataset.js   #/dataset  — the whole dataset out of the index's aggregates
docs/web.md                this document
```

`docs/data/` is the published dataset, written by the engine — not part of the site source.

## Run it locally

GitHub Pages serves `docs/`, so **the site root is `docs/`** and every URL is relative: the index is fetched from `data/index.json` next to `index.html`. Serve that directory — a plain `file://` open cannot read sibling files, and the page says so instead of failing silently:

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
* Per-algorithm totals are weighted sums over *that algorithm's own ranking* of the player's scores (weight `0.95^n`) — what the profile would look like under that algorithm. No bonus PP.
* The CLI is offline and deterministic: re-running it over unchanged inputs is byte-identical.

## Data layout (`schema_version: 3`)

The dataset is split so a visitor downloads only what they look at. **The index is the only file loaded up front and a player's shard is fetched when that player is opened; nothing on the page ever downloads more than one shard.**

```text
docs/data/index.json            engine info, algorithm list, dataset-wide aggregates, one entry per player + weighted totals
docs/data/players/{uid}.json    that player's scores only, in columnar form (fetched on selection)
```

### `index.json`

```jsonc
{
  "schema_version": 3,
  "generated_at": "2026-09-14T04:12:33Z",
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
  "score_count": 32516,
  "aggregates": { /* optional, see below */ },
  "warnings": []
}
```

| field | required | behaviour when missing or different |
| --- | --- | --- |
| `schema_version` | no | anything other than `3` raises a notice-bar warning; **newer** versions still render the fields the page understands, older ones show `–` for what they lack |
| `generated_at`, `engine.*` | no | omitted from the header line, shown as `–` in the footer |
| `algorithms[].id` | no | ids are recovered from the `total_pp` / `pp_*` keys, and the four built-in ids still get their proper labels |
| `algorithms[].label` / `.description` | no | falls back to the built-in label of that id, and the card then says the dataset carries no description |
| `users[]` | no | an empty list renders "This dataset contains no players", never an error |
| `users[].fixture` | no | shown in the player header when present |
| `users[].file` | no | the shard is requested from `players/{uid}.json` |
| `users[].total_pp` | no | totals are derived from the shard with osu!'s 0.95 decay, and the panel says so |
| `users[].scores` | no | `0` means the shard is still fetched; an empty list renders its own explanation |
| `aggregates` | no | the whole `#/dataset` view falls back to a short explanation instead of rendering empty tables; the per-player views are unaffected |
| `warnings[]` | no | the footer lists them (first 25) |

### `aggregates`

Precomputed by the engine so the dataset-wide modules need no shard at all — at two hundred players the page still opens from one file:

```jsonc
"aggregates": {
  "score_count": 32516,
  "layers": [ { "family": "key mode|mod family|long notes", "layer": "7K|NM|Rate-up|Rate-down|Other mods|RC|HB|LN",
                "n": 800,
                "median_pp": { "bancho": 512.3, "sunny": 0.0, "codexxy": 0.0, "reimagined": 0.0 },
                "rel_pct":   { "bancho": { "sunny": 4.2, "codexxy": 1.1, "reimagined": 6.0 } } } ],
  "correlation": { "bancho": { "sunny": 0.993 } },                       // Pearson over per-score pp
  "distribution": { "bancho": { "n": 0, "min": 0, "max": 0, "p25": 0, "median": 0,
                                "p75": 0, "p95": 0, "bins": [24, 0], "bin_min": 0, "bin_max": 0 } },
  "top_disagreements": [ { "uid": 21207706, "score_id": 0, "beatmap_id": 0, "artist": "", "title": "",
                           "version": "", "mods": "DT", "keys": 4, "ln_ratio": 0.92,
                           "spread": 45.2, "pp": { "bancho": 0.0 } } ]
}
```

`rel_pct[a][b]` is the **median relative difference of b against a, in percent**, computed per layer over the scores both priced. It is not the ratio of two medians and the page never averages medians to produce it: the A/B column of the layer table is printed straight from this object, so switching A and B redraws every figure from the data rather than from a derived guess.

### `players/{uid}.json`

Column names appear once and every score is a plain array in that order:

```jsonc
{
  "schema_version": 3, "uid": 21207706, "username": "Shirasu-Azusa",
  "columns": ["score_id", "beatmap_id", "beatmap_set_id", "artist", "title", "version", "mapper", "keys",
              "od", "mods", "mods_parts", "accuracy", "n320", "n300", "n200", "n100", "n50", "miss",
              "pp_bancho", "pp_sunny", "pp_codexxy", "pp_reimagined",
              "star_bancho", "star_sunny", "star_rice", "ln_ratio", "l_share", "w", "coord_mod",
              "eff_star", "acc_factor", "nf_factor"],
  "scores": [ [6011663426, 5366651, 2455603, "Ludicin", "Blossom of Ashes", "Divination of Calamity",
               "gzdongsheng", 4, 7.3, "MR", "MR", 97.896, 5393, 2279, 179, 21, 14, 42,
               797.058, 803.566, 801.235, 790.792,
               8.119, 8.151, 6.979, 0.9215, 0.1438, 0.9806, 1.0322, 8.128, 0.9968, 1.0] ]
}
```

| columns | meaning |
| --- | --- |
| `score_id`, `beatmap_id`, `beatmap_set_id` | ids; any of them may be `null`, and the page then prints plain text instead of a link |
| `artist`, `title`, `version` | map identity, read from the `.osu` file — the difficulty lives in `version` alone, so the map cell never repeats it |
| `mapper` | difficulty author; `creator` is accepted as an alias, and a shard without either renders `mapper not in dataset` |
| `keys`, `od` | key count and OD |
| `mods`, `mods_parts` | the raw mod string (`"DT+MR"`, `""` = NoMod) and the space-separated flags (`"DT MR"`, `"NM"`) |
| `accuracy`, `n320`…`miss` | accuracy in percent and the six judgement counts |
| `pp_bancho`, `pp_sunny`, `pp_codexxy`, `pp_reimagined` | one pp value per algorithm; `null` when that algorithm did not price the score |
| `star_bancho` | the official osu! star rating (the difficulty source behind Bancho's pp) |
| `star_sunny`, `star_rice` | Sunny's star rating and its rice variant — the difficulty sources behind Reimagined's R and L channels |
| `ln_ratio` | share of objects that are long notes, 0–1 |
| `l_share`, `w`, `coord_mod`, `eff_star`, `acc_factor`, `nf_factor` | the Reimagined internals |

**Unknown columns are ignored, missing optional columns render `–`, and extra `pp_*` columns are picked up as additional algorithms** — so the engine can add an algorithm without a page change. Extra `star_*` columns are picked up the same way.

## The views

Navigation is hash routing; the three views are routes, not a dropdown, and the nav slot is filled from the view registry in `core.js`.

| URL | view |
| --- | --- |
| `#/players` | **Rankings**: every player in the index — **no shard is fetched** |
| `#/player/{uid}` | **Player**: one bp list in full, from that player's one shard |
| `#/dataset` | **Dataset**: the whole dataset, straight out of `aggregates` — **no shard is fetched** |

Query keys: `q` (search), `sort`, `dir` (`asc` / `desc`), `layout` (`grouped`; absent means the compact score table) and `a` / `b` (the algorithm pair). **State lives in the URL**, so any view can be linked exactly as it looks — including the pair, the layout and the search. A hash *without* `a`/`b` falls back to the defaults rather than keeping whatever was on screen before, so a bare `#/player/21207706` always opens the same thing. Typing in a search box rewrites the hash with `replaceState`, so the back button is not flooded with one entry per keystroke.

An unknown route or an unknown uid falls back to the rankings without an error.

### The A / B pair

A and B are global state: they decide every delta, every rank column and every layer figure on every view, so their two selects and the swap button live in the algorithms panel at the top of the page rather than inside one view's panel.

The defaults are **A = Reimagined** (the algorithm under discussion) and **B = Bancho** (the official one). Each of the two selects is filled from the dataset's algorithm list; a dataset with a single algorithm disables them, and a dataset with none at all says so instead of showing a first option as if it were a choice.

### Rankings

One row per player, straight from `index.json` — no shard is fetched for this view:

* **Player** (`username #uid`) and **Scores**.
* Per algorithm: the **weighted total**, the player's **rank** in this dataset (1 = highest) with a `▲n` / `▼n` / `=` badge for the move against the same player's rank under A, and **Δ** against A as an absolute figure plus a percentage in the same cell.
* Sortable on every column, **ascending on the first click** and descending only on a second click on the same column; the default is A's weighted total, descending.
* The player search uses the same syntax as the score search (see below).
* **Export CSV** writes the current sort and filter — every matching player, not the visible page.

Sorting re-renders only the table body and patches the header attributes in place, rows are rendered a page at a time behind **Show more**, and a keystroke in the search box is debounced by 120 ms.

### Player

Everything derived from the shard, all following the A/B pair:

1. **Totals** — one row per algorithm with the weighted total, the difference against A (absolute and relative), plus the explicit `A → B` line (`diff (B − A)`, `relative (B / A − 1)`, `ratio`).
2. **Scores** — the dense sortable table described below.
3. **Layer summary** — the median relative difference by layer, over the whole bp list.
4. **Where the algorithms disagree** — the largest normalised spread over all four algorithms (`(max − min) / mean`), each row expandable to the same detail block as the score table, beside a scatter of `ln_ratio` (x) against the relative difference of B vs A (y).

### Dataset

Everything on this view comes from `aggregates` in the index, so it costs one file and no shards:

1. **At a glance** — players, scores in the index, scores aggregated, the algorithms and the layer-row count.
2. **Layers over every player** — the engine's layer rows with `n`, the median price of A and of B, the difference between those two medians, and the A-against-B relative difference read from `rel_pct`. **Exactly the layers present, never an empty bucket.** Each family partitions the dataset, so the rows inside a family add up to the dataset size.
3. **A against B, layer by layer** — the same `rel_pct` as diverging bars, one per layer, so the layers where B pays more or less than A are visible at a glance.
4. **Price distributions** — one histogram per algorithm over a shared pp range (the y axis is the share of that algorithm's own scores, because the four do not price the same number of scores) with the median marked, plus an A-against-B overlay.
5. **Correlation** — the Pearson matrix over every score each pair both priced. The shading only encodes the third decimal; a grey cell is the same statistic made scannable, not a different one.
6. **Widest disagreements** — the scores the algorithms price most differently, ranked by spread over the mean. The beatmap name links to osu! by beatmap id and the player number links to `#/player/{uid}`. The aggregate block carries no beatmap set id, which is why the map link uses the short `/b/` form here.

When the index has no `aggregates`, this view renders one short explanation and nothing else.

### Calculator

`#/calc` prices one score with all four algorithms, in the browser, using the engine compiled to WebAssembly (`docs/wasm/mania_pp_wasm.js` plus its 660 KB `.wasm`, loaded lazily — a visitor who never opens this view never downloads it).

1. **Input** — drop or pick a `.osu` file, or paste its text; type the mods (`DT`, `DT+MR`, `NM`, anything `parse_mods` accepts) or use a chip; enter the six judgement counts.
2. **Generation** — a lazer score and a legacy one are priced with different judgement semantics, 3% to 20% apart on the same counts, so the form carries a `Lazer score` switch (on by default) that decides which one Bancho uses; the other three algorithms do not depend on it.
3. **Result** — one card per algorithm with its pp and its relative difference against B, then a detail grid with the map facts (mapper, key mode, OD/HP, objects and holds, the three star ratings) and the Reimagined internals (`eff_star`, `w`, `coord_mod`, `l_share`, `acc_factor`, `nf_factor`).
3. **The judgement line** explains how the counts relate to the map: a mania play judges each note once and each hold twice — head and tail — so a score's counts add up either to the object count or to the object count plus the holds, which is the larger denominator osu! itself uses for such a score.

The numbers are the same code path that produced `data/players/*.json`: pricing a published score here reproduces the dataset's value to its three-decimal rounding.

It also works when the dataset cannot be loaded: the view declares `needsData: false`, so a visitor with a `.osu` file and no `index.json` still gets four pp values. What it cannot do is fetch — osu!'s score pages and `.osu` endpoints send no `Access-Control-Allow-Origin` header and the API needs a token the page cannot hold, which is why the file has to come from the visitor's own osu! folder. The FAQ in [`usage.md`](usage.md) records the measurements behind that.

## Search syntax

The search box replaces what used to be three rows of filter chips. It follows [osu!'s beatmap search](https://osu.ppy.sh/wiki/en/Beatmap_search): free text plus `field<operator>value`, all case-insensitive, several terms **ANDed**. Quote a value containing spaces: `title:"blossom of ashes"`.

| operator | meaning |
| --- | --- |
| `=` `:` | **fuzzy.** For a text field the value is a case-insensitive substring; for `mod` / `mods` it means "this score carries that mod", so `mod=DT` also finds `DT+MR` |
| `==` | **exact.** For a text field the whole value has to be equal (case-insensitively); for `mod` / `mods` only a score whose mods are exactly that set matches, so `mod==DT` excludes `DT+MR`. Separators are ignored on both sides, so `DT+MR`, `DT MR` and `DTMR` are one value |
| `!=` `<` `>` `<=` `>=` | unchanged: not-equal, and the four orderings |

On a numeric field `=` and `==` are both numeric equality, because a substring of a number is not something anybody means.

Two more rules keep the box honest:

* **A name the page does not know falls back to free text** (as osu!'s search does), so a typo narrows nothing instead of silently matching nothing.
* **A null value fails every operator, `!=` included** — "has no value" can never masquerade as a match.
* A field this dataset cannot satisfy — the map creator, when the shard carries no `mapper` column — is reported in amber under the box rather than quietly matching nothing.

The collapsible **Search syntax** panel is shared by both searchable views and lists every field with an example; its example chips are computed from the loaded shard (plus the ones quoted in the repository instructions: `mod=DT key=4 star<7`, `mod==DT`, `lns>90`, `delta<-20`, `pp>500`). `/` opens the panel and focuses the box.

### Score fields

| field | matches |
| --- | --- |
| `artist`, `title` | that field as free text |
| `diff`, `version` | difficulty name |
| `creator`, `mapper` | map creator — the shard's `mapper` column, or nothing when the dataset has no such column |
| `key`, `keys` | key mode |
| `od` | overall difficulty |
| `ln`, `lns` | share of holds in **percent** (0–100), so `lns>90` reads naturally |
| `ln_ratio` | the same share as a 0–1 fraction |
| `mod`, `mods` | fuzzy "carries this mod", exact mod set with `==`; `mod=NM` means no mods |
| `acc`, `accuracy` | accuracy in percent |
| `n320`, `n300`, `n200`, `n100`, `n50`, `miss` | one judgement count |
| `pp`, `pp_<algo>` | the pp of B, or of a named algorithm |
| `rank`, `rank_<algo>` | the score's rank under B, or under a named algorithm |
| `delta` | B − A in pp |
| `rel` | `B / A − 1` in percent |
| `spread` | max − min pp over every algorithm that priced the score |
| `star`, `stars`, `sr` | the star rating — the official one when the shard carries it, otherwise the first star column it does |
| `star_<x>`, `sr_<x>` | a named star column (`star_bancho`, `sr_sunny`, `star_rice`, …) |
| `score_id`, `map_id`, `set_id` (+ `beatmap_id`, `beatmap_set_id`) | identifiers, compared as numbers |
| `eff_star`, `l_share`, `w`, `coord_mod`, `acc_factor`, `nf_factor` | Reimagined internals |

### Player fields (rankings view)

| field | matches |
| --- | --- |
| `uid` | osu! user id |
| `username`, `user`, `name` | the username (fuzzy, or exact with `==`) |
| `scores`, `score_count` | how many scores the dataset holds for that player |
| `fixture` | the fixture name |
| `pp`, `pp_<algo>` (`total_<algo>`, `total_pp_<algo>`) | weighted total |
| `rank`, `rank_<algo>` | rank over the players in this dataset |
| `delta`, `delta_<algo>` | total minus A |
| `rel`, `rel_<algo>` | total against A in percent |
| `move`, `move_<algo>` | rank movement against A (positive = climbs) |

`<algo>` is generated from `algorithms` / `total_pp`, so an added algorithm is searchable without a page change. `pp`, `rank`, `delta`, `rel` and `move` without a suffix always mean "under B".

## Layers

Every layer family **partitions** the bp list, and only the buckets that actually occur are rendered — as many layers as there are, no more, no fewer. A player whose list is entirely 4K gets a single row.

| family | buckets (derived from the data) |
| --- | --- |
| key mode | 4K / 6K / 7K when present, plus *Other key modes* for anything else (including a missing key count) |
| mod family | *NM* (no mods), *Rate-up* (DT · NC), *Rate-down* (HT · DC), and *Other mods* — the remainder |
| LN share (`ln_ratio`) | **RC** `ln_ratio < 0.10`, **HB** `0.10 ≤ ln_ratio ≤ 0.90`, **LN** `ln_ratio > 0.90`; a score with no `ln_ratio` gets its own *No ln_ratio* row |

Mods are matched as substrings of `mods_parts` (falling back to `mods`), because the engine emits both `EZDT` and `EZDT V2` style strings.

The three LN cut-offs are the **only** LN split on the page: the same numbers appear in the layer tables, in the scatter's dashed reference lines, and in the per-score detail row.

**The player's layer table is computed over the whole bp list and deliberately ignores the search box**; filtering to one key mode would empty the other rows and the summary would stop describing the player. The score table, the disagreement list and the scatter all follow the search. The dataset view's layer table covers every score in the dataset by construction.

## The score table

Two layouts, switched by the segmented control in the panel head. The choice is part of the view state and therefore lives in the hash (`layout=grouped`; the compact layout is the default and writes nothing).

**Compact** — the owner's column order and nothing else:

| # | column | notes |
| --- | --- | --- |
| 1 | `Rank A` | the score's rank in the whole bp list ordered by A — **the default sort, ascending** |
| 2 | `Rank B` | the same under B |
| 3 | `Shift` | rank B − rank A; positive means the score drops under B, highlighted from \|shift\| ≥ 4 and strongly from ≥ 10 |
| 4 | `Beatmap` | artist – title, linked to `https://osu.ppy.sh/beatmapsets/{set}#mania/{id}`; underneath, `[difficulty] · mapped by <mapper>` — **the difficulty appears once and the title never re-embeds it**; the ids are in the cell's tooltip and in the expanded detail row |
| 5… | `★ Bancho`, `★ <algorithm>` | Bancho's star plus one per algorithm whose star column the shard actually publishes, in algorithm order; a shard with no star column gets no star column |
| … | `Keys`, `OD`, `LN %` | key mode, overall difficulty, share of holds in percent |
| … | `PP A`, `PP B`, `Δ (B−A)`, `Δ %` | the pair in play |
| … | `Acc %` | accuracy in percent |
| … | `320 300 200 100 50 miss` | the six judgement counts, each sortable |
| … | `Mods` | the mod acronym as the engine reports it |

**Grouped** — the same skeleton with the whole pp group side by side (`PP Bancho`, `PP Sunny`, `PP Codexxy`, `PP Reimagined`, in algorithm order) and the detail columns appended inline: any remaining star column, `Score id`, `L share`, `w`, `coord`, `eff ★`, `acc f.`, `nf f.`. It is the wide table the compact layout exists to replace.

Every header is sortable, and **a first click always sorts ascending**; only a second click on the same column flips it to descending. Nulls sink to the bottom in either direction and render `–`. Clicking a row (or its `+` button, which carries `aria-expanded`) opens a detail block with four sections:

* **Identity and links** — `score_id`, `beatmap_id`, `beatmap_set_id`, mapper, artist, title, version, keys / OD, both mod strings and the osu! links.
* **Pp per algorithm** — every algorithm's pp with its delta against A and against the mean, the spread, `Δ B − A`, the B/A ratio, both ranks and the shift.
* **Accuracy and judgements** — accuracy, the counts, `ln_ratio` with its percentage, the LN bucket and every star rating the shard carries.
* **Reimagined internals** — `eff_star`, `l_share`, `w`, `coord_mod`, `acc_factor`, `nf_factor`.

Column widths are fixed for the narrow columns (rank, shift, stars, keys, OD, LN %, the counts, mods) and flexible for the beatmap column, which ellipsises: the compact table fits a 1280 px viewport without scrolling its wrapper, and on a narrower screen the table scrolls inside `.table-wrap` instead of moving the page. Numerals are mono with `tabular-nums` and every numeric column is right-aligned. `Show more` adds 150 rows at a time.

### osu! links

| link | form |
| --- | --- |
| map | `https://osu.ppy.sh/beatmapsets/{beatmap_set_id}#mania/{beatmap_id}` (the dataset view's disagreement rows use `https://osu.ppy.sh/b/{beatmap_id}`, which needs one id) |
| score | `https://osu.ppy.sh/scores/{score_id}` |
| player | `https://osu.ppy.sh/users/{uid}` |

Only the map link needs two ids, and the page renders **plain text** when either is `null` — a guessed or broken `href` is worse than none.

## Look and feel

The design system is **Linear's**, applied with the documented values: the dark palette is canonical (canvas `#010102` with its faint blue tint, the four-step surface ladder `#0f1011` → `#141516` → `#18191a` → `#191a1b`, hairlines `#23252a` / `#34343a` / `#3e3e44`, ink `#f7f8f8` / `#d0d6e0` / `#8a8f98` / `#62666d`), lavender `#5e6ad2` is the only chromatic accent and stays scarce — brand mark, the one primary call to action, the focus ring, link emphasis — and hierarchy comes from the surface ladder plus 1px hairlines. **There are no gradients and no drop shadows anywhere in the stylesheet.** Depth that used to be a shadow is a hairline; depth that used to be a raised row is a surface step.

Radii are Linear's scale (buttons and inputs 8 px, cards 12 px, pills only for the genuinely pill-shaped layout toggle, the A/B role badges and the example chips). Type uses Linear's substitutes — Inter with the `SF Pro Display, -apple-system, system-ui` fallback for text, JetBrains Mono with the `ui-monospace, SF Mono, Menlo` fallback for every number, id and code token — with negative letter-spacing on the display sizes and `+0.4px` on the eyebrows.

Two deliberate departures from Linear's marketing system, both because this is a tool rather than a landing page:

* **Light mode exists.** Linear's marketing site is dark-only, so light mode is derived from the documented `inverse-*` tokens (canvas `#ffffff`, surfaces `#f5f6f6` and `#f6f7f7`, ink `#000000`) with the same lavender accent; the few values Linear does not publish for light surfaces are marked `derived` in the stylesheet.
* **No second chromatic accent, and no red.** The algorithms are therefore not colour-coded: they are told apart by name, by the mono A/B badges and, in the charts, by fill versus outline. A positive difference takes the documented `semantic-success` green; a decline keeps full ink and its explicit minus sign, because Linear documents no danger colour and inventing one would be the second accent the system forbids.

The button in the nav cycles **Auto → Light → Dark**, stores the choice in `localStorage['mania-sr-pp.theme']`, and drives `color-scheme` plus `<html data-theme>`. *Auto* follows `prefers-color-scheme`; the explicit states override it in both directions. The choice is applied by a tiny inline script in `<head>`, before the first paint, so a reload does not flash the wrong theme.

## Keyboard

| key | action |
| --- | --- |
| `/` | focus the search box of the current view and open the syntax panel |
| `Esc` | clear that box and leave it, or close the syntax panel |
| `Enter` | in the rankings search: open the first matching player |
| `Tab` / `Enter` / `Space` | rankings rows are focusable and open on Enter or Space |

Focus is always visible (a 2 px `primary-focus` outline at 50 % opacity, Linear's documented focus treatment), there is a skip link, table captions and `scope` on headers, `role="status"` on the row counts, and a `prefers-reduced-motion` block.

## CSV export

**Export CSV** on the scores panel writes the current search and sort — not just the visible page — with a UTF-8 BOM so Excel reads artist names correctly:

```text
SCORE_ID,BEATMAP_ID,BEATMAP_SET_ID,ARTIST,TITLE,VERSION,MAPPER,KEYS,OD,MODS,ACCURACY,
N320,N300,N200,N100,N50,MISS,STAR_BANCHO,STAR_SUNNY,STAR_RICE,LN_RATIO,L_SHARE,W,COORD_MOD,
EFF_STAR,ACC_FACTOR,NF_FACTOR,PP_BANCHO,PP_SUNNY,PP_CODEXXY,PP_REIMAGINED,
DIFF_PP,REL_PCT,RANK_REIMAGINED,RANK_BANCHO,RANK_SHIFT,SPREAD_REL_PCT,OSU_LINKS
```

**Export CSV** on the rankings toolbar writes the current sort and filter of the players — `UID, USERNAME, SCORES`, then per algorithm the total, the rank, the delta against A, the relative difference and the rank move against A — into `players_{A}_vs_{B}.csv`. Both buttons confirm the row count on the button itself.

## Loading a file by hand

Drop a `.json` anywhere on the page, or use **Load index.json** in the nav (the empty state has its own button that opens the same picker). Two documents are accepted:

* an **index document** (`users` array) — its shards are still fetched from `data/…`, so this is a way to preview a freshly generated dataset without copying it into place;
* a **single player shard** (`columns` + `scores`) — rendered on its own: the rankings name the algorithms the shard carries, the weighted totals are derived from its scores with osu!'s 0.95 decay, the panel says so, and the page never tries to fetch a shard it was handed.

Nothing is uploaded: the file is read in the browser with `FileReader`.

## Failing safely

| situation | what the page does |
| --- | --- |
| `data/index.json` missing or unreadable | the **empty state**: the exact reason (`HTTP 404`, `Failed to fetch`, a JSON parse error), the CLI command that produces the file, the drop zone and a file picker, and the algorithm cards. No view is rendered at all |
| a player shard fails to load | the totals still render from the index, an error panel names the URL and the HTTP status and offers **Retry this player**; the per-score panels stay hidden |
| a player whose index entry has `0` scores | "This player has no scores" explains the empty list and says it is a normal state, not an error |
| a batch of scores has `null` pp for an algorithm | that cell shows `–`; the score is excluded from that algorithm's ranks, from the spread maths and from the diff |
| `null` ids | plain text instead of a link |
| unknown extra columns | ignored |
| missing optional columns | shown as `–`; the LN layer rows stay coherent and the scatter reports how many scores it skipped |
| a newer `schema_version` | a notice-bar warning; the fields it understands are rendered |
| no `aggregates` | the dataset view explains that the block is absent and renders nothing else |
| a corrupted or non-JSON file is dropped | the failure is reported in the notice bar (or the empty state) and the rendered dataset is left alone |
| an unknown route or uid | falls back to the rankings, no error |

## Extending it: adding a view

`core.js` keeps a view registry. A view is a descriptor, and nothing else in the page has to change — the nav slot, the router, the document title and the fallback all read from it:

```js
registerView({
  id: 'calc',                       // the route segment: #/calc
  label: 'Calculator',              // the nav label, or null to stay out of the nav
  needsData: false,                 // false for a view that does not read the dataset, so it still works when index.json cannot be loaded
  needsShard: false,                // true when the view renders one player's scores, so the router loads that shard
  parse: (q, arg) => ({ q: q.q ?? '' }),   // hash query + path argument -> this view's state, or null to fall back
  path: () => '#/calc',             // the hash path, without the query
  title: () => 'Calculator — mania-sr-pp-reimagined',
  render: (view) => { /* draw it */ },
  sync: (view) => { /* push state into the view's own controls; only called on a route change, so typing is never interrupted */ },
});
```

The calculator described above is exactly that: one `registerView` call plus `docs/js/views/calc.js`, imported from `main.js`, and the only change the registry needed was the `needsData` flag, which lets a view opt out of the dataset requirement. The registry is the contract, and this section is the only place the page needs to be honest about it.

## Verification

Verified against temporary copies of the whole `docs/` directory, **outside the repository**, served with `C:\Users\Leo_BlackLT\Desktop\Dev\py\.venv\Scripts\python.exe -m http.server` and driven through Chromium (Playwright). Five copies were served at once:

| copy | port | what it is |
| --- | --- | --- |
| full | 8181 | `docs/` as published |
| no data | 8182 | the same, with `data/` removed |
| degraded | 8183 | `aggregates` deleted from `index.json` and `schema_version` bumped to `99` |
| edge | 8184 | one index entry pointing at a shard file that does not exist, and one player whose shard has zero scores |
| paged | 8185 | identical except `PAGE_SIZE` is 12, so the incremental rendering is actually exercised |

Nothing was generated inside the repository, and no test file, fixture or sample dataset was added to it. The oracle the search counts were checked against was an independent Python script (in the temporary directory, since deleted) that re-implemented the operators directly over the shard JSON.

What was actually run and observed:

* **Network discipline** — a cold load of `#/dataset` requested exactly `styles.css`, nine modules and `data/index.json`: **no shard**. `#/players` requested nothing beyond the index. `#/player/13313526` requested the index plus exactly one shard. Switching players twice requested two shards and rendered the second, with no error panel: a stale response is dropped.
* **Defaults** — the rankings opened on `#/players` with A = Reimagined, B = Bancho and `pp:reimagined` descending; the score table opened on `rank:reimagined` **ascending** with the first row at rank 1 and the last at rank 100; the panel note read "A = Reimagined · B = Bancho — Δ columns are B − A, ranks under A come first".
* **Ascending-first sorting** — `Shift` sorted ascending on the first click (−37 → +25) and descending on the second (+25 → −37); `PP B` did the same (571.14 → 824.41, then reversed); the text column `Mods` sorted ascending (DT → NM); `Rank A`, already active, flipped ascending → descending (first row 1 → 100) → ascending.
* **Map cell** — the first row of uid 21207706 reads `Ludicin – Blossom of Ashes` linked to `beatmapsets/2455603#mania/5366651`, with `[Divination of Calamity] · mapped by gzdongsheng` underneath. The difficulty appears once; the duplicated `[Divination of Calamity] [Divination of Calamity]` is gone.
* **Compact column order** — exactly 22 columns in the required order: expand, `Rank A`, `Rank B`, `Shift`, `Beatmap`, `★ Bancho`, `★ Sunny`, `Keys`, `OD`, `LN %`, `PP A`, `PP B`, `Δ (B−A)`, `Δ %`, `Acc %`, `320`, `300`, `200`, `100`, `50`, `miss`, `Mods`.
* **Star columns** — the shard publishes `star_bancho`, `star_sunny` and `star_rice`; the table rendered `★ Bancho` and `★ Sunny` (one per algorithm that has such a column) and left `star_rice` to the detail row and to search, where `star_rice` / `sr_rice` are live fields. A shard with no star column renders no star columns at all.
* **Grouped layout** — the toggle replaced `PP A` / `PP B` with `PP Bancho`, `PP Sunny`, `PP Codexxy`, `PP Reimagined` in algorithm order and appended `★ rice`, `Score id`, `L share`, `w`, `coord`, `eff ★`, `acc f.`, `nf f.`; `layout=grouped` appeared in the hash and disappeared again on the way back; `eff ★` for the first row read 8.128.
* **Search semantics** — 25 queries were run through the page and compared against the Python oracle over the same shard (uid 21207706, 100 scores). **Every count agreed**: `mod=DT` 33, `mod==DT` **19**, `mod:DT` 33, `mod=NC` 0, `mod=NM` 53, `mod==NM` 53, `key=4` 100, `star<7` 16, `lns>90` 6, `ln_ratio<0.1` 2, `delta<-20` 0, `rel>0` 88, `rank<=10` 10, `rank_reimagined<=10` 10, `acc>=99 mod=NM` 13, `pp>700` 42, `pp_sunny>700` 42, `eff_star>7` 84, `miss>0` 98, `mod=DT key=4 star<7` 2, `od>=9` 0, `mapper=gzdongsheng` 3, `mapper==gzdongsheng` 3, `title=ashes` 1, `title==ashes` 0. The fuzzy/exact pair differs on the shard that carries a compound mod (`mod=DT` 48 vs `mod==DT` 47 for uid 10790649) and agrees where it must (64/64 for uid 1002726, 0/0 for uid 13313526, which has only HT and NM).
* **Dataset view** — `#/dataset` rendered 10 layer rows across 3 families with the medians and the A/B relative read from `rel_pct` (4K `+3.65%`, 7K `−5.39%`, HB `+0.33%`, …), a 10-bar diverging chart whose bars sit on the correct side of the zero line, five histogram cards over a shared pp domain with the A/B overlay drawn as a step line, the 4 × 4 Pearson matrix (`Bancho × Sunny` 0.9949, `Codexxy × Reimagined` 0.9865 …) and all 60 disagreement rows, the first linking to `https://osu.ppy.sh/b/4498837` and to `#/player/13313526`.
* **Degrading without aggregates** — the same view on port 8183 showed the schema-99 notice bar, the footer's `schema version = 99`, the short "No dataset-wide aggregates in this index" explanation instead of the modules, and the rankings and player views still rendered all 19 players. Zero console errors.
* **Empty state** — the copy without `data/` showed "No dataset", the exact reason (`data/index.json is not available: HTTP 404 File not found.`), the CLI command, the drop zone, `no dataset loaded` in the header and no view at all. Its only console output was the browser's own 404 for the missing file.
* **Failing safely** — the edge copy's missing shard produced "Could not read the scores of Shirasu-Azusa — data/players/missing-21207706.json — HTTP 404 File not found" and kept the four totals from the index; the zero-score player produced "Cyfer has no scores in this dataset (the index lists 0)" with no retry button, because it is not an error.
* **Hand-loaded files** — a lone shard dropped on the empty page rendered a one-player rankings that named all four algorithms, and opening it showed the totals derived from the shard with the panel saying so (Bancho 8,711.2 / Sunny 8,505.3 / Codexxy 8,367.6 / Reimagined 8,568.9) and `#/player/1002726?a=reimagined&b=bancho` in the hash. A corrupted file was reported in the notice bar ("Expected property name or '}' in JSON at position 2") and left the rendered dataset alone.
* **CSV** — the rankings export wrote 19 rows + header, and with `rank<5` applied it wrote the 4 matching rows; the scores export with `mod==DT` applied wrote **19 rows**, matching the oracle. Both files carried a UTF-8 BOM, CRLF rows and no trailing blank row, with 23 and 38 columns respectively; `OSU_LINKS` held all three URLs and `MAPPER` was populated (`NineSey`).
* **Paging** — on the `PAGE_SIZE = 12` copy the rankings showed 12 of 19 rows with `Show more (7 of 7 remaining)`, then all 19 and no button, and a sort put the window back to 12; the score table went 12 of 100 → 24 → and back to 12 of 33 when `mod=DT` was typed, while the layer table stayed at the full 100 and the scatter followed the search to 33 dots. The export during paging still carried all 19 players.
* **Deep links** — `#/player/13313526?a=sunny&b=codexxy&sort=pp%3Acodexxy&dir=desc&layout=grouped&q=mod%3DDT` reproduced every one of those on a cold load; `#/player/13313526` alone opened Reimagined against Bancho, compact, `rank:reimagined` ascending and an empty box; `#/player/99999999` and `#/nope` both fell back to the rankings without an error.
* **Keyboard** — `/` focused the rankings search and opened the syntax panel, typing filtered to 1 of 19 players, `Esc` cleared the box and blurred it, `Enter` opened the first match (`#/player/10790649?a=reimagined&b=bancho`), and the `mod==DT` example chip wrote itself into the current view's box and reported 47 matches.
* **Theme** — the cycle went auto → Light → Dark → auto, changing `data-theme`, `color-scheme` and the computed body colours (`rgb(255,255,255)` ↔ `rgb(1,1,2)` / `rgb(247,248,248)`), and a `data-theme="dark"` written to `localStorage` was applied by the pre-paint script after a reload.
* **Layout widths** — at 1280 px the compact score table is 1151 px inside a 1151 px wrapper, i.e. it fits without scrolling; at 1440 the beatmap column grows to 218 px; at 1024, 768 and 390 the table scrolls inside its wrapper and the document itself never scrolls horizontally (375 ≤ 390 at the narrowest).
* **Console** — zero errors and zero page errors across seven routes of the full copy, three of the degraded copy and two of the paged copy. The only console entries anywhere were the browser's own 404s for the two files that were deliberately missing.

## GitHub Pages

Pages is configured on the remote side as **Deploy from a branch**, folder `/docs`; this repository intentionally carries no Pages workflow. Because the published root *is* `docs/`, the site lives at `https://<owner>.github.io/<repo>/` and `data/index.json` resolves next to `index.html`; `docs/.nojekyll` keeps Pages from post-processing the directory, and Pages serves `.json` as `application/json`. Publishing is: run the CLI, commit `docs/data/`, push.
