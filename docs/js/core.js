/* ===========================================================================
 * core.js — state, the algorithm table, normalisation, layers, tables, routing and data loading.
 *
 * This is the module the views are built on, and it is deliberately the only place that knows how the dataset is shaped: index.json is read once, a player shard is read when that player is opened, and nothing anywhere downloads more than one shard.
 * Four things are worth knowing before reading further.
 *   1. STATE LIVES IN THE HASH. readHash() is the only writer of the A/B pair, the per-view search, sort and layout, so a link handed to somebody else reproduces the page exactly, and a hash without a/b falls back to the defaults rather than keeping whatever was on screen.
 *   2. THE VIEWS ARE REGISTERED, NOT HARD-CODED. registerView() takes a descriptor (see its doc comment); the nav slot, the router and the document title are all driven from that registry, which is the hook a new view — the calculator at #/calc, say — is added through without touching this file.
 *   3. NULLS ARE VALUES. num() turns anything unparsable into null, a null prints "–", sorts last and is excluded from every median, rank and spread.
 *   4. THE ENGINE IS THE SOURCE OF TRUTH. Labels, descriptions and algorithm ids come from the dataset when it carries them, and columns the page does not know are ignored.
 * =========================================================================== */

import { $, $$, els, viewSection } from './dom.js';
import { esc, fmt, fmtDate, num, pct, signed } from './format.js';
import { syncThemeButton } from './theme.js';

/* ------------------------------ 1 configuration --------------------------- */

/** Sibling of this page; GitHub Pages serves docs/ as the site root, so every URL here is relative. */
export const INDEX_URL = 'data/index.json';
/** Prefix for the shard paths listed in the index. */
export const DATA_DIR = 'data/';
/** The layout this page knows. A different value raises a notice-bar warning and the page still renders what it can. */
export const SCHEMA_VERSION = 3;
/** Presentation order for the algorithms this repository publishes; anything else follows, sorted by id. */
export const KNOWN_ALGOS = ['bancho', 'sunny', 'codexxy', 'reimagined'];

/** Rows on one page of every paged table — the rankings, one player's scores and the dataset view's disagreements. Fifty rows fill a screen at the density these tables are read at, and the page indicator then says something a reader can act on. */
export const PAGE_ROWS = 50;
/** Step for the one list that still grows in place rather than paging. Nothing uses it today: the dataset view's disagreement table pages fifty rows like the other tables now. */
export const MORE_STEP = 150;
/** Engine warnings printed in the provenance footer. */
export const WARN_LIMIT = 25;

/** The only LN split anywhere on the page: below 10% holds is RC, above 90% is LN, the middle is HB. */
export const LN_RC = 0.10;
export const LN_HB = 0.90;
export const LN_BUCKETS = [
  { id: 'RC', label: 'RC', test: (v) => v != null && v < LN_RC },
  { id: 'HB', label: 'HB', test: (v) => v != null && v >= LN_RC && v <= LN_HB },
  { id: 'LN', label: 'LN', test: (v) => v != null && v > LN_HB },
];
export const LN_GRADES = { RC: `ln_ratio < ${LN_RC}`, HB: `${LN_RC} ≤ ln_ratio ≤ ${LN_HB}`, LN: `ln_ratio > ${LN_HB}` };

/** |rank shift| that counts as a visible move, and as a large one. */
export const SHIFT_MID = 4;
export const SHIFT_BIG = 10;

/** Score CSV column order for the columns the engine publishes in schema 3. */
export const CSV_ORDER = [
  'score_id', 'beatmap_id', 'beatmap_set_id', 'artist', 'title', 'version', 'mapper',
  'keys', 'od', 'mods', 'accuracy', 'n320', 'n300', 'n200', 'n100', 'n50', 'miss',
  'star_bancho', 'star_sunny', 'star_rice', 'ln_ratio', 'l_share', 'w', 'coord_mod',
  'eff_star', 'acc_factor', 'nf_factor',
];

/** The fixture and map cache the empty state quotes in its command; both are placeholders on purpose. */
export const SAMPLE_FIXTURE = 'fixtures/bp-lists.tsv';
export const SAMPLE_MAPS = '/path/to/osu/map/cache';
export const REPO_URL = 'https://github.com/LeoBlackLT/mania-sr-pp-reimagined';

export const PAGE_TITLE = 'mania-sr-pp-reimagined — osu!mania PP algorithms compared';

/* --------------------------------- 2 state -------------------------------- */

export const state = {
  source: null,          // the raw index document plus {origin, filename}
  users: [],             // index entries: metadata + weighted totals, no scores
  algoIds: [],           // algorithm ids, KNOWN_ALGOS first, then anything the dataset adds
  algoMeta: new Map(),   // id -> {id, label, description}

  ranks: new Map(),      // algorithm id -> Map(uidKey -> rank over the index totals)
  totalsRanked: false,

  uid: null,             // the player the detail view shows
  scores: [],            // normalised scores of that player
  shardColumns: [],      // the column names the shard declared, for field availability
  starKeys: new Set(),   // the `x` of every `star_x` column the shard carries
  scoreRanks: {},        // algorithm id -> rank of every score in the whole bp list
  shard: 'empty',        // empty | loading | ready | error
  shardError: null,      // message for the error panel
  shardToken: 0,         // guards against an out-of-order shard response
  shardFromFile: false,  // true while state.scores came from a file the visitor handed over, which must never be refetched

  A: null,               // baseline algorithm
  B: null,               // compared algorithm

  spec: null,            // the registered view descriptor the hash resolved to
  arg: null,             // its path argument (the player uid, for #/player/{uid})
  view: {},              // per-view state, owned by the hash
  sort: {},              // live sort of each view: id -> {key, dir}
  shown: {},             // rows shown per view id
  open: new Set(),       // shard indices of expanded score rows
  loadError: null,       // message from a manual load that failed
  dataVersion: 0,        // bumped whenever the dataset or the shard under it changes, so view-level caches can key on it
};

const dataListeners = [];
/** Register a callback that runs whenever the dataset or the shard changes — how search.js keeps its field maps in step without core.js importing it. */
export function onDataChanged(fn) { dataListeners.push(fn); }
function notifyData() { state.dataVersion += 1; for (const fn of dataListeners) fn(); }

export const player = () => state.users.find((u) => u.uid === state.uid) || null;
export const uidKey = (u) => (u.uid == null ? `n:${u.username}` : `u:${u.uid}`);

/** Labels used when the index does not carry an `algorithms` array — a lone shard loaded by hand, for instance, still names its four algorithms instead of printing raw ids. */
const BUILTIN_LABELS = { bancho: 'Bancho', sunny: 'Sunny', codexxy: 'Codexxy', reimagined: 'Reimagined' };

export const algoMeta = (id) => (state.algoMeta.get(id) || { id, label: BUILTIN_LABELS[id] || id, description: 'no description in this dataset' });
export const algoLabel = (id) => (id == null ? '–' : algoMeta(id).label);
/** The A / B role of an algorithm, for the header of a comparison column. */
export const abRole = (id) => [id === state.A ? 'A' : null, id === state.B ? 'B' : null].filter(Boolean).join(' / ');

