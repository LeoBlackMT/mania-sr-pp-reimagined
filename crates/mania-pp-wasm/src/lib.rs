//! WebAssembly build of the four mania PP algorithms, for the in-browser calculator.
//!
//! The site is a static page on GitHub Pages, so it cannot fetch a score or a beatmap by id: osu!'s score pages and `.osu` endpoints send no `Access-Control-Allow-Origin` header, and the API needs a token the page cannot hold (see the FAQ in `docs/usage.md`). What a page *can* do is compute — a visitor drops in a `.osu` file, types their judgement counts, and this module prices the score under all four algorithms locally, with no server, no key and no rate limit.
//!
//! The exported surface is deliberately tiny and JSON-based, so the site needs no extra JavaScript dependency and the numbers come from exactly the same code path as the published dataset:
//!
//! ```js
//! const wasm = await import('./wasm/mania_pp_wasm.js'); await wasm.default();                              // instantiate const calc = new wasm.Calculator(osuText, 'DT');    // parse + prepare once const result = JSON.parse(calc.price(5200, 210, 14, 2, 0, 1));
//! ```
//!
//! Everything here is a thin wrapper: parsing, mod handling and pricing all live in `mania-pp-algorithms`, which is the same crate the CLI publishes the dataset with.

use mania_pp_algorithms::{prepare, price_with_detail_and_options, Counts, Prepared, ScoreOptions};
use wasm_bindgen::prelude::*;

/// Build provenance, so a page can show which engine its numbers came from.
#[wasm_bindgen]
pub fn version() -> String {
    format!(
        "mania-pp-rs {} · spec {}",
        env!("CARGO_PKG_VERSION"),
        mania_pp_spec::spec().spec_version
    )
}

/// The upstream revision the algorithms were built against, matching the dataset's `engine` block.
#[wasm_bindgen]
pub fn rosu_pp_rev() -> String {
    "3530ba7".to_owned()
}

/// The judgement counts one score carries, in the order the site collects them.
fn counts_of(n320: u32, n300: u32, n200: u32, n100: u32, n50: u32, misses: u32) -> Counts {
    [n320, n300, n200, n100, n50, misses]
}

/// A parsed, prepared beatmap: parse and run the difficulty calculations once, price many scores.
///
/// A visitor who changes a judgement count expects an instant answer, and the expensive part is the difficulty pass (tens of milliseconds), not the pricing (microseconds) — so the page keeps one `Calculator` per `(map, mods)` pair and only calls [`Calculator::price`] again.
#[wasm_bindgen]
pub struct Calculator {
    inner: Prepared,
    mods: String,
    /// The score generation whose judgement semantics apply; osu! prices a lazer `solo_score` and a legacy `score_best_*` entry differently, by 3% to 20% on the same counts.
    lazer: bool,
}

#[wasm_bindgen]
impl Calculator {
    /// Parse `osu_text` and prepare it for `mods` (an acronym string such as `"DT"`, `"DT+MR"`, `"NM"` or `""`).
    #[wasm_bindgen(constructor)]
    pub fn new(osu_text: &str, mods: &str) -> Result<Calculator, JsError> {
        let inner = prepare(osu_text, mods).map_err(|err| JsError::new(&err))?;
        Ok(Calculator {
            inner,
            mods: mods.to_owned(),
            lazer: true,
        })
    }

    /// Map facts derived during preparation, as JSON: metadata, key count, OD/HP, hold share and the star ratings the channels are built from.
    pub fn map_json(&self) -> String {
        let info = self.inner.map_info();
        serde_json::json!({
            "mods": self.mods,
            "artist": info.artist,
            "title": info.title,
            "version": info.version,
            "mapper": info.mapper,
            "keys": info.keys,
            "od": info.od,
            "hp": info.hp,
            "ln_ratio": info.ln_ratio,
            "objects": info.objects,
            "holds": info.holds,
            "star_bancho": self.inner.star_bancho(),
            "star_sunny": self.inner.star_sunny(),
            "star_rice": self.inner.star_rice(),
        })
        .to_string()
    }

    /// Price one set of judgement counts, as JSON.
    ///
    /// The six counts are passed as separate scalars on purpose: this is the JavaScript boundary, where a flat argument list is the ergonomic and cheap form — the page reads six number inputs.
    #[allow(clippy::too_many_arguments)]
    ///
    /// The shape matches what the site renders: a list of algorithms with their PP, the map block and the Reimagined internals, so a page can show the same detail it shows for a published score.
    #[wasm_bindgen]
    pub fn price(
        &self,
        n320: u32,
        n300: u32,
        n200: u32,
        n100: u32,
        n50: u32,
        misses: u32,
    ) -> Result<String, JsError> {
        let counts = counts_of(n320, n300, n200, n100, n50, misses);
        let (pp, detail) =
            price_with_detail_and_options(&self.inner, &counts, ScoreOptions { lazer: self.lazer });

        let algorithms: Vec<serde_json::Value> = mania_pp_algorithms::ALGORITHM_IDS
            .iter()
            .map(|id| {
                serde_json::json!({
                    "id": id,
                    "pp": pp.get(id),
                })
            })
            .collect();

        let map: serde_json::Value = serde_json::from_str(&self.map_json())
            .map_err(|err| JsError::new(&format!("internal error: {err}")))?;

        Ok(serde_json::json!({
            "algorithms": algorithms,
            "map": map,
            "detail": {
                "eff_star": detail.eff_star,
                "w": detail.w,
                "coord_mod": detail.coord_mod,
                "l_share": detail.l_share,
                "acc_factor": detail.acc_factor,
                "nf_factor": detail.nf_factor,
                "ln_ratio": detail.ln_ratio,
            },
        })
        .to_string())
    }

    /// Set the score generation the priced counts belong to: true for a lazer `solo_score`, false for a legacy entry.
    pub fn set_lazer(&mut self, lazer: bool) {
        self.lazer = lazer;
    }

    /// Total object count of the prepared map, for validating a pasted score's judgement counts.
    #[wasm_bindgen(getter)]
    pub fn objects(&self) -> u32 {
        self.inner.map_info().objects as u32
    }
}

/// One-shot convenience wrapper: parse, prepare and price in a single call.
///
/// Handy for a scripted check (the goldens and the site's own smoke test); the page itself should prefer [`Calculator`] so the difficulty pass is not repeated while a visitor edits counts.
#[allow(clippy::too_many_arguments)] // flat arguments are the natural shape of the JavaScript boundary
#[wasm_bindgen]
pub fn price_score(
    osu_text: &str,
    mods: &str,
    n320: u32,
    n300: u32,
    n200: u32,
    n100: u32,
    n50: u32,
    misses: u32,
) -> Result<String, JsError> {
    let calculator = Calculator::new(osu_text, mods)?;
    calculator.price(n320, n300, n200, n100, n50, misses)
}
