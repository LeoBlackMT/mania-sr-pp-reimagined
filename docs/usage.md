# Usage

## Requirements

Rust stable 1.77 or newer (the toolchain file pins the channel), and beatmap files (`.osu`) for the maps you want to compare, supplied from a local cache directory.

This repository deliberately contains **no build artefacts, no local caches, no test files and no untracked files**: every tracked file is either source, documentation, the specification, a fixture or the published dataset. That has two practical consequences:

```bash
# 1. build output goes outside the repository so `git status` stays clean
export CARGO_TARGET_DIR=../_build/mania-sr-pp-reimagined     # PowerShell: $env:CARGO_TARGET_DIR
cargo build --release

# 2. verification runs from the research repository (see "Verification")
```

## Layout

```
Cargo.toml                  workspace
rust-toolchain.toml         pinned toolchain channel
spec/spec.json              tunable specification, exported from the research repository
crates/mania-pp-spec/       typed access to the specification (embedded at compile time)
crates/mania-pp-algorithms/ the four algorithms (bancho/, sunny/, codexxy/, reimagined/, shared/)
crates/mania-pp-cli/        fixture -> comparison dataset
fixtures/                   bp-list fixtures (score lists, no map data)
docs/                       the static comparison site AND the documentation
```

**`crates/` in one line each.** `mania-pp-spec` holds nothing but the tunables (no logic): it embeds `spec/spec.json` and exposes it as typed structs. `mania-pp-algorithms` holds the four algorithms, one directory per algorithm, plus `shared/` for infrastructure they all need (currently the rice variant of a beatmap) and `lib.rs` for the shared surface — parse a map once, then price any number of scores against it. `mania-pp-cli` is the only binary: fixtures in, dataset out, plus `--bench`.

**`spec/` in one line.** It is the seam between the two repositories. The Python research repository owns the specification; its `scripts/export_engine_spec.py` writes `spec/spec.json` here; this crate embeds that file at compile time. Nothing in the file is hand-maintained, so a knob cannot drift between the research reference and the engine.

**`fixtures/` vs `docs/data/`.** `fixtures/` holds **inputs**: one small TSV (or JSON) of scores — who played which map with which mods and what judgement counts they got. `docs/data/` holds **outputs**: the computed PP of every score under all four algorithms, ready to be served. Nothing in `fixtures/` is derived; nothing in `docs/data/` is authored by hand. Beatmaps are in neither: they are copyrighted and large, so they stay in a local cache outside the repository and are passed with `--maps`.

## Fixtures

A fixture is a score list plus out-of-repository beatmaps.

```
fixtures/
  bp-lists.tsv      the fixture itself, tracked
  README.md         provenance of the players and how to regenerate the list
maps/               NOT here: keep the .osu cache outside the repository
```

Score list, tab separated (a header row is auto-detected and skipped):

```
uid	username	map_id	mods	320	300	200	100	50	miss	score_id	lazer
21207706	Shirasu-Azusa	3449961	DT	5200	210	14	2	0	1	6057128346	1
```

`mods` uses the usual acronyms, joined with `+` (`DT+MR`, `HDHR`) or unseparated (`EZDTV2`) — both are accepted. `score_id` is optional (it feeds the `osu.ppy.sh/scores/{id}` link on the site) and may be empty. `lazer` is optional too: `1` for a lazer score, `0` for a legacy one, and empty when unknown, which the engine reads as lazer. It exists because osu! prices the two score generations with different judgement semantics — 3% to 20% apart on identical counts — so Bancho's column cannot be right for both without it. Map metadata (artist, title, version, key count, OD, HP, beatmapset id) is read from the `.osu` file, never from the fixture.

