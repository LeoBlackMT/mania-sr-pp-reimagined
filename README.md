# mania-sr-pp-reimagined

**This is the algorithm repository of the Reimagined osu!mania pp algorithm.** It holds the algorithm itself, its specification and the engine that runs it in Rust. The four-algorithm comparison it also publishes is a **by-product** — a way to keep the algorithm honest by seeing exactly where it disagrees with the community implementations it builds on — not the product.

The other three algorithms exist in the engine so that Reimagined has something to be read against:

| id | algorithm | provenance |
|---|---|---|
| `bancho` | **Bancho** — the official osu! pp (osu!lazer) | ported upstream in the pinned [`rosu-pp`](https://github.com/ppy-sb/rosu-pp) fork |
| `sunny` | **Sunny** — the community algorithm by [Crz]sunnyxxy (its repository is named *Star-Rating-Rebirth*) | the `mania::sunny` module of the same fork |
| `codexxy` | **Codexxy** — Sunny plus a map-based timing surface | the `pp_timing` part of the same calculation |
| `reimagined` | **Reimagined** — this project's three-channel R / L / A algorithm | implemented here, from a Python research reference |

Research happens elsewhere, in Python: the research repository owns the specification, this repository owns the engine. It consumes a frozen specification, produces numbers, and publishes them.

**What Reimagined does differently**: community mania PP is a single fused difficulty number, so disagreements between algorithms are invisible — you can see *that* two algorithms disagree about a map, never *where*. Reimagined splits play into **R** regular pressing, **L** coordination (what holding notes adds) and **A** accuracy (window tightness relative to the score), keeps the three channels measurable, and fuses them only at pricing time.

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

## The published page

`docs/` is served by GitHub Pages and holds three views over the published dataset — `#/players` (every player in the index), `#/player/{uid}` (one player's scores, ranked under either algorithm) and `#/dataset` (layers, price distributions, correlations and the widest disagreements across the whole dataset) — plus `#/calc`, which prices a single score in the browser with the engine compiled to WebAssembly, so a visitor can still check a map the page is unable to fetch. The dataset is 343 players and 32,516 scores, published as an index plus one shard per player; the page loads the index and only the shard it is asked for.

## License and attribution

MIT licensed. The repository builds on and redistributes work by others — see [`NOTICE.md`](NOTICE.md); keep it accurate and do not remove it.
