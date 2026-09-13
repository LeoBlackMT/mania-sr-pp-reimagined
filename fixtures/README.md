# Fixtures

Score lists used to produce `web/data/results.json`. A fixture is a **score list plus references to
beatmaps that stay outside this repository** — map files are copyrighted and large, so they are read
at run time from a local cache (`mania-pp-cli --maps <dir>`).

## `bp-lists.tsv`

500 scores: the first 100 best performances of five players, chosen to cover different key modes and
mod sets. osu! scores and profiles are public; the user ids are kept for attribution and
reproducibility.

| uid | player | scores | key modes | notable mods |
|---|---|---|---|---|
| 21207706 | Shirasu-Azusa | 100 | 4K | NM, DT, DT+MR, MR |
| 30885120 | Firefly Neko | 100 | 7K 84, 4K 12, 6K 4 | NM, HT, DT, MR |
| 7233338 | Cyfer | 100 | 4K | NM, DT (49) |
| 8273098 | My Angel Koishi | 100 | 7K | NM, DT, DT+MR |
| 8479894 | Mars_ | 100 | 7K 83, 4K 16, 6K 1 | NM, HT (22), DT, HT+MR |

Coverage rationale: 4K versus 7K and mixed-key lists exercise the key-count weighting, the
rate-changing mods (DT/HT) exercise the rate variants, and two of the lists carry enough HT scores to
show how a rate mod moves all four algorithms together or apart.

Format (tab separated, header included):

```
uid	username	map_id	mods	320	300	200	100	50	miss
```

## Regenerating

The lists are produced on the research side from the collected score data:

```bash
python scripts/export_engine_fixture.py                 # default player set
python scripts/export_engine_fixture.py --uids 21207706,30885120 --limit 100
```

Then run the comparison (map cache supplied locally):

```bash
cargo run --release -p mania-pp-cli -- \
  --fixture fixtures/bp-lists.tsv \
  --maps    <path to .osu cache> \
  --out     web/data/results.json
```

Scores whose map is missing from the cache are skipped and listed in the `warnings` array of the
output document, so a gap is always visible rather than silently ignored.