/** Read the algorithm list from the index, then from the totals, and pick a valid A/B pair. */
export function resolveAlgorithms(raw) {
  const declared = (Array.isArray(raw?.algorithms) ? raw.algorithms : []).filter((a) => a && a.id);
  state.algoMeta = new Map(declared.map((a) => [String(a.id), {
    id: String(a.id), label: String(a.label || a.id), description: String(a.description || ''),
  }]));
  const pool = new Set(state.algoMeta.keys());
  for (const u of state.users) for (const id of Object.keys(u.totalPp || {})) pool.add(String(id));
  extendAlgorithms(pool);
}

/** Keep KNOWN_ALGOS in front and append anything else in id order. */
function extendAlgorithms(pool) {
  const ordered = KNOWN_ALGOS.filter((id) => pool.has(id));
  for (const id of Array.from(pool).sort()) if (!ordered.includes(id)) ordered.push(id);
  state.algoIds = ordered;
}

/** The default pair of this page: A is Reimagined (the algorithm under discussion) and B is Bancho (the official one). */
export function defaultPair() {
  const ids = state.algoIds;
  const a = ids.includes('reimagined') ? 'reimagined' : (ids[0] ?? null);
  let b = ids.includes('bancho') ? 'bancho' : (ids.find((id) => id !== a) ?? null);
  if (b === a) b = ids.find((id) => id !== a) ?? a;
  return { a, b };
}

/** The algorithm list can still grow after the hash was read — a shard loaded on its own only reveals its algorithms when it arrives — so the pair is re-checked against the list it has now. Returns true when it had to change. */
export function ensurePair() {
  const before = `${state.A}/${state.B}`;
  const d = defaultPair();
  if (!state.A || !state.algoIds.includes(state.A)) state.A = d.a;
  if (!state.B || !state.algoIds.includes(state.B)) state.B = d.b;
  if (state.B === state.A) state.B = state.algoIds.find((id) => id !== state.A) ?? state.A;
  return before !== `${state.A}/${state.B}`;
}

/* ------------------------- 3 per-score accessors -------------------------- */

export const ppOf = (s, id) => (id == null || !s ? null : (s.pp[id] ?? null));
export const ppA = (s) => ppOf(s, state.A);
export const ppB = (s) => ppOf(s, state.B);
/** B − A on one score; null unless both algorithms priced it. */
export function diffOf(s) {
  const a = ppA(s), b = ppB(s);
  return a == null || b == null ? null : b - a;
}
/** Relative difference B / A − 1, as a share; null when A has no pp or A ≤ 0. */
export function relOf(s) {
  const a = ppA(s), b = ppB(s);
  return a == null || b == null || !(a > 0) ? null : b / a - 1;
}
/** Rank of this score under one algorithm, or null when that algorithm did not price it. */
export const scoreRank = (s, id) => (state.scoreRanks[id] ? state.scoreRanks[id][s.i] ?? null : null);
/** Rank shift B − A: positive means the score drops when the list is ordered by B. */
export function shiftOf(s) {
  const ra = scoreRank(s, state.A), rb = scoreRank(s, state.B);
  return ra == null || rb == null ? null : rb - ra;
}
export const shiftClass = (v) => (v == null ? '' : Math.abs(v) >= SHIFT_BIG ? 'shift-big' : Math.abs(v) >= SHIFT_MID ? 'shift-mid' : '');

/** max − min spread across every algorithm that priced this score, absolute and against the mean. */
export function spreadOf(pp) {
  const vals = state.algoIds.map((id) => pp?.[id]).filter((v) => v != null);
  if (vals.length < 2) return null;
  const max = Math.max(...vals), min = Math.min(...vals);
  const mean = vals.reduce((x, y) => x + y, 0) / vals.length;
  return { max, min, mean, abs: max - min, rel: mean > 0 ? (max - min) / mean : null };
}

/* --------------------------- 4 star rating columns ------------------------ */

/** Every star column of this shard, as `x` for `star_x`. `star_rice` lands here too, and the score table decides which of them are algorithm stars. */
export const shardStarKeys = () => state.starKeys;
/** The star rating of one score for one `x` of a `star_x` column. */
export const starValue = (s, key) => s.stars[key] ?? null;
/** star_bancho when the shard has it, otherwise the first star rating the shard does carry — what the bare `star` search field means. */
export function primaryStar(s) {
  if (s.stars.bancho != null) return s.stars.bancho;
  for (const key of state.starKeys) if (s.stars[key] != null) return s.stars[key];
  return null;
}
/** The star columns the score table shows: Bancho's own plus one per algorithm that publishes `star_<id>`, in algorithm order. */
export function starColumns() {
  return state.algoIds.filter((id) => state.starKeys.has(id)).map((id) => ({ id, key: `star:${id}`, label: algoLabel(id) }));
}

/* --------------------------- 5 player accessors --------------------------- */

/** Dense rank per algorithm over the index totals (1 = highest). */
export function refreshIndexRanks() {
  state.ranks = new Map(state.algoIds.map((id) => [id, new Map()]));
  for (const id of state.algoIds) {
    state.users.map((u, i) => ({ i, v: num(u.totalPp[id]) }))
      .filter((x) => x.v != null)
      .sort((a, b) => b.v - a.v || a.i - b.i)
      .forEach((x, k) => state.ranks.get(id).set(uidKey(state.users[x.i]), k + 1));
  }
  state.totalsRanked = true;
}
export const playerRank = (u, id) => (state.totalsRanked ? (state.ranks.get(id)?.get(uidKey(u)) ?? null) : null);
/** One algorithm's total for one player minus A's. */
export function playerDelta(u, id) {
  const base = num(u.totalPp[state.A]), v = num(u.totalPp[id]);
  return base == null || v == null ? null : v - base;
}
/** The same in percent, which is the number a comparison is actually read for. */
export function playerRel(u, id) {
  const base = num(u.totalPp[state.A]), v = num(u.totalPp[id]);
  return base == null || v == null || !(base > 0) ? null : (v / base - 1) * 100;
}
/** ▲/▼: positive means the player climbs when A is replaced by that algorithm. */
export function playerMove(u, id) {
  const r = playerRank(u, id), ra = playerRank(u, state.A);
  return r == null || ra == null || id === state.A ? null : ra - r;
}

/** Weighted total of one algorithm: the index value when there is one, otherwise osu!'s 0.95 decay over that algorithm's own order (which is what a lone shard loaded by hand can offer). */
export function totalFor(id) {
  const u = player();
  if (!u) return { value: null, derived: false };
  const given = num(u.totalPp[id]);
  if (given != null) return { value: given, derived: false };
  const vals = state.scores.map((s) => s.pp[id]).filter((v) => v != null).sort((a, b) => b - a);
  if (!vals.length) return { value: null, derived: false };
  return { value: vals.reduce((acc, v, i) => acc + v * Math.pow(0.95, i), 0), derived: true };
}

/** Rank of every score in the whole bp list ordered by one algorithm (1 = best).
 *  Ties fall back to shard order so ranks are deterministic, a score an algorithm did not price has no rank, and the ranking always covers the whole list — the search only decides which rows are displayed. */
