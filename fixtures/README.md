# Fixtures

A fixture is a **score list** — who played which beatmap with which mods and what judgement counts they got — plus references to beatmaps that stay outside this repository: map files are copyrighted and large, so they are read at run time from a local cache (`mania-pp-cli --maps <dir>`).

Fixtures are the **input** side of the pipeline. The computed results are the *output* side and live in `docs/data/` (see [`../docs/usage.md`](../docs/usage.md)).

## `bp-lists.tsv`

32,516 scores: the first 100 best performances of **343 players** — the osu!mania world top 200 (performance ranking, 2026-09-14) merged with every player already collected on the research side, de-duplicated by uid so each player appears exactly once. osu! scores and profiles are public; the user ids are kept for attribution and reproducibility.

| | |
|---|---|
| players | 343 |
| scores | 32,516 |
| unique beatmaps | 3,614 |
| unique map + mod pairs | 5,848 |
| key modes | 7K ×21,528 · 4K ×10,543 · 6K ×419 · 5K ×17 · 8K ×8 · 9K ×1 |
| mod mix | NM ×19,789 · DT ×4,213 · MR ×3,368 · HT ×1,853 · NC ×1,320 · DT+MR ×797 · NC+MR ×395 · HT+MR ×252 · 4K ×168 · HD ×83 · FL ×70 · FI ×52 |
| map coverage | 32,516 / 32,516 rows (100%) — every `.osu` present in the local map cache, none skipped |

Composition rationale: the world top 200 supplies the skill ceiling and the current mod meta in bulk (NM/DT/MR dominate, with every rate mod represented), while the research-side players carry the deliberate key-mode and rate-mod spread built up for algorithm calibration — eleven 4K lists, seven 7K lists, pure-NM baselines, and HT-dominant lists such as Ox Q and Firefly Neko. Together they give both breadth and the controlled contrasts the four algorithms are compared on; the pure-NM lists in particular act as a baseline where the algorithms can only disagree about the map itself.

Format (tab separated, header included):

```
uid	username	map_id	mods	n320	n300	n200	n100	n50	miss	score_id	lazer
```

Tab separated rather than comma separated because osu! metadata is full of commas — artist names, difficulty names like `[4K] Foo, Bar` — so a CSV would need quoting on nearly every row. The first ten columns are mandatory. `score_id` is optional and may be empty (the CLI parses it as an `Option<i64>` and uses it for the `osu.ppy.sh/scores/{id}` link). `lazer` is optional too: `1` for a lazer score, `0` for a legacy one, empty when unknown — it decides which judgement semantics Bancho prices the score under, because osu! keeps two score generations whose pp differs by 3% to 20% on identical counts.

## Regenerating

The lists are produced on the research side from the collected score data:

```bash
python scripts/fetch_top_players.py             # world top 200 bp lists (cached, 1 req/s)
python scripts/export_engine_fixture.py --all --players data/raw/players_top200.csv
```

`--all` selects every player known to the research repository; `--players <csv>` merges in a player list (here the world top 200). For the small hand-picked set used by earlier revisions — 1,900 scores over 19 bp lists, 1,060 map-mod pairs — run `export_engine_fixture.py` with no arguments with `MSR_ENGINE_ROOT` pointed at a scratch directory.

Then run the comparison (map cache supplied locally):

```bash
cargo run --release -p mania-pp-cli -- \
  --fixture fixtures/bp-lists.tsv \
  --maps    <path to .osu cache> \
  --out     docs/data
```

Scores whose map is missing from the cache are skipped and listed in the `warnings` array of `docs/data/index.json`, so a gap is always visible rather than silently ignored.

> **Note:** the timings in [`../docs/usage.md`](../docs/usage.md) and the counts in [`../docs/web.md`](../docs/web.md) were measured on the earlier 1,900-score fixture. The current fixture is ~17× that size, so `docs/data/` and those figures describe a pre-expansion run until the CLI is executed again. Per-score cost is unchanged, but `prepare()` is paid once per unique map+mod pair (5,848 here).
