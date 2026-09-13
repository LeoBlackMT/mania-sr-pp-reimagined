# mania-sr-pp-reimagined

A multi-algorithm **osu!mania PP comparison engine**. Four mania performance algorithms live side by side in one repository, so that their output can be compared on the same beatmaps and the same scores, and inspected in a browser.

| id | algorithm | provenance |
|---|---|---|
| `bancho` | **Bancho** — the official osu! pp (osu!lazer) | ported upstream in the pinned [`rosu-pp`](https://github.com/ppy-sb/rosu-pp) fork |
| `sunny` | **Sunny** — the community algorithm by [Crz]sunnyxxy (its repository is named *Star-Rating-Rebirth*) | the `mania::sunny` module of the same fork |
| `codexxy` | **Codexxy** — sunny plus a map-based timing surface | the `pp_timing` part of the same calculation |
| `reimagined` | **Reimagined** — this project's three-channel R / L / A algorithm | ported here from a Python research reference |

The research happens elsewhere, in Python: this repository is the **engine** — it consumes a frozen specification, produces numbers, and publishes them.

**Why**: community mania PP is a single fused difficulty number, so disagreements between algorithms are invisible — you can see *that* two algorithms disagree about a map, never *where*. Reimagined splits play into **R** regular pressing, **L** coordination (what holding notes adds) and **A** accuracy (window tightness relative to the score), and the engine makes the disagreement between all four algorithms legible, per score and per player.

## Quick start

```bash
# build output stays outside the repository (see "Repository hygiene")
export CARGO_TARGET_DIR=../_build/mania-sr-pp-reimagined     # PowerShell: $env:CARGO_TARGET_DIR

cargo build --release

cargo run --release -p mania-pp-cli -- \
  --fixture fixtures/bp-lists.tsv \
  --maps    /path/to/osu/map/cache \
  --out     docs/data \
  --bench

python -m http.server 8080 --directory docs     # preview the comparison site
```

The CLI is offline and deterministic: it never queries the osu! API. Beatmaps are read from a local cache that is kept outside this repository, and `--bench` prints per-algorithm single-score timings.

## Layout

```
spec/spec.json              tunable specification (exported from the research repository)
crates/mania-pp-spec/       typed, compile-time access to the specification
crates/mania-pp-algorithms/ the four algorithms, one directory each, behind a shared interface
crates/mania-pp-cli/        fixture scores in, comparison dataset out
fixtures/                   bp-list fixtures (score lists; no map data)
docs/                       the comparison site (GitHub Pages serves this directory) + documentation
```

## The algorithm directories

`crates/mania-pp-algorithms/src/` is organised by algorithm, so each one is readable on its own:

```
lib.rs            the shared surface: parse a map once, price every score against it
shared/rice.rs    the "rice" variant of a map (every hold rewritten as a tap) used for the R channel
bancho/mod.rs     official osu! pp
sunny/mod.rs      community algorithm, pattern + accuracy part
codexxy/mod.rs    the same algorithm including the map-based timing surface
reimagined/       this project's algorithm: pp.rs, mods.rs, windows.rs, keys.rs, notes.rs, features.rs
```

The three dependency-provided algorithms are thin adapters over one upstream calculation; the 2,000 lines that are actually ours live in `reimagined/`, ported one-to-one from the research reference.

## Specification, not folklore

Every tunable of the Reimagined algorithm (LN weight anchors, cross-column modulation strength, accuracy gamma, chord couplings, No-Fail curve, channel volumes) is exported from the Python research repository into `spec/spec.json` and embedded at compile time. The engine carries no hand-maintained copy, so it cannot silently disagree with the research side. See [docs/usage.md](docs/usage.md).

## Repository hygiene

This repository contains **only** source, documentation, the specification, fixtures and the published dataset:

* no test files and no test-only data — correctness is verified from the research repository, which owns the Python reference implementation, the golden vectors and the dataset validator;
* no build artefacts and no local caches — build with `CARGO_TARGET_DIR` pointing outside the repository, and keep beatmap caches elsewhere;
* no untracked files: the working tree is expected to match the committed state at all times.

## Documentation

* [`docs/algorithms.md`](docs/algorithms.md) — the four algorithms: names, provenance, formulas, mechanisms
* [`docs/usage.md`](docs/usage.md) — fixtures, CLI, dataset layout, publishing, specification sync, FAQ
* [`docs/web.md`](docs/web.md) — the comparison site itself (running it locally, what it shows)
* [`docs/reference-csharp-sources.md`](docs/reference-csharp-sources.md) — C# reference notes for Bancho and Sunny (formulas, entry points, porting traps)

## License and attribution

MIT licensed. The repository builds on and redistributes work by others — see [`NOTICE.md`](NOTICE.md); keep it accurate and do not remove it.