export function computeScoreRanks(list, id) {
  const rank = new Array(list.length).fill(null);
  list.map((s, i) => i).filter((i) => list[i].pp[id] != null)
    .sort((x, y) => list[y].pp[id] - list[x].pp[id] || x - y)
    .forEach((si, k) => { rank[si] = k + 1; });
  return rank;
}
export function refreshScoreRanks() {
  state.scoreRanks = {};
  for (const id of state.algoIds) {
    if (state.scores.length) state.scoreRanks[id] = computeScoreRanks(state.scores, id);
  }
}

/* ------------------------------ 6 mod helpers ----------------------------- */

/** Mods are matched on `mods_parts`, falling back to `mods`, because the engine may emit both "EZDT" and "EZDT V2". */
export const modHay = (s) => String(s.modsParts || s.mods || '');
export const hasMod = (s, flag) => modHay(s).toUpperCase().includes(flag);
export const isNoMod = (s) => { const h = modHay(s).toUpperCase(); return h === '' || h === 'NM'; };
export const isRateUp = (s) => hasMod(s, 'DT') || hasMod(s, 'NC');
export const isRateDown = (s) => hasMod(s, 'HT') || hasMod(s, 'DC');
/** Separator-free upper-case form, so "DT MR", "DT+MR" and "DTMR" are one value — that is what an exact `mod==` comparison uses. */
export const modKey = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/* -------------------------------- 7 layers -------------------------------- */

/** The mod families of one list, in the order every table prints them. They partition the list, so a score belongs to exactly one of them and only the families that actually occur come back. */
export function modFamilies(list) {
  const rows = [];
  if (list.some(isNoMod)) rows.push({ id: 'nm', name: 'NM', grade: 'no mods', test: isNoMod });
  if (list.some(isRateUp)) rows.push({ id: 'dt', name: 'Rate-up', grade: 'DT · NC', test: isRateUp });
  if (list.some(isRateDown)) rows.push({ id: 'ht', name: 'Rate-down', grade: 'HT · DC', test: isRateDown });
  const otherMods = (s) => !isNoMod(s) && !isRateUp(s) && !isRateDown(s);
  if (list.some(otherMods)) rows.push({ id: 'other', name: 'Other mods', grade: 'neither rate-up nor rate-down', test: otherMods });
  return rows;
}

/** Layer families of one bp list. Every family partitions the list, so the rows of one family add up to its size, and only buckets that actually occur come back: as many layers as there are, no more, no fewer. */
export function layerFamilies(list) {
  const fams = [];
  const keyRows = [4, 6, 7].filter((k) => list.some((s) => s.keys === k))
    .map((k) => ({ id: `k${k}`, name: `${k}K`, grade: `${k} keys`, test: (s) => s.keys === k }));
  const otherKeys = (s) => s.keys == null || ![4, 6, 7].includes(s.keys);
  if (list.some(otherKeys)) keyRows.push({ id: 'kother', name: 'Other key modes', grade: 'not 4K, 6K or 7K', test: otherKeys });
  if (keyRows.length) fams.push({ title: 'By key mode', rows: keyRows });

  const modRows = modFamilies(list);
  if (modRows.length) fams.push({ title: 'By mod family', rows: modRows });

  const styleRows = LN_BUCKETS.filter((b) => list.some((s) => b.test(s.ln))).map((b) => ({ id: b.id, name: b.label, grade: LN_GRADES[b.id], test: (s) => b.test(s.ln) }));
  if (list.some((s) => s.ln == null)) styleRows.push({ id: 'lnunk', name: 'No ln_ratio', grade: 'missing in the dataset', test: (s) => s.ln == null });
  if (styleRows.length) fams.push({ title: 'By LN share (ln_ratio)', rows: styleRows });
  return fams;
}

/** LN bucket of one value, using the one set of cut-offs the page has. */
export function lnBucketLabel(ln) {
  if (ln == null) return '–';
  const b = LN_BUCKETS.find((x) => x.test(ln));
  return b ? b.label : '–';
}

/* ---------------------------- 8 normalisation ----------------------------- */

/** Index entry -> metadata only; the scores live in the shard. */
export function normalizeUser(raw) {
  const username = String(raw.username ?? raw.uid ?? 'unknown');
  const u = {
    uid: num(raw.uid), username,
    fixture: raw.fixture == null ? null : String(raw.fixture),
    scoreCount: num(raw.scores) ?? 0,
    file: raw.file == null ? null : String(raw.file),
    totalPp: Object.fromEntries(Object.entries(raw.total_pp || {}).map(([k, v]) => [String(k), num(v)])),
  };
  u.text = `${u.uid ?? ''} ${username}`.toLowerCase();
  return u;
}

/** A shard row is an ARRAY in `columns` order. Unknown columns are ignored and a missing optional column reads as null, so an older or newer dataset still renders — what it lacks simply shows "–". */
export function normalizeScore(row, at, i) {
  const g = (name) => {
    const k = at.get(name);
    return k === undefined || row[k] === undefined ? null : row[k];
  };
  const pp = {};
  for (const id of state.algoIds) pp[id] = num(g(`pp_${id}`));
  const stars = {};
  for (const key of state.starKeys) stars[key] = num(g(`star_${key}`));
  const mods = String(g('mods') ?? '').trim().toUpperCase();
  const modsParts = String(g('mods_parts') ?? '').trim().toUpperCase();
  const s = {
    i,
    scid: num(g('score_id')), bid: num(g('beatmap_id')), sid: num(g('beatmap_set_id')),
    artist: String(g('artist') ?? ''), title: String(g('title') ?? ''),
    version: String(g('version') ?? ''),
    mapper: (g('mapper') ?? g('creator')) == null ? null : String(g('mapper') ?? g('creator')),
    keys: num(g('keys')), od: num(g('od')),
    mods, modsLabel: mods === '' ? 'NM' : mods,
    modsParts: modsParts || (mods === '' ? 'NM' : mods),
    acc: num(g('accuracy')),
    counts: ['n320', 'n300', 'n200', 'n100', 'n50', 'miss'].map((k) => num(g(k))),
    pp, stars,
    ln: num(g('ln_ratio')), lShare: num(g('l_share')), w: num(g('w')), coordMod: num(g('coord_mod')),
    effStar: num(g('eff_star')), accFactor: num(g('acc_factor')), nfFactor: num(g('nf_factor')),
  };
  s.text = [s.artist, s.title, s.version, s.mapper ?? '', s.modsLabel, s.modsParts, s.bid ?? '', s.sid ?? '', s.keys ?? ''].join(' ').toLowerCase();
  return s;
}

/** Columnar shard -> normalised scores, folding in any extra `pp_*` or `star_*` column so the engine can add an algorithm without a page change. */
export function normalizeShard(raw) {
  const columns = Array.isArray(raw?.columns) ? raw.columns.map(String) : [];
  state.shardColumns = columns;
  const extra = columns.filter((c) => c.startsWith('pp_') && c.length > 3).map((c) => c.slice(3));
  if (extra.length) extendAlgorithms(new Set([...state.algoIds, ...extra]));
  state.starKeys = new Set(columns.filter((c) => c.startsWith('star_') && c.length > 5).map((c) => c.slice(5)));
  if (!state.starKeys.size && columns.some((c) => c === 'stars')) state.starKeys = new Set(['bancho']);
  const at = new Map(columns.map((c, i) => [c, i]));
  const rows = Array.isArray(raw?.scores) ? raw.scores : [];
  return rows.filter(Array.isArray).map((r, i) => normalizeScore(r, at, i));
}