**Typing a tab**: the separator is a literal tab character, produced with the <kbd>Tab</kbd> key — not spaces and not `\t`. In Excel or LibreOffice, save as "Text (Tab delimited)" if you build a fixture by hand; in VS Code, check that "Insert Spaces" is off and press <kbd>Tab</kbd> (or use <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> → "Convert Indentation to Tabs", which is a different thing but shows the distinction), and in a terminal use <kbd>Ctrl</kbd>+<kbd>V</kbd> then <kbd>Tab</kbd> in some shells. Tab was chosen over a comma precisely because osu! metadata is full of commas: with tabs a row is a plain `split('\t')` and no quoting rules are needed.

The JSON form is equivalent:

```json
{ "users": [ { "uid": 21207706, "username": "Shirasu-Azusa",
  "scores": [ { "map_id": 3449961, "mods": "DT", "counts": [5200, 210, 14, 2, 0, 1] } ] } ] }
```

**TSV or CSV?** They are the same idea with different separators: CSV is comma-separated and TSV is tab-separated. This project uses TSV for fixtures because osu! metadata is full of commas — artist names, difficulty names like `[4K] Foo, Bar` — so a comma-separated file would need quoting rules for nearly every row. With tabs, a row is a plain `split('\t')` and a hand-edited file stays readable. CSV is used where a human opens the result in a spreadsheet; the site's "export" button produces CSV for exactly that reason.

## Running the comparison

```bash
cargo run --release -p mania-pp-cli -- \
  --fixture fixtures/bp-lists.tsv \
  --maps    /path/to/osu/map/cache \
  --out     docs/data \
  --bench
```

| Option | Meaning |
|---|---|
| `--fixture <path>` | score list (TSV or JSON), required |
| `--maps <dir>` | directory containing `{map_id}.osu`, required |
| `--out <dir\|file>` | dataset location (default `docs/data`) |
| `--limit N` | only the first `N` scores per user |
| `--min-bancho-total P` | drop players whose Bancho weighted total is below `P` pp (default 1000) |
| `--bench` | print per-algorithm single-score timings |
| `--quiet` | no console summary |

The console prints, per player, the weighted total of each algorithm and the delta against Bancho.

Players below `--min-bancho-total` are dropped before anything is written: a bp list below that floor prices trivia, and those scores drag every dataset-wide module with them. The index records what was left out (`excluded_players`) together with the floor itself (`min_bancho_total`), so a published page can always say so rather than quietly showing a smaller dataset.

**Totals**: per algorithm, the player's scores are ranked by *that algorithm's* PP and summed with weight `0.95^n` — what the profile would look like if that algorithm were the one in use. No bonus PP is applied (the bonus term only becomes relevant above 1000 ranked scores, and these fixtures are the top 100).

### Single-score timings (release build, 32,516 scores over 343 bp lists / 5,848 map-mod pairs, Windows x86-64)

| Stage | median | mean | p95 |
|---|---|---|---|
| `prepare` per (map, mods) — cached, paid once | 28.9ms | 53.6ms | 176.3ms |
| Bancho pp | 0.2µs | 0.3µs | 0.5µs |
| Sunny + Codexxy (one shared upstream pass) | 60.9µs | 65.3µs | 119.2µs |
| Reimagined pp | 0.8µs | 1.3µs | 3.0µs |
| **total per score, four columns** | **64.7µs** | 71.6µs | 131.2µs |

Read it as two very different costs. Pricing a score is microseconds — Reimagined's own arithmetic is 0.7µs, and even Bancho's complete pp calculation is half a microsecond — while the *difficulty* pass (star ratings for the full map, the rice variant and the official calculator) costs tens of milliseconds per map-and-mods pair and is cached, so a bp list pays it once per map. Sunny and Codexxy share that pass by construction, which is why they are timed together; computing them independently would roughly double that cost. For comparison, the Python research reference prices a score in ~5µs and needs ~13-16ms for its diagnostic surface channel, and the Node sunny build needs ~100-350ms per map.

## Dataset layout

```
docs/data/index.json            engine info, algorithm list, one entry per player + weighted totals
docs/data/players/{uid}.json    that player's scores, columnar
docs/data/.nojekyll             (in docs/) tells GitHub Pages not to run Jekyll
```

