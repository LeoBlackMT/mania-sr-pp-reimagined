/* tslint:disable */
/* eslint-disable */

/**
 * A parsed, prepared beatmap: parse and run the difficulty calculations once, price many scores.
 *
 * A visitor who changes a judgement count expects an instant answer, and the expensive part is the difficulty pass (tens of milliseconds), not the pricing (microseconds) — so the page keeps one `Calculator` per `(map, mods)` pair and only calls [`Calculator::price`] again.
 */
export class Calculator {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Map facts derived during preparation, as JSON: metadata, key count, OD/HP, hold share and the star ratings the channels are built from.
     */
    map_json(): string;
    /**
     * Parse `osu_text` and prepare it for `mods` (an acronym string such as `"DT"`, `"DT+MR"`, `"NM"` or `""`).
     */
    constructor(osu_text: string, mods: string);
    /**
     * Price one set of judgement counts, as JSON.
     *
     * The six counts are passed as separate scalars on purpose: this is the JavaScript boundary, where a flat argument list is the ergonomic and cheap form — the page reads six number inputs.
     *
     * The shape matches what the site renders: a list of algorithms with their PP, the map block and the Reimagined internals, so a page can show the same detail it shows for a published score.
     */
    price(n320: number, n300: number, n200: number, n100: number, n50: number, misses: number): string;
    /**
     * Set the score generation the priced counts belong to: true for a lazer `solo_score`, false for a legacy entry.
     */
    set_lazer(lazer: boolean): void;
    /**
     * Total object count of the prepared map, for validating a pasted score's judgement counts.
     */
    readonly objects: number;
}

/**
 * One-shot convenience wrapper: parse, prepare and price in a single call.
 *
 * Handy for a scripted check (the goldens and the site's own smoke test); the page itself should prefer [`Calculator`] so the difficulty pass is not repeated while a visitor edits counts.
 */
export function price_score(osu_text: string, mods: string, n320: number, n300: number, n200: number, n100: number, n50: number, misses: number): string;

/**
 * The upstream revision the algorithms were built against, matching the dataset's `engine` block.
 */
export function rosu_pp_rev(): string;

/**
 * Build provenance, so a page can show which engine its numbers came from.
 */
export function version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_calculator_free: (a: number, b: number) => void;
    readonly calculator_map_json: (a: number, b: number) => void;
    readonly calculator_new: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly calculator_objects: (a: number) => number;
    readonly calculator_price: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly calculator_set_lazer: (a: number, b: number) => void;
    readonly price_score: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => void;
    readonly rosu_pp_rev: (a: number) => void;
    readonly version: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export2: (a: number, b: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number, d: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