/* ------------------------------- 9 tables --------------------------------- */

/** Sortable header row built from a column list; one descriptor per column carries both the header metadata and the cell renderer, so the two cannot drift apart. */
export function headHtml(columns) {
  const cells = columns.map((c) => {
    if (!c.key) return `<th scope="col" class="${esc(c.cls || '')}">${c.label ? esc(c.label) : '<span class="sr-only">Expand</span>'}</th>`;
    return `<th scope="col" class="sortable ${c.type === 'num' ? 'num' : ''} ${esc(c.cls || '')}" data-key="${esc(c.key)}" aria-sort="none" title="${esc(c.title || 'Click to sort ascending')}">${esc(c.label)}</th>`;
  }).join('');
  return `<tr>${cells}</tr>`;
}

/** Sorting re-renders only the tbody; the header is patched in place, which keeps click-to-sort cheap and leaves the horizontal scroll position alone. */
export function patchSort(table, sort, columns) {
  $$('th[data-key]', $('thead', table)).forEach((th) => {
    const active = th.dataset.key === sort.key;
    th.setAttribute('aria-sort', active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none');
    const col = columns.find((c) => c.key === th.dataset.key);
    if (col) th.title = `${col.title || 'Click to sort'} — ${active && sort.dir === 1 ? 'click for descending' : 'click for ascending'}`;
  });
}

/** A first click always sorts ascending and only a second click on the same column flips it, which is what makes "sort by rank" produce the best scores first. */
export const nextSort = (sort, key) => ({ key, dir: sort.key === key ? -sort.dir : 1 });

/** Nulls always sink to the bottom, whichever direction is active; ties fall back to a text key, then to source order, so every table is deterministic. */
export function compareRows(a, b, key, dir, valueOf, textOf, order = (x) => x.i ?? 0) {
  const va = valueOf(a, key), vb = valueOf(b, key);
  const na = va == null, nb = vb == null;
  if (na || nb) return na && nb ? order(a) - order(b) : na ? 1 : -1;
  const numeric = typeof va === 'number' && typeof vb === 'number';
  const r = numeric ? va - vb : String(va) < String(vb) ? -1 : String(va) > String(vb) ? 1 : 0;
  return (r * dir) || textOf(a).localeCompare(textOf(b)) || (order(a) - order(b));
}

/* ------------------------------- 10 routing ------------------------------- */
/* #/players                rankings, every player in the index (no shard fetched)
 * #/player/{uid}           one player, its shard fetched when the route is entered
 * #/dataset                dataset-wide aggregates, straight out of the index
 * Query: q (search), sort, dir (asc | desc), layout (compact | grouped), a (algorithm A), b (algorithm B).
 * A and B are global because they define the comparison, and they are written into every hash the page produces, so any view can be linked exactly as it looks right now. */

const registry = new Map();
/** The order views were registered in, which is the nav order and the fallback order. */
const registration = [];

/**
 * Register a view. This is the extension point: a new view — the calculator at #/calc, for instance — is one descriptor away, and nothing else in the page has to change.
 *
 *   id        route segment, unique, e.g. 'calc' for #/calc
 *   label     nav label, or null to stay out of the nav slot
 *   parse(q, arg)   -> the view's state object built from the hash query and the path argument, or null when the route cannot be satisfied and the router should fall back
 *   path(view, arg) -> the hash path without its query, e.g. '#/player/21207706'
 *   title(view, arg) -> document.title for that state
 *   render(view, arg) -> draw the view; called on every render and must not write into its own form controls
 *   sync(view)  -> optional: push the state into the view's controls, called only when the route changes, so typing is never interrupted
 *   needsData   -> optional: false for a view that does not read the dataset (the calculator), so it still works when data/index.json cannot be loaded
 *   needsShard  -> true when the view renders one player's scores; the router then loads the shard of `view.uid`
 *   onShard()   -> optional: called whenever the shard's state changes (loading | ready | error | empty)
 *
 * A calculator view would look like this:
 *   registerView({ id: 'calc', label: 'Calculator',
 *     parse: () => ({ q: '' }),
 *     path: () => '#/calc',
 *     title: () => 'Calculator — mania-sr-pp-reimagined',
 *     render: (view) => renderCalc(view) });
 */
export function registerView(spec) {
  if (!spec || !spec.id) throw new Error('a view descriptor needs an id');
  if (registry.has(spec.id)) throw new Error(`view ${spec.id} is already registered`);
  registry.set(spec.id, spec);
  registration.push(spec.id);
}
export const viewSpecs = () => registration.map((id) => registry.get(id));
export const viewSpec = (id) => registry.get(id) || null;
/** The view a bare URL opens: the first registered one. */
export const homeSpec = () => registry.get(registration[0]) || null;

export function parseHashQuery(search) {
  const out = {};
  for (const part of String(search).replace(/^\?/, '').split('&')) {
    if (!part) continue;
    const at = part.indexOf('=');
    out[decodeURIComponent(at < 0 ? part : part.slice(0, at))] = at < 0 ? '' : decodeURIComponent(part.slice(at + 1));
  }
  return out;
}

/** Loose sort keys (`pp_bancho`, `rankA`) -> the canonical `family:algorithm` form. */
export function normalizeSortKey(key) {
  if (!key) return null;
  if (key === 'rankA') return `rank:${state.A}`;
  if (key === 'rankB') return `rank:${state.B}`;
  const m = /^(pp|delta|rank|star)[_:](.+)$/.exec(key);
  if (!m) return key;
  const id = state.algoIds.find((a) => a.toLowerCase() === m[2].toLowerCase());
  return id ? `${m[1]}:${id}` : key;
}
export const dirOf = (v, fallback) => (v === 'asc' ? 1 : v === 'desc' ? -1 : fallback);

/** Apply the A/B pair from a hash query, falling back to the defaults so a bare URL always opens the same comparison. */
function applyPair(q) {
  const d = defaultPair();
  state.A = q.a && state.algoIds.includes(q.a) ? q.a : d.a;
  state.B = q.b && state.algoIds.includes(q.b) ? q.b : d.b;
  if (state.B === state.A) state.B = state.algoIds.find((id) => id !== state.A) ?? state.A;
}

/** Read the hash into state and return the descriptor it resolved to. */
export function readHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const qAt = raw.indexOf('?');
  const pathPart = qAt < 0 ? raw : raw.slice(0, qAt);
  const q = parseHashQuery(qAt < 0 ? '' : raw.slice(qAt + 1));
  const seg = pathPart.split('/').filter(Boolean);
  applyPair(q);
  const wanted = seg[0] || homeSpec()?.id;
  const spec = viewSpec(wanted) || homeSpec();
  const arg = seg.length > 1 ? decodeURIComponent(seg.slice(1).join('/')) : null;
  const view = spec && spec.parse ? spec.parse(q, arg) : null;
  if (spec && view) {
    if (view.uid !== undefined) state.uid = num(view.uid);
    state.spec = spec;
    state.arg = arg;
    state.view[spec.id] = view;
    state.sort[spec.id] = { key: view.sort, dir: view.dir };
    return { spec, view, arg };
  }
  const home = homeSpec();
  const fallback = home ? home.parse({}, null) : {};
  state.spec = home;
  state.arg = null;
  if (home) {
    state.view[home.id] = fallback;
    state.sort[home.id] = { key: fallback.sort, dir: fallback.dir };
  }
  state.uid = null;
  return { spec: home, view: fallback, arg: null };
}