`index.json` is small and is loaded eagerly; a player's shard is fetched when the player is selected.

```jsonc
// index.json
{ "schema_version": 3,
  "generated_at": "2026-09-13T12:00:00Z",
  "engine": { "name": "mania-pp-rs", "version": "0.1.0", "spec_version": "v1.14", "rosu_pp_rev": "3530ba7" },
  "algorithms": [ { "id": "bancho", "label": "Bancho", "description": "…" }, … ],
  "users": [ { "uid": 21207706, "username": "Shirasu-Azusa", "fixture": "bp-lists", "scores": 100,
               "file": "players/21207706.json",
               "total_pp": { "bancho": 14923.95, "sunny": 14961.18, "codexxy": 15021.09, "reimagined": 14486.37 } } ],
  "score_count": 32516,
  "warnings": [] }
```

A player shard is columnar — the column names appear once and each score is an array of values in that order:

```jsonc
// players/{uid}.json
{ "schema_version": 3, "uid": 21207706, "username": "Shirasu-Azusa",
  "columns": [
    "score_id", "beatmap_id", "beatmap_set_id",            // identity, for links
    "artist", "title", "version", "keys", "od",            // map metadata
    "mods", "mods_parts",                                  // mods (raw string, and space-separated flags)
    "accuracy", "n320", "n300", "n200", "n100", "n50", "miss",
    "pp_bancho", "pp_sunny", "pp_codexxy", "pp_reimagined", // prices, in algorithm order
    "star_bancho", "star_sunny", "star_rice",              // official SR, and the two behind R/L
    "ln_ratio", "l_share", "w", "coord_mod", "eff_star", "acc_factor", "nf_factor"
  ],
  "scores": [ [6011663426, 5366651, 2455603, "Ludicin", "Blossom of Ashes", "Divination of Calamity",
               4, 7.3, "MR", "MR", 97.896, 5393, 2279, 179, 21, 14, 42,
               797.058, 803.566, 801.235, 790.792, 8.119, 8.151, 6.979,
               0.9215, 0.1438, 0.9806, 1.0322, 8.128, 0.9968, 1.0] ] }
```

`star_bancho` is the official star rating with the score's mods, `star_sunny` the star rating of the full map under the community algorithm, and `star_rice` the same on the map with every hold turned into a tap — the two numbers Reimagined's R and L channels are built from. `score_id` and `beatmap_set_id` can be `null`; a `pp_*` value is `null` when that algorithm could not price the score.

The three id fields exist so the site can link correctly: a difficulty lives at `https://osu.ppy.sh/beatmapsets/{beatmap_set_id}#mania/{beatmap_id}` (the beatmap id alone is not a valid link), a score at `https://osu.ppy.sh/scores/{score_id}`, a player at `https://osu.ppy.sh/users/{uid}`.

### Why not one big JSON file?

Because the intended scale is hundreds of players and tens of thousands of scores, and a single document would be wrong on three counts: every visitor would download all of it before seeing anything, the browser would parse all of it to render one player, and every refresh would produce one enormous diff in git. The split fixes that — the index stays a few kilobytes, and each player is a shard of a few tens of kilobytes fetched on demand.

The current dataset shows the shape of it: 343 players and 32,516 scores occupy 344 files and 14.8 MB, but a visitor loads only the 140 KB index plus the one ~43 KB shard being opened. Under the old single-document layout this would have been a single 15 MB file, so the initial download has stopped scaling with the dataset: the rankings and the dataset-wide modules need no shard at all, and adding hundreds more players grows the index by tens of kilobytes and costs nothing until a visitor opens one.

Inside a shard the layout is **columnar**: the column names appear once and each score is an array of values in that order. Compared with an array of objects this is roughly a third of the bytes (no repeated keys, no braces), it parses faster, and the site can turn it into table rows by index instead of by property lookup. The order is part of the contract: `columns` is authoritative, and adding a column means appending to it and bumping `schema_version`.

