# mania-sr-pp-reimagined

A multi-algorithm **osu!mania PP comparison engine**.

Four mania performance algorithms live side by side in one repository, so that their output can be
compared on the same beatmaps and the same scores, and inspected in a browser:

| id | algorithm | provenance |
|---|---|---|
| `bancho` | official osu! pp (osu!lazer) | ported upstream in [`rosu-pp`](https://github.com/ppy-sb/rosu-pp) |
| `sunny` | community Star-Rating-Rebirth, pattern + accuracy part | `rosu-pp` fork, `mania-surface-map-timing-difficulty` branch |
| `surface` | sunny plus the map-based timing surface | same fork, `pp_timing` component |
| `reimagined` | this project's three-channel R / L / A algorithm | ported here from a Python research reference |

The research happens elsewhere, in Python: this repository is the **engine** — it consumes a frozen
specification, produces numbers, and publishes them.

**Why**: community mania PP is a single fused difficulty number, so disagreements between algorithms
are invisible — you can see *that* two algorithms disagree about a map, never *where*. The
`reimagined` algorithm splits play into **R** regular pressing, **L** coordination (what holding
notes adds) and **A** accuracy (window tightness relative to the score), and the engine makes the
disagreement between all four legible, per score and per player.

## Quick start

```bash
# build output stays outside the repository (see "Repository hygiene")
export CARGO_TARGET_DIR=../_build/mania-sr-pp-reimagined

cargo build --release

cargo run --release -p mania-pp-cli -- \
  --fixture fixtures/bp-21207706/scores.tsv \
  --maps    /path/to/osu/map/cache \
  --out     web/data/results.json

python -m http.server 8080 --directory web     # preview the comparison site
```

The CLI is offline and deterministic: it never queries the osu! API. Beatmaps are read from a local
cache that is kept outside this repository.

## Layout

```
spec/spec.json              tunable specification (exported from the research repository)
crates/mania-pp-spec/       typed, compile-time access to the specification
crates/mania-pp-algorithms/ the four algorithms, one module each, behind a common interface
crates/mania-pp-cli/        fixture scores in, four-algorithm results JSON out
fixtures/                   bp-list fixtures (score lists; no map data)
web/                        static comparison site (GitHub Pages serves this directory)
docs/                       algorithm descriptions and usage
```

## Specification, not folklore

Every tunable of the reimagined algorithm (LN weight anchors, cross-column modulation strength,
accuracy gamma, chord couplings, No-Fail curve, channel volumes) is exported from the Python research
repository into `spec/spec.json` and embedded at compile time. The engine carries no hand-maintained
copy, so it cannot silently disagree with the research side. See [docs/usage.md](docs/usage.md).

## Repository hygiene

This repository is intended to contain **only** source, documentation, the specification, fixtures
and the published dataset:

* no test files and no test-only data — correctness is verified from the research repository, which
  owns the Python reference implementation and the golden vectors (`langs/engine_check/`),
* no build artefacts, no local caches and no scratch files — build with `CARGO_TARGET_DIR` pointing
  outside the repository, and keep beatmap caches elsewhere,
* no untracked files: the working tree is expected to match the committed state at all times.

## Documentation

* [`docs/algorithms.md`](docs/algorithms.md) — the four algorithms: provenance, formulas, mechanisms
* [`docs/usage.md`](docs/usage.md) — fixtures, CLI, `results.json`, publishing, specification sync
* [`docs/reference-csharp-sources.md`](docs/reference-csharp-sources.md) — C# reference notes for
  the bancho and sunny algorithms (formulas, entry points, porting traps)

## License and attribution

MIT licensed. The repository builds on and redistributes work by others — see
[`NOTICE.md`](NOTICE.md); keep it accurate and do not remove it.