/** Write the current view state back into the hash. replace=true (the default) keeps the back button usable while typing. */
export function writeHash(replace = true) {
  const spec = state.spec;
  if (!spec) return;
  const view = state.view[spec.id] || {};
  const p = new URLSearchParams();
  if (view.q) p.set('q', view.q);
  if (view.sort) {
    p.set('sort', view.sort);
    p.set('dir', view.dir === 1 ? 'asc' : 'desc');
  }
  if (view.layout && view.layout !== 'compact') p.set('layout', view.layout);
  // Only a page other than the first is written, so an ordinary link stays as short as it was and page 1 is what an absent key means.
  if (num(view.page) > 1) p.set('page', String(Math.trunc(view.page)));
  if (state.A) p.set('a', state.A);
  if (state.B) p.set('b', state.B);
  const url = `${spec.path(view, state.arg)}?${p.toString()}`;
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
}

/** Open a player. The hash is the source of truth, so navigation and deep links are the same code path. */
export function openPlayer(uid) {
  const p = new URLSearchParams();
  if (state.A) p.set('a', state.A);
  if (state.B) p.set('b', state.B);
  location.hash = `#/player/${encodeURIComponent(String(uid))}?${p.toString()}`;
}

/** Paging and the expanded-row set are per view, so switching views never inherits the other one's window. */
export function resetPaging(id) {
  state.shown[id] = MORE_STEP;
  state.open.clear();
  const view = state.view[id];
  if (view) view.page = 1;
}
export const shownFor = (id) => state.shown[id] ?? MORE_STEP;

/** Change one view's sort and put it in the hash. The live sort and the hash's copy are written together here, so they cannot drift. */
export function setSort(id, key, dir) {
  const view = state.view[id] || (state.view[id] = {});
  view.sort = key;
  view.dir = dir;
  view.page = 1;   // a new order makes the old page number meaningless
  state.sort[id] = { key, dir };
  state.shown[id] = MORE_STEP;
  writeHash(true);
}

/* ------------------------------- 10b paging ------------------------------- */

/** A hash `page` value as a 1-based page number; anything unparsable or below 1 is the first page. */
export const pageArg = (v) => {
  const n = Math.trunc(num(v) ?? 1);
  return !Number.isFinite(n) || n < 1 ? 1 : n;
};

/** How many pages a row count needs. Never zero, so an empty table still reads "page 1 / 1" instead of "page 1 / 0". */
export const pageCount = (n) => Math.max(1, Math.ceil(Math.max(0, n) / PAGE_ROWS));

/**
 * The window one view shows: the clamped page number, the page count, the slice bounds and the `rows a–b of n` figures the indicator prints.
 * The page number is clamped here rather than written back into the hash, because the hash carries what the reader asked for and a search that shrinks the list should not silently rewrite it.
 */
export function pageWindow(view, rowCount) {
  const total = Math.max(0, rowCount);
  const pages = pageCount(total);
  const page = Math.min(pageArg(view?.page), pages);
  const start = (page - 1) * PAGE_ROWS;
  const end = Math.min(total, start + PAGE_ROWS);
  return { page, pages, total, start, end, from: total ? start + 1 : 0, to: end };
}

/** The one sentence the pager prints: which rows are on screen and which page that is. */
export const pageLabel = (w) => (w.total ? `rows ${w.from}–${w.to} of ${w.total} · page ${w.page} / ${w.pages}` : 'no rows to page');

/** The target page of one pager button. */
export function pageTarget(kind, w) {
  return kind === 'first' ? 1 : kind === 'last' ? w.pages : kind === 'prev' ? w.page - 1 : w.page + 1;
}

/** Reflect a page window into one pager's controls: the buttons that cannot move are disabled rather than hidden, so the row never reflows as the reader pages. */
export function syncPager(pager, info, w) {
  if (info) info.textContent = pageLabel(w);
  if (!pager) return;
  for (const b of $$('button[data-page]', pager)) {
    const target = pageTarget(b.dataset.page, w);
    b.disabled = target === w.page || target < 1 || target > w.pages;
  }
}

/** Paging a long table brings the reader back to its head, but only when that head has already scrolled out of sight — a table that is fully visible must not jump. */
export function pageScrollIntoView(el) {
  if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: 'start' });
}

/** Every pager of one table, top and bottom. A table long enough to scroll past its header gets a second set of controls above it, so the next page is one click away instead of a scroll back up and a scroll down again. */
export const pagerNodes = (id) => $$(`[data-pager="${id}"]`);

/** Show, hide and refresh every pager of one table at once, so the top and bottom copies can never disagree about the page or about which way they can move. The text indicator lives in one of them and every copy's buttons are patched. */
export function syncPagers(id, w, rowCount) {
  const nodes = pagerNodes(id);
  for (const node of nodes) node.hidden = !rowCount;
  for (const node of nodes) syncPager(node, $(`[data-pager-info="${id}"]`, node), w);
}

/**
 * Wire every pager of a table to one handler.
 *
 * The handler is called with the target page number and the pager that was clicked, because the
 * scroll anchor differs: clicking the top controls must keep the top controls in place, while
 * clicking the bottom ones brings the table head back into view. Scrolling to the table for a
 * click on the top copy would jump the reader past the very controls they are using.
 */
export function bindPagers(id, onPage) {
  for (const node of pagerNodes(id)) {
    node.addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-page]');
      if (!b || b.disabled) return;
      onPage(b.dataset.page, node);
    });
  }
}

/* ---------------------------- 11 shell rendering -------------------------- */