If the dataset ever outgrows JSON, the same split means only the shard format has to change — the index and the site's data-access layer stay put. The realistic next steps, in order of effort, are: gzip pre-compression (GitHub Pages already compresses JSON in transit), a packed binary shard (typed arrays for the numeric columns), or moving the aggregation server-side so the browser only receives what it renders.

## The comparison site

`docs/` **is** the site: `index.html`, `styles.css`, the ES modules under `js/` (`main.js` is the entry point, the views are in `js/views/`), `web.md` and `data/`. Serve it locally with any static server:

```bash
python -m http.server 8080 --directory docs
```

### Publishing (GitHub Pages)

GitHub Pages can deploy from the repository root or from `/docs`, and nothing else — so the site lives in `docs/` and the Pages source is *Deploy from a branch → `main` → `/docs`*. That keeps the Rust workspace, the fixtures and the algorithm documentation out of the published tree, while `docs/algorithms.md` and `docs/usage.md` remain reachable as files. `docs/.nojekyll` disables Jekyll so the files are served exactly as committed (a Jekyll build would rewrite the Markdown and drop files it considers special).

With that setting the site sits at `https://<owner>.github.io/<repo>/`, and the dataset resolves relative to it (`data/index.json`). Publishing a refreshed dataset is therefore: run the CLI, validate it (below), commit `docs/data/`, push. No workflow is needed; if the remote generates one instead, point its upload path at `docs`.

### Validation before publishing

The validator lives in the research repository (`scripts/validate_engine_results.py`) because this repository ships no tooling; run it after every refresh:

```bash
python scripts/validate_engine_results.py            # defaults to the engine's docs/data
```

It checks the schema version, the algorithm ids, the provenance block, every shard's column contract, and that every PP value is finite and non-negative.

### Search syntax

