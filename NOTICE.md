# Attribution

This project is MIT licensed (see `LICENSE`). It depends on, ports and/or redistributes work created by others. Keep this file accurate: it is the compliance precondition for publishing this repository, its Pages site and any future WASM build.

## Algorithms

| Algorithm | Author / origin | License | How it is used here |
|---|---|---|---|
| **Bancho** (official osu!mania pp) | [ppy/osu](https://github.com/ppy/osu) (osu!lazer), via [MaxOhn/rosu-pp](https://github.com/MaxOhn/rosu-pp) | MIT | dependency: the forked crate's ported official calculator |
| **Sunny** (community algorithm) | [Crz]sunnyxxy, repository [sunnyxxy/Star-Rating-Rebirth](https://github.com/sunnyxxy/Star-Rating-Rebirth) | see upstream repository | dependency: the `mania::sunny` module of the rosu-pp fork |
| **Codexxy** (Sunny plus a map-based timing surface) | [ppy-sb/rosu-pp](https://github.com/ppy-sb/rosu-pp), `mania-surface-map-timing-difficulty` branch | MIT | dependency: the `pp_timing` component of the same module |
| **Reimagined** (three-channel R/L/A) | this project (Leo_Black) | MIT | ported here from the Python research reference |

## Code

| Component | Author | License | Notes |
|---|---|---|---|
| [`rosu-pp`](https://github.com/ppy-sb/rosu-pp) (`mania-surface-map-timing-difficulty`) | MaxOhn and contributors, fork by ppy-sb | MIT, © 2021 Max | consumed as a pinned git dependency for the Sunny and Codexxy columns; the revision is recorded in `Cargo.toml` and `Cargo.lock` |
| [`rosu-pp`](https://github.com/MaxOhn/rosu-pp) (v4.0.1, untouched upstream) | MaxOhn | MIT, © 2021 Max | consumed as a second pinned git dependency, because the fork above no longer computes the official star rating: this is the crate behind the Bancho column |
| [`rosu-map`](https://github.com/MaxOhn/rosu-map) | MaxOhn | MIT | transitive dependency (`.osu` decoding) |
| [`rosu-mods`](https://github.com/MaxOhn/rosu-mods) | MaxOhn | MIT | transitive dependency (mod representation) |
| `crates/mania-pp-spec`, `crates/mania-pp-algorithms`, `crates/mania-pp-cli`, `crates/mania-pp-wasm` | this project | MIT | the port of our own Python reference implementation, and the WebAssembly build of it |
| `docs/` site (`index.html`, `styles.css`, the ES modules under `js/`) | this project | MIT | no third-party assets, no CDN, no bundled libraries; the visual language follows Linear's published design tokens, which is a style reference and implies no affiliation |
| `docs/wasm/` (the compiled in-browser calculator) | this project | MIT | built from `crates/mania-pp-wasm`; it links this project's code and its dependencies' code under the licences listed above |

## Data

* Beatmap files (`.osu`) are **not** distributed with this repository. Fixtures reference maps by id only, and the local map cache is kept outside the repository.
* Score fixtures are publicly visible osu! scores (players' best-performance lists) and are included with the player's user id for attribution and reproducibility.
* The published dataset under `docs/data/` contains only ids, map metadata (artist/title/difficulty name), score metadata and computed PP values.

## In-game names and trademarks

"osu!" is a trademark of ppy Pty Ltd. This project is unofficial and is not affiliated with or endorsed by ppy Pty Ltd. Algorithm names are used descriptively to identify the implementations being compared.
