# Fixtures

A fixture is a **score list** — who played which beatmap with which mods and what judgement counts they got — plus references to beatmaps that stay outside this repository: map files are copyrighted and large, so they are read at run time from a local cache (`mania-pp-cli --maps <dir>`).

Fixtures are the **input** side of the pipeline. The computed results are the *output* side and live in `docs/data/` (see [`../docs/usage.md`](../docs/usage.md)).

## `bp-lists.tsv`

1,900 scores: the first 100 best performances of nineteen players, chosen to cover both key modes and every mod family. osu! scores and profiles are public; the user ids are kept for attribution and reproducibility.

| uid | player | key modes | mod mix |
|---|---|---|---|
| 21207706 | Shirasu-Azusa | 4K | NM 53, DT 19, DT+MR 14, MR 12 |
| 7233338 | Cyfer | 4K | NM 49, DT 49, HT 2 |
| 10024264 | Tre | 4K | NM 58, DT 28, DT+MR 9, NC 2 |
| 1002726 | Morbon | 4K | DT 64, NM 33, NC 2 |
| 10028302 | Sorc | 4K | NM 47, MR 19, HT 16, HT+MR 13 |
| 106269 | Elysion | 4K | DT 48, NM 48, HD 2 |
| 10792537 | lut | 4K 76, 7K 24 | NM 53, NC 27, HT 13 |
| 11187151 | giraray | 4K | NM 72, DT 27 |
| 12102633 | M1A300 | 4K | NM 97, HT 3 |
| 12249034 | yazer_osu | 4K | NM 99, DT 1 |
| 13656583 | jesmoxd | 4K | NM 80, DT 12, HT 4, MR 4 |
| 30885120 | Firefly Neko | 7K 84, 4K 12, 6K 4 | NM 69, HT 20, DT 8 |
| 8273098 | My Angel Koishi | 7K | NM 63, DT 27, DT+MR 5 |
| 8479894 | Mars_ | 7K 83, 4K 16 | NM 57, HT 22, DT 19 |
| 10083439 | bojii | 7K 92, 4K 4, 6K 4 | NM 57, DT 36, MR 3 |
| 1033244 | jihak0210 | 7K 99, 6K 1 | NM 60, MR 20, HT 8, NC 6 |
| 10790649 | Kalkai | 7K 99, 6K 1 | DT 47, NM 46, MR 5 |
| 13313526 | Ox Q | 7K | HT 53, NM 47 |
| 13656264 | palmEuEi | 7K 95, 6K 4, 4K 1 | HT 37, NM 32, MR 13, HT+MR 10 |

Coverage rationale: eleven four-key and seven seven-key lists exercise the key-count weighting; the rate-changing mods are represented at both extremes, from DT/NC-dominant lists to HT-dominant ones (Ox Q is more than half HT), which is what shows whether a rate mod moves all four algorithms together or apart; and the pure-NM lists act as a baseline where the algorithms can only disagree about the map itself.

Format (tab separated, header included):

```
uid	username	map_id	mods	320	300	200	100	50	miss
```

Tab separated rather than comma separated because osu! metadata is full of commas — artist names, difficulty names like `[4K] Foo, Bar` — so a CSV would need quoting on nearly every row.

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
  --out     docs/data
```

Scores whose map is missing from the cache are skipped and listed in the `warnings` array of `docs/data/index.json`, so a gap is always visible rather than silently ignored.