/** The nav slot. Built once, then only the active link is patched, so hovering and focus survive a re-render. */
export function buildNav() {
  els.navLinks.innerHTML = viewSpecs().filter((s) => s.label)
    .map((s) => `<li><a class="nav-link" data-view="${esc(s.id)}" href="#/${esc(s.id)}">${esc(s.label)}</a></li>`).join('');
  els.navLinks.addEventListener('click', (ev) => {
    const a = ev.target.closest('a[data-view]');
    if (!a) return;
    ev.preventDefault();
    // Entering a view from the nav drops that view's own search and sort, which is what a nav click is expected to do.
    history.pushState(null, '', a.getAttribute('href'));
    applyRoute();
  });
}
function patchNav(activeId) {
  $$('a[data-view]', els.navLinks).forEach((a) => {
    const active = a.dataset.view === activeId;
    a.classList.toggle('is-active', active);
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

export function renderLegend() {
  const ids = state.algoIds.length ? state.algoIds : KNOWN_ALGOS;
  els.legendCards.innerHTML = ids.map((id) => {
    const m = algoMeta(id);
    const roles = abRole(id);
    return `<div class="card"><div class="card-name">${esc(m.label)}${roles ? `<span class="badge badge-ab">${esc(roles)}</span>` : ''}</div><div class="card-desc">${esc(m.description)}</div></div>`;
  }).join('');
  els.legend.hidden = !state.source;
}

/** Everything the header line says about the source. */
export function renderMeta() {
  const e = state.source?.engine || {}, parts = [];
  if (e.name) parts.push(`${e.name}${e.version ? ' ' + e.version : ''}`);
  if (e.spec_version) parts.push(`spec ${e.spec_version}`);
  if (e.rosu_pp_rev) parts.push(`rosu-pp ${e.rosu_pp_rev}`);
  const gen = fmtDate(state.source?.generated_at);
  if (gen) parts.push(`generated ${gen}`);
  if (state.source) {
    parts.push(`${state.users.length} player${state.users.length === 1 ? '' : 's'}`);
    parts.push(`${num(state.source.score_count) ?? state.scores.length} scores`);
    parts.push(`source: ${state.source.origin === 'file' ? (state.source.filename || 'local file') : INDEX_URL}`);
  } else {
    parts.push('no dataset loaded');
  }
  els.meta.textContent = parts.join('  ·  ');
}

/** One line per data caveat: local file, unexpected schema_version, engine warnings, a failed manual load. */
export function renderNotice() {
  const s = state.source, msgs = [];
  if (s?.origin === 'file') msgs.push(`Showing a locally loaded file: <code>${esc(s.filename || '(unnamed)')}</code>.`);
  const version = num(s?.schema_version);
  if (version != null && version !== SCHEMA_VERSION) {
    msgs.push(version > SCHEMA_VERSION
      ? `<strong>Newer <code>schema_version</code> ${esc(version)}</strong> than this page knows (${SCHEMA_VERSION}): the fields it understands are rendered and anything newer is ignored.`
      : `<strong>Older <code>schema_version</code> ${esc(version)}</strong> (this page knows ${SCHEMA_VERSION}): missing fields show “–”.`);
  }
  if (state.loadError) msgs.push(`<strong>Could not load that file</strong> — ${esc(state.loadError)}`);
  const warn = Array.isArray(s?.warnings) ? s.warnings.length : 0;
  if (warn) msgs.push(`${warn} engine warning${warn === 1 ? '' : 's'} — listed in the provenance footer.`);
  els.note.hidden = !msgs.length;
  els.note.innerHTML = msgs.join('<br>');
}

/** Provenance: exactly which build produced these numbers. */
export function renderProvenance() {
  const s = state.source, e = s?.engine || {};
  const rows = s ? [
    ['engine', [e.name, e.version].filter(Boolean).join(' ') || '–'],
    ['spec version', e.spec_version || '–'],
    ['rosu-pp revision', e.rosu_pp_rev || '–'],
    ['generated at', fmtDate(s.generated_at) || '–'],
    ['schema version', s.schema_version == null ? '–' : String(s.schema_version)],
    ['players', String(state.users.length)],
    ['scores', s.score_count == null ? '–' : String(s.score_count)],
    // The engine drops players below a Bancho pp floor before writing anything; saying so here is what keeps "327 players" from looking like the whole population.
    ['excluded players', s.excluded_players == null || s.excluded_players === 0
      ? 'none'
      : `${s.excluded_players} below ${s.min_bancho_total == null ? 'the floor' : `${fmt(s.min_bancho_total, 0)} Bancho pp`}`],
    ['dataset source', s.origin === 'file' ? `local file: ${s.filename || '(unnamed)'}` : INDEX_URL],
    ['repository', `<a href="${esc(REPO_URL)}" target="_blank" rel="noopener noreferrer">${esc(REPO_URL.replace('https://', ''))}</a>`],
  ] : [['dataset', 'not loaded']];
  const warn = Array.isArray(s?.warnings) ? s.warnings : [];
  els.prov.innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')
    + `<dt>warnings</dt><dd>${warn.length ? `<span class="warn">${warn.length}</span>` : 'none'}</dd>`
    + (warn.length ? `<dt></dt><dd><ul class="warn-list">${warn.slice(0, WARN_LIMIT).map((w) => `<li>${esc(w)}</li>`).join('')}${warn.length > WARN_LIMIT ? `<li>… (+${warn.length - WARN_LIMIT} more)</li>` : ''}</ul></dd>` : '');
}

/** The A / B pair is one control, in the algorithms panel, visible from every view that compares anything. */
export function syncPairControls() {
  const ids = state.algoIds;
  const fill = (sel, chosen) => {
    if (!ids.length) {
      // No algorithms yet — before any data, or after a file that carried none — so the control says so instead of showing the first option as if it were the choice.
      sel.innerHTML = '<option value="">–</option>';
      sel.disabled = true;
      return;
    }
    sel.innerHTML = ids.map((id) => `<option value="${esc(id)}">${esc(algoMeta(id).label)}</option>`).join('');
    sel.disabled = ids.length < 2;
    if (chosen && ids.includes(chosen)) sel.value = chosen;
  };
  fill(els.algoA, state.A);
  fill(els.algoB, state.B);
  els.swapAB.disabled = ids.length < 2;
  els.pairNote.innerHTML = ids.length
    ? `A = <strong>${esc(algoLabel(state.A))}</strong> · B = <strong>${esc(algoLabel(state.B))}</strong> — Δ columns are B − A, ranks under A come first, and both sides follow this pair on every view.`
    : 'This dataset carries no algorithm pp values, so there is nothing to compare yet.';
}

/** Change the pair, then re-rank every table and re-express every delta. */
export function setPair(a, b) {
  const next = { a, b };
  if (next.a === next.b) next.b = state.algoIds.find((id) => id !== next.a) ?? next.a;
  state.A = next.a;
  state.B = next.b;
  refreshScoreRanks();
  const spec = state.spec;
  if (spec) {
    const view = state.view[spec.id] || {};
    const d = spec.defaultSort ? spec.defaultSort() : null;
    if (d && spec.reSortOnPair) Object.assign(view, { sort: d.key, dir: d.dir });
    resetPaging(spec.id);
  }
  writeHash(true);
  renderAll();
}

/** Draw everything that is not owned by a view, then the active view. */
export function renderAll() {
  const hasData = !!state.source;
  for (const spec of viewSpecs()) {
    const el = viewSection(spec.id);
    if (el) el.hidden = !(hasData || spec.needsData === false) || state.spec?.id !== spec.id;
  }
  renderLegend();
  renderMeta();
  renderNotice();
  renderProvenance();
  syncPairControls();
  patchNav(state.spec?.id ?? null);
  if (!hasData && state.spec?.needsData !== false) {
    document.title = PAGE_TITLE;
    syncThemeButton();
    return;
  }
  // A view that does not read the dataset hides the load-failure panel: on `#/calc` it would sit above a working calculator explaining a file that view does not need. The panel is still there for the views that do need it.
  if (!hasData) els.loader.hidden = true;
  if (state.spec.id === 'players') refreshIndexRanks();
  const view = state.view[state.spec.id];
  document.title = state.spec.title(view, state.arg);
  state.spec.render(view, state.arg);
  syncThemeButton();
}

/* ------------------------------ 12 data loading --------------------------- */

export function engineCommand(extra = '') {
  return [
    'cargo run --release -p mania-pp-cli -- \\',
    `  --fixture ${SAMPLE_FIXTURE} \\`,
    `  --maps    ${SAMPLE_MAPS} \\`,
    `  --out     docs/data${extra}`,
  ].join('\n');
}

/** Empty state: there is no usable dataset, so say why, show the command that produces one, and offer a file. */
export function showEmpty(reason, blocked) {
  state.source = null;
  state.users = [];
  state.scores = [];
  state.shard = 'empty';
  state.scoreRanks = {};
  state.shardColumns = [];
  state.starKeys = new Set();
  state.algoIds = [];
  state.totalsRanked = false;
  state.view = {};
  state.uid = null;
  els.loader.hidden = false;
  els.loaderErr.hidden = true;
  els.loaderErr.textContent = '';
  els.loaderWhy.textContent = reason;
  els.loaderHint.innerHTML = blocked
    ? 'This page was opened straight from disk (<code>file://</code>), where the browser refuses to read sibling files. Serve <code>docs/</code> over HTTP, or load <code>index.json</code> below.'
    : 'Run the command below to write <code>docs/data/index.json</code>, then reload — or load an existing <code>index.json</code> (or a single player shard) below.';
  els.loaderCmd.textContent = engineCommand();
  notifyData();
  // The router decides what is visible, not this function: when the hash points at a view that does not read the dataset — the calculator — it still has to render, and calling renderAll() directly here would leave a deep link to it showing nothing until the visitor clicked the navigation.
  applyRoute();
}

/** Adopt an index document. `eagerShard` carries a shard that was dropped in on its own. */
export function applyIndex(raw, origin, eagerShard) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('top level is not a JSON object');
  const users = (Array.isArray(raw.users) ? raw.users : []).filter((u) => u && typeof u === 'object');
  if (!users.length && !Array.isArray(raw.algorithms)) throw new Error('no "users" array and no "algorithms" array');
  state.source = Object.assign({}, raw, { origin: origin.kind, filename: origin.filename });
  state.users = users.map(normalizeUser);
  state.scores = [];
  state.scoreRanks = {};
  state.shard = 'empty';
  state.shardError = null;
  state.shardColumns = [];
  state.starKeys = new Set();
  state.algoIds = [];
  state.A = null;
  state.B = null;
  state.totalsRanked = false;
  state.uid = null;
  state.open.clear();
  state.view = {};
  state.sort = {};
  state.shown = {};
  state.loadError = null;
  state.shardFromFile = !!eagerShard;
  resolveAlgorithms(raw);
  // A shard handed over on its own is normalised straight away: it is the only place its algorithms, its star columns and its scores come from, so the rankings can show algorithm columns before the player is opened.
  if (eagerShard) {
    state.scores = normalizeShard(eagerShard);
    state.shard = 'ready';
    ensurePair();
  }
  refreshIndexRanks();
  refreshScoreRanks();
  els.loader.hidden = true;
  els.loaderErr.hidden = true;
  els.loaderErr.textContent = '';
  state.spec = null;   // a fresh dataset must reload the shard the route asks for, even when it is the same player
  notifyData();
  enterRoute();
}

/** Resolve the hash, push its state into the active view's controls, render, and fetch the shard that view needs. */
function enterRoute() {
  const { spec, view } = readHash();
  if (!spec) {
    renderAll();
    return;
  }
  for (const s of viewSpecs()) if (state.shown[s.id] == null) state.shown[s.id] = MORE_STEP;
  spec.sync?.(view, state.arg);
  renderAll();
  if (spec.needsShard) loadShard();
}

/** Apply a hash change: the navigation and the deep link are the same code path. */
export function applyRoute() {
  const { spec } = readHash();
  // A view that does not read the dataset (the calculator) stays usable when data/index.json is missing, which is exactly when a visitor may still want to price one score.
  const usable = !!spec && (!!state.source || spec.needsData === false);
  if (!usable) {
    renderAll();
    return;
  }
  const prevSpec = state.spec?.id, prevUid = state.uid;
  spec.sync?.(state.view[spec.id], state.arg);
  renderAll();
  const moved = prevSpec !== spec.id || prevUid !== state.uid;
  if (spec.needsShard && (moved || state.shard === 'empty')) loadShard();
}

/** Fetch (or reuse) the shard of the current player, then rank it. Never more than one shard, and a stale response is dropped. */
export async function loadShard() {
  const u = player();
  state.shardError = null;
  resetPaging(state.spec?.id ?? 'player');
  if (!u) {
    state.scores = [];
    state.scoreRanks = {};
    state.shard = 'empty';
    notifyData();
    renderAll();
    return;
  }
  if (state.shardFromFile) {
    // The shard was handed to the page as a file, so there is nothing to fetch and nothing to clear: it is already in state.scores.
    state.shardFromFile = false;
    state.shard = 'ready';
    ensurePair();
    refreshScoreRanks();
    notifyData();
    renderAll();
    return;
  }
  state.scores = [];
  state.scoreRanks = {};
  const url = DATA_DIR + (u.file || `players/${u.uid}.json`);
  const token = ++state.shardToken;
  state.shard = 'loading';
  notifyData();
  renderAll();
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const raw = await res.json();
    if (token !== state.shardToken) return;   // a newer selection won the race
    state.scores = normalizeShard(raw);
    state.shard = 'ready';
  } catch (err) {
    if (token !== state.shardToken) return;
    state.shard = 'error';
    state.shardError = `${url} — ${err?.message ?? err}`;
    notifyData();
    renderAll();
    return;
  }
  ensurePair();   // a shard may carry an algorithm the index did not list, so the pair is re-checked against the list it has now
  refreshScoreRanks();
  notifyData();
  renderAll();
}

export async function boot() {
  const fromDisk = location.protocol === 'file:';
  const fail = (what, err) => showEmpty(`${INDEX_URL} ${what}: ${err?.message ?? err}.`, fromDisk);
  let res;
  try {
    res = await fetch(INDEX_URL, { cache: 'no-store' });
  } catch (err) { return fail('could not be fetched', err); }
  if (!res.ok) return showEmpty(`${INDEX_URL} is not available: HTTP ${res.status} ${res.statusText}.`, fromDisk);
  let text;
  try { text = await res.text(); } catch (err) { return fail('could not be read', err); }
  try { applyIndex(JSON.parse(text), { kind: 'live' }); } catch (err) { fail('is not usable', err); }
}

/** Manual load: an index document (the normal case) or a single player shard. */
export function loadText(text, filename) {
  const report = (msg) => {
    if (state.source) {
      state.loadError = msg;
      renderNotice();
    } else {
      showEmpty(msg, location.protocol === 'file:');
      els.loaderErr.hidden = false;
      els.loaderErr.textContent = msg;
    }
  };
  let raw;
  try { raw = JSON.parse(text); } catch (err) { return report(`${filename}: ${err.message}`); }
  try {
    if (Array.isArray(raw?.users)) return applyIndex(raw, { kind: 'file', filename });
    if (Array.isArray(raw?.columns) && Array.isArray(raw?.scores)) {
      const n = raw.scores.length;
      return applyIndex({
        schema_version: raw.schema_version, generated_at: null, engine: null, algorithms: null,
        users: [{ uid: raw.uid ?? null, username: raw.username ?? 'local shard', fixture: filename, scores: n, file: null, total_pp: {} }],
        score_count: n, warnings: [],
      }, { kind: 'file', filename }, raw);
    }
    throw new Error('expected an index document ("users" array) or a player shard ("columns" + "scores")');
  } catch (err) { report(`${filename}: ${err.message}`); }
}

export function readFile(file) {
  if (!file) return;
  const r = new FileReader();
  r.onload = () => loadText(String(r.result), file.name);
  r.onerror = () => loadText('', file.name);   // surfaces as a JSON parse error, which is the honest report
  r.readAsText(file);
}

/* ------------------------------ 13 pair control --------------------------- */

export function initPairControls() {
  els.algoA.addEventListener('change', (e) => setPair(e.target.value, state.B));
  els.algoB.addEventListener('change', (e) => setPair(state.A, e.target.value));
  els.swapAB.addEventListener('click', () => setPair(state.B, state.A));
}

/* ----------------------------- 14 shared tables --------------------------- */

/** A "+"/"−" disclosure button for a score row. */
export function expandButton(s, extraClass = 'cell-toggle') {
  const open = state.open.has(s.i);
  return `<td class="${extraClass}"><button type="button" class="row-toggle" aria-expanded="${open}" aria-label="${open ? 'Hide' : 'Show'} details for ${esc(s.artist)} – ${esc(s.title)}">${open ? '−' : '+'}</button></td>`;
}

/** The expanded detail row: everything the data carries that the table above does not — ids and links, the Reimagined internals, every algorithm's pp with its delta against A, and the spread. */
export function detailGrid(s) {
  const sp = spreadOf(s.pp), mean = sp ? sp.mean : null, aPp = ppA(s), bPp = ppB(s);
  const counts = s.counts.every((c) => c == null) ? '–' : s.counts.map((c) => (c == null ? '–' : esc(c))).join(' / ');
  const item = (k, v) => `<dt>${esc(k)}</dt><dd>${v}</dd>`;
  const section = (title, pairs) => `<section><h4 class="detail-head">${esc(title)}</h4><dl>${pairs.join('')}</dl></section>`;
  const shift = shiftOf(s);
  const links = [
    linkFor(mapUrlOf(s), 'Beatmap'),
    linkFor(scoreUrlOf(s), 'Score'),
    linkFor(userUrlOf(state.uid), 'Player'),
  ].join(' ');

  const identity = section('Identity and links', [
    item('score_id', s.scid == null ? '–' : esc(s.scid)),
    item('beatmap_id', s.bid == null ? '–' : esc(s.bid)),
    item('beatmap_set_id', s.sid == null ? '–' : esc(s.sid)),
    item('mapper', s.mapper ? esc(s.mapper) : '– (not in this dataset)'),
    item('artist', esc(s.artist) || '–'),
    item('title', esc(s.title) || '–'),
    item('version', s.version ? esc(s.version) : '–'),
    item('keys / OD', `${s.keys == null ? '–' : esc(s.keys) + 'K'} / ${fmt(s.od, 1)}`),
    item('mods / mods_parts', `${esc(s.modsLabel)} <span class="hint">${esc(s.modsParts)}</span>`),
    item('osu! links', `<span class="links">${links}</span>`),
  ]);

  const ppPairs = state.algoIds.map((id) => {
    const v = s.pp[id] ?? null;
    const vsA = id === state.A ? ' (A)' : aPp != null && aPp > 0 && v != null ? ` · ${pct(v / aPp - 1, 2)} vs A` : '';
    const vsMean = v != null && mean != null ? ` · ${signed(v - mean, 2)} vs mean ${fmt(mean, 2)}` : '';
    const role = id === state.B ? ' (B)' : '';
    return item(`pp ${algoLabel(id)}${role}`, `${fmt(v, 3)}<span class="hint">${vsA}${vsMean}</span>`);
  });
  const ppSection = section('Pp per algorithm', [
    ...ppPairs,
    item('spread (max − min)', sp ? `${signed(sp.abs, 3)} <span class="hint">${pct(sp.rel, 2)} of the mean</span>` : '–'),
    item(`Δ ${algoLabel(state.B)} − ${algoLabel(state.A)}`, `${signed(diffOf(s), 3)} <span class="hint">${pct(relOf(s), 2)}</span>`),
    item('ratio B / A', aAspect(aPp, bPp)),
    item('rank A / B', `${scoreRank(s, state.A) ?? '–'} / ${scoreRank(s, state.B) ?? '–'}`),
    item('shift (B − A)', shift == null ? '–' : (shift > 0 ? '+' : '') + shift),
  ]);

  const stars = Array.from(state.starKeys).map((k) => item(`★ ${k}`, fmt(starValue(s, k), 4)));
  const breakdown = section('Accuracy and judgements', [
    item('accuracy', `${fmt(s.acc, 4)}%`),
    item('320 / 300 / 200', s.counts.slice(0, 3).map((c) => (c == null ? '–' : esc(c))).join(' / ')),
    item('100 / 50 / miss', s.counts.slice(3).map((c) => (c == null ? '–' : esc(c))).join(' / ')),
    item('judgements', `${counts}<span class="hint"> 320/300/200/100/50/miss</span>`),
    item('ln_ratio', `${fmt(s.ln, 4)} <span class="hint">LN ${fmt(s.ln == null ? null : s.ln * 100, 2)}%</span>`),
    item('LN bucket', lnBucketLabel(s.ln)),
    ...stars,
  ]);

  const internals = section('Reimagined internals', [
    item('eff_star', fmt(s.effStar, 4)),
    item('l_share', fmt(s.lShare, 4)),
    item('w (LN weight)', fmt(s.w, 4)),
    item('coord_mod', fmt(s.coordMod, 4)),
    item('acc_factor', fmt(s.accFactor, 4)),
    item('nf_factor', fmt(s.nfFactor, 4)),
  ]);

  return `<div class="detail-grid">${identity}${ppSection}${breakdown}${internals}</div>`;
}
const aAspect = (a, b) => (a != null && b != null && a > 0 ? fmt(b / a, 4) : '–');
const linkFor = (url, text) => (url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${text}</a>` : `<span>${text}</span>`);
/** Local aliases so core.js does not import the link helpers into its own namespace twice. */
const mapUrlOf = (s) => (s.bid != null && s.sid != null ? `https://osu.ppy.sh/beatmapsets/${s.sid}#mania/${s.bid}` : null);
const scoreUrlOf = (s) => (s.scid == null ? null : `https://osu.ppy.sh/scores/${s.scid}`);
const userUrlOf = (uid) => (uid == null ? null : `https://osu.ppy.sh/users/${uid}`);