The site's search boxes use the query language of osu!'s own beatmap search ([wiki](https://osu.ppy.sh/wiki/en/Beatmap_search)): free text, plus `field<op>value` terms that are all ANDed. Operators are `=`, `==`, `:` (equal), `!=` (not equal), `<`, `>`, `<=`, `>=`; matching is case-insensitive.

The score search implements the fields our dataset actually carries, under the osu! names where one exists:

| Field | Meaning | Example |
|---|---|---|
| *(free text)* | artist, title, difficulty or mapper | `akasha` |
| `artist`, `title`, `diff`/`version`, `creator`/`mapper` | one specific text field | `artist=xi` |
| `key`, `keys` | column count | `keys=4` |
| `od` | overall difficulty of the map (before mods) | `od<7` |
| `ln`, `lns` | percentage of objects that are long notes (osu!lazer's own `ln` filter) | `lns>90` |
| `mod`, `mods` | mod acronym, `mod=NM` for no mod | `mod=DT` |
| `acc` | 305-weighted accuracy in percent | `acc>=99` |
| `pp` | PP under algorithm B | `pp>500` |
| `rank` | position in this bp list under algorithm B | `rank<=10` |
| `delta`, `rel` | B − A in pp, and B/A in percent | `delta<-20` |
| `star`/`stars`/`sr` | official (Bancho) star rating with the score's mods | `star<7` |
| `sr_sunny`, `sr_rice` | the community star rating of the full map, and of the same map with holds turned into taps | `sr_rice>6` |
| `score_id`, `map_id`, `set_id` | osu! identifiers | `map_id=1920615` |
| `eff_star`, `w`, `l_share`, `acc_factor`, `nf_factor` | Reimagined internals | `w>1.1` |

Examples that combine several terms: `mod=DT key=4 star<7`, `lns>90 acc>=99`, `delta<-20 rank<=20`, `pp>500 mod=NM`.

The player search on the rankings view uses the same syntax over the index: `uid`, free text over usernames, `scores`, `pp`/`pp_bancho`/`pp_sunny`/`pp_codexxy`/`pp_reimagined`, and `rank`/`rank_bancho`/… — for example `pp_reimagined>20000`, `scores=100 key=7`, `rank_bancho<=5`.

## Specification sync

`spec/spec.json` is generated by the research repository (`scripts/export_engine_spec.py`) and embedded into the engine at compile time; no tunable is hand-maintained here. After a research-side change:

1. export the spec on the research side (and bump the version there),
2. update `EXPECTED_SPEC_VERSION` in `crates/mania-pp-spec/src/lib.rs` if the version moved,
3. re-run the golden replay and the parity check on the research side,
4. re-run the CLI and commit the refreshed `docs/data/`,
5. tag the engine so published numbers remain traceable to a specification version.

## Verification

Correctness is verified from the research repository, which owns both the Python reference implementation and the vectors exported from it. Two layers, and it is worth knowing which one catches what:

| Layer | What it pins | Tool (research side) |
|---|---|---|
| **Formula layer** | every function of the Reimagined algorithm against the Python reference: windows, mods, key resolution, chord/column features, `.osu` parsing, the rice variant, the No-Fail model and the full pricing pipeline (685 cases / 1880 assertions) | `langs/engine_check` |
| **End-to-end parity** | the published `reimagined` column against the research report for the same scores, i.e. whether the engine reproduces the specification's numbers with *its own* difficulty front-end | `scripts/compare_engine_vs_research.py` |

The second layer exists because R and L are measured, not copied: the engine derives them from the pinned fork's sunny implementation, while the research reference derives them from its vendored sunny build. Two independent implementations of the same algorithm do not agree bit-for-bit, so the difference is quantified instead of assumed away. Measured on 100 four-key scores (NM/DT/MR):

| Comparison | median | p5 | p95 |
|---|---|---|---|
| engine star rating / research star rating | 1.0016 | 1.0000 | 1.0045 |
| engine rice star rating / research rice star rating | 1.0001 | 0.9988 | 1.0017 |
| **engine Reimagined PP / research `pp_final_surface`** | **1.0034** | 1.0005 | 1.0099 |

In other words the engine reproduces the research specification's production number to within about 0.3% at the median and 1% at p95, and the residual is explained by the two sunny implementations disagreeing by ~0.16% on these maps. Re-run the parity check whenever the fork revision is bumped, because that is exactly when this residual can change.

## FAQ

**Can the site compute PP for an arbitrary uid or score_id in the browser (a WASM calculator)?**

*Computing a score you already have: yes, and it is shipped.* The calculator view accepts a `.osu` file (dropped or pasted), a mod string and the six judgement counts, and prices the score under all four algorithms locally — no server, no key, no rate limit. It runs the same crate that produced the published dataset, so its numbers are identical: verified by pricing a score from `docs/data` in the browser and comparing, where the two agree to the dataset's rounding (≤0.0002 pp).

The module is built from `crates/mania-pp-wasm` and published as a static artefact under `docs/wasm/` (GitHub Pages serves files, so the compiled `.wasm` and its JS glue are committed, exactly like the dataset):

```bash
cargo build --release --target wasm32-unknown-unknown -p mania-pp-wasm
wasm-bindgen --target web --out-dir docs/wasm --out-name mania_pp_wasm \
  target/wasm32-unknown-unknown/release/mania_pp_wasm.wasm
```

CI re-runs exactly that and then checks two things, so the page can never serve a module that disagrees with the source: the committed `.d.ts` must match the freshly generated one (the JavaScript API is unchanged) and the fresh module must price a synthetic map to the same four pp values as the committed one. The `.wasm` bytes themselves are deliberately not compared — that would fail on any toolchain or platform drift while saying nothing about behaviour. `rust-toolchain.toml` pins the compiler to an exact release so a local build and CI agree on what they are building. Two conditions hold this together: the crate must stay buildable for `wasm32-unknown-unknown`, and the dependency's `reports` feature must stay disabled — it pulls in `crossterm` through `comfy-table`, which does not build for wasm, which is why the engine calls `mania::sunny::calculate` directly instead of the `report_utils` helper and parses mod strings itself.

The JavaScript surface is deliberately tiny (one class plus one function, both returning JSON):

```js
const wasm = await import('./wasm/mania_pp_wasm.js');
await wasm.default();
const calc = new wasm.Calculator(osuText, 'DT');            // parse + prepare once
const result = JSON.parse(calc.price(5200, 210, 14, 2, 0, 1)); // price as often as you like
```

`Calculator` exists because the expensive part is the difficulty pass (tens of milliseconds per map-and-mods pair) while pricing is microseconds: the page prepares once and reprices on every keystroke.

**What WASM is for, and what it cannot do.** WASM replaces the *computation*, not the *acquisition*. It cannot fetch anything by id, and that is a property of osu!'s infrastructure rather than of the build:

| Test | Result |
|---|---|
| `HEAD https://osu.ppy.sh/scores/6425788632` | 200, but **no `Access-Control-Allow-Origin` header** — a page on another origin cannot read it |
| `HEAD https://osu.ppy.sh/osu/1920615` (a `.osu` file) | 200, **no `Access-Control-Allow-Origin` header** |
| `HEAD https://osu.ppy.sh/api/v2/beatmaps/1920615` | 403 — the API needs a token before it answers at all |

So "give me a score_id and I will fetch the score and the map" is not achievable from a static page: the score page is HTML and cross-origin-blocked, the `.osu` endpoint is cross-origin-blocked, and the API needs credentials the page cannot hold. Also note the API v2 has no documented "get a score by id" endpoint that returns judgements plus map info — the replay download (`/scores/{score}/download`) is the closest, and it yields a `.osr` from which you would still have to resolve the beatmap by checksum. Making that work needs a token, which means either the visitor's own token or a serverless proxy holding the application secret — neither is a WASM question, and the calculator shipped here deliberately needs no infrastructure at all.

*Fetching by uid/score_id from the browser* — no, not from a static page. The osu! API v2 can only hand out tokens in two ways: the client-credentials flow requires the application's **client secret**, which cannot be embedded in a public page without publishing it; and the authorization-code flow would work from a browser only with PKCE, which osu! does not support — the request has been open since 2020 and was still open in mid-2025 ([ppy/osu-web#7004](https://github.com/ppy/osu-web/issues/7004)), and browser calls to the API have also run into CORS problems.

Three ways to get that feature anyway, in increasing cost: (a) keep the current model — the research side pulls bp lists at 1 req/s and the engine publishes the results, which is what the dataset in this repository already is; (b) let a visitor paste their own token (obtainable through a third-party OAuth helper), which works only if CORS allows it; (c) run a small serverless proxy (Cloudflare Worker, Vercel function) that holds the client secret and exposes one read-only endpoint. Option (c) is the only way to get "type any uid and see four PP numbers" for real, and it moves part of the system off GitHub Pages.

**Why is the dataset not stored per score or in a database?**

Because the interesting unit is a player's whole list: PP is a weighted sum over a bp list, so comparisons are naturally per player. A static, sharded file set is the cheapest thing that serves that, keeps the hosting free and needs no server. If the project ever wants live aggregation or thousands of players, the shard format is the only part that has to change.

**What does "Codexxy" refer to, and what happened to "surface"?**

Codexxy is the name its author gives the algorithm; the technique it adds on top of Sunny is a *map-based timing surface*. This project's older notes, and the research repository's documents, call it "surface" — the same thing. The dataset, the site and the module use the name Codexxy.

**Why "Sunny" and not "Star-Rating-Rebirth" or "SRR"?**

The community calls the algorithm Sunny, after its author [Crz]sunnyxxy; *Star-Rating-Rebirth* is the name of the repository it lives in. An earlier draft of these documents abbreviated it to "SRR", which nobody uses and which confused readers — it has been removed.
