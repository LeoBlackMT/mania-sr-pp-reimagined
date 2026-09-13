'use strict';
/* ===========================================================================
 * mania-sr-pp-reimagined — dataset viewer.
 *
 * This repository is the algorithm repository of the Reimagined osu!mania pp
 * algorithm. The page renders the dataset the engine publishes; the four-way
 * comparison (Bancho / Sunny / Codexxy / Reimagined) exists because a new
 * algorithm has to be validated against the ones it competes with — so it is a
 * by-product of that validation, not the product.
 *
 * Vanilla ES module, no dependencies, no build step. Data contract in web.md.
 *
 *   1  configuration
 *   2  helpers
 *   3  state and accessors
 *   4  search language   (osu! beatmap-search syntax; used by both views)
 *   5  normalisation     (index document + player shard -> view models)
 *   6  layers            (derived from the data, never from a fixed list)
 *   7  tables            (shared header + sort plumbing)
 *   8  routing           (hash URLs carry the view and its state)
 *   9  panels            (totals, score table, layers, disagreement, scatter)
 *  10  views             (rankings, player)
 *  11  csv
 *  12  loading           (index, shards, empty state, manual file, drag & drop)
 *  13  events            (controls, keyboard, theme)
 * =========================================================================== */

/* ------------------------------ 1 configuration --------------------------- */

const INDEX_URL = 'data/index.json';   // sibling of this page; Pages serves docs/ as the root
const DATA_DIR = 'data/';              // prefix for the shard paths listed in the index
const SCHEMA_VERSION = 3;              // index + columnar player shards
const KNOWN_ALGOS = ['bancho', 'sunny', 'codexxy', 'reimagined'];

const PAGE_SIZE = 150;                 // rows added by one "Show more" click
const TOP_DISAGREE = 15;               // rows in the disagreement list
const WARN_LIMIT = 25;                 // engine warnings printed in the footer

const LN_RC = 0.10;                    // ln_ratio < 0.10 -> RC
const LN_HB = 0.90;                    // 0.10 .. 0.90 -> HB, > 0.90 -> LN
const LN_BUCKETS = [                   // the only LN split anywhere on this page
  { id: 'RC', label: 'RC', test: (v) => v != null && v < LN_RC },
  { id: 'HB', label: 'HB', test: (v) => v != null && v >= LN_RC && v <= LN_HB },
  { id: 'LN', label: 'LN', test: (v) => v != null && v > LN_HB },
];
const LN_GRADES = { RC: `ln_ratio < ${LN_RC}`, HB: `${LN_RC} ≤ ln_ratio ≤ ${LN_HB}`, LN: `ln_ratio > ${LN_HB}` };
const SHIFT_MID = 4;                   // |rank shift| that counts as a visible move
const SHIFT_BIG = 10;                  // |rank shift| that counts as a large move
const CSV_ORDER = [                    // score CSV column order
  'score_id', 'beatmap_id', 'beatmap_set_id', 'artist', 'title', 'version', 'mapper',
  'keys', 'od', 'mods', 'accuracy', 'n320', 'n300', 'n200', 'n100', 'n50', 'miss',
  'star_bancho', 'star_sunny', 'star_rice', 'ln_ratio', 'l_share', 'w', 'coord_mod',
  'eff_star', 'acc_factor', 'nf_factor',
];
const SAMPLE_FIXTURE = 'fixtures/bp-lists.tsv';
const SAMPLE_MAPS = '/path/to/osu/map/cache';
const REPO_URL = 'https://github.com/LeoBlackLT/mania-sr-pp-reimagined';
const THEME_KEY = 'mania-sr-pp.theme';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const els = {
  html: document.documentElement,
  meta: $('#meta'), note: $('#source-note'), legend: $('#legend'), prov: $('#prov'),
  themeBtn: $('#theme-toggle'), themeLabel: $('#theme-label'), themeIcon: $('#theme-icon'),
  loadOpen: $('#load-open'), fileInput: $('#file-input'),
  loader: $('#loader'), loaderWhy: $('#loader-why'), loaderHint: $('#loader-hint'),
  loaderCmd: $('#loader-cmd'), loaderErr: $('#loader-err'), loaderBrowse: $('#loader-browse'),
  drop: $('#drop'), dragHint: $('#drag-hint'),
  viewPlayers: $('#view-players'), viewPlayer: $('#view-player'),
  playersQ: $('#players-q'), playersReset: $('#players-reset'), playersCount: $('#players-q-count'),
  playersTable: $('#players-table'), playersNote: $('#players-note'),
  backLink: $('#back-link'), playerTitle: $('#player-title'), playerSub: $('#player-sub'),
  panelSummary: $('#panel-summary'), panelShardError: $('#panel-shard-error'),
  shardErrorTitle: $('#shard-error-title'), shardErrorText: $('#shard-error-text'),
  shardErrorHint: $('#shard-error-hint'), shardRetry: $('#shard-retry'),
  panelScores: $('#panel-scores'), panelLayers: $('#panel-layers'), panelDisagree: $('#panel-disagree'),
  algoA: $('#algo-a'), algoB: $('#algo-b'), swapAB: $('#swap-ab'),
  totalTable: $('#total-table'), abLine: $('#ab-line'), totalNote: $('#total-note'), abNote: $('#ab-note'),
  scoresQ: $('#scores-q'), scoresReset: $('#scores-reset'), searchState: $('#search-state'),
  searchWarn: $('#search-warn'), help: $('#help'), helpExamples: $('#help-examples'),
  helpFields: $('#help-fields'), helpPlayerFields: $('#help-player-fields'),
  helpFieldsNote: $('#help-fields-note'),
  scoreTable: $('#score-table'), scoreCount: $('#score-count'), showMore: $('#show-more'),
  exportCsv: $('#export-csv'), layerTable: $('#layer-table'), layerNote: $('#layer-note'),
  disagree: $('#disagree'), scatter: $('#scatter'), scatterNote: $('#scatter-note'),
};

/* -------------------------------- 2 helpers ------------------------------- */

/** Escape anything taken from the JSON before it reaches innerHTML. */
const escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => escapeMap[c]);

/** Finite number, or null when absent/unparsable. Nulls print "–" and sort last. */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
const fmt = (v, d = 2) => (v == null ? '–' : Number(v).toFixed(d));
const fmtInt = (v) => (v == null ? '–' : String(Math.round(v)));
const fmtG = (v, d = 1) => (v == null ? '–'
  : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const signed = (v, d = 1) => (v == null ? '–' : (v > 0 ? '+' : '') + Number(v).toFixed(d));
const pct = (v, d = 1) => (v == null ? '–' : (v > 0 ? '+' : '') + (v * 100).toFixed(d) + '%');
const pctPlain = (v, d = 1) => (v == null ? '–' : (v * 100).toFixed(d) + '%');
const dirClass = (v) => (v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function debounce(fn, ms) {
  let t = 0;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** "2026-09-13T10:40:33Z" -> "2026-09-13 10:40 UTC"; unparsable input passes through. */
function fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? String(iso) : d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}
function median(values) {
  if (!values.length) return null;
  const a = values.slice().sort((x, y) => x - y), mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/* osu! links. A wrong or guessed link is worse than none, so each helper
   returns null unless every id it needs is present. */
const mapUrl = (s) => (s.bid != null && s.sid != null
  ? `https://osu.ppy.sh/beatmapsets/${s.sid}#mania/${s.bid}` : null);
const scoreUrl = (s) => (s.scid != null ? `https://osu.ppy.sh/scores/${s.scid}` : null);
const userUrl = (uid) => (uid == null ? null : `https://osu.ppy.sh/users/${uid}`);
/** A link when the URL exists, plain text otherwise — never a broken href. */
const link = (url, text, extra = '') => (url
  ? `<a href="${esc(url)}"${extra}>${text}</a>` : `<span${extra}>${text}</span>`);

/* --------------------------- 3 state and accessors ------------------------ */

const state = {
  source: null,          // raw index document, plus {origin, filename}
  users: [],             // index entries: metadata + weighted totals, no scores
  algoIds: [],           // algorithm ids, KNOWN_ALGOS first
  algoMeta: new Map(),   // id -> {id, label, description}

  ranks: new Map(),      // algorithm id -> Map(uidKey -> rank over the index totals)
  totalsRanked: false,

  uid: null,             // the player the detail view shows
  scores: [],            // normalised scores of that player
  scoreRanks: null,      // {a: [rank], b: [rank]} over the whole bp list
  shard: 'empty',        // empty | loading | ready | error
  shardError: null,      // message for the error panel
  shardToken: 0,         // guards against an out-of-order shard response
  eagerShard: null,      // a shard dropped in on its own

  A: null,               // baseline algorithm
  B: null,               // compared algorithm

  route: 'players',      // players | player
  view: { players: null, player: null },   // per-view state, owned by the hash
  playersSort: { key: 'pp:bancho', dir: -1 },
  playerSort: { key: 'rank:reimagined', dir: 1 },
  shown: PAGE_SIZE,
  open: new Set(),       // indices of expanded score rows
  loadError: null,       // message from a manual load that failed
};

const player = () => state.users.find((u) => u.uid === state.uid) || null;
const uidKey = (u) => (u.uid == null ? `n:${u.username}` : `u:${u.uid}`);
const algoMeta = (id) => (state.algoMeta.get(id) || { id, label: id, description: 'no description in this dataset' });
const algoLabel = (id) => (id == null ? '–' : algoMeta(id).label);
const dotClass = (id) => `c-${KNOWN_ALGOS.includes(id) ? id : 'other'}`;

function resolveAlgorithms(raw) {
  const declared = (Array.isArray(raw?.algorithms) ? raw.algorithms : []).filter((a) => a && a.id);
  state.algoMeta = new Map(declared.map((a) => [String(a.id), {
    id: String(a.id), label: String(a.label || a.id), description: String(a.description || ''),
  }]));
  const pool = new Set(state.algoMeta.keys());
  for (const u of state.users) for (const id of Object.keys(u.totalPp || {})) pool.add(String(id));
  const ordered = KNOWN_ALGOS.filter((id) => pool.has(id));
  for (const id of Array.from(pool).sort()) if (!ordered.includes(id)) ordered.push(id);
  state.algoIds = ordered;
  if (!state.A || !state.algoIds.includes(state.A)) {
    state.A = state.algoIds.includes('bancho') ? 'bancho' : (state.algoIds[0] ?? null);
  }
  if (!state.B || !state.algoIds.includes(state.B)) {
    state.B = state.algoIds.includes('reimagined') ? 'reimagined'
      : (state.algoIds[state.algoIds.length - 1] ?? null);
  }
  if (state.B === state.A) state.B = state.algoIds.find((id) => id !== state.A) ?? state.A;
}

/* ----- per-score accessors ----- */

const ppOf = (s, id) => (id == null || !s ? null : (s.pp[id] ?? null));
const ppA = (s) => ppOf(s, state.A);
const ppB = (s) => ppOf(s, state.B);
/** B − A on one score; null unless both algorithms priced it. */
function diffOf(s) {
  const a = ppA(s), b = ppB(s);
  return a == null || b == null ? null : b - a;
}
/** Relative difference B / A − 1, as a share; null when A has no pp or A ≤ 0. */
function relOf(s) {
  const a = ppA(s), b = ppB(s);
  return a == null || b == null || !(a > 0) ? null : b / a - 1;
}
/** Rank shift B − A: positive means the score drops when the list is ordered by B. */
function shiftOf(s) {
  if (!state.scoreRanks || s.i == null) return null;
  const ra = state.scoreRanks.a[s.i], rb = state.scoreRanks.b[s.i];
  return ra == null || rb == null ? null : rb - ra;
}
const shiftClass = (v) => (v == null ? ''
  : Math.abs(v) >= SHIFT_BIG ? 'shift-big' : Math.abs(v) >= SHIFT_MID ? 'shift-mid' : '');

/** max − min spread across every algorithm that priced this score. */
function spreadOf(pp) {
  const vals = state.algoIds.map((id) => pp[id]).filter((v) => v != null);
  if (vals.length < 2) return null;
  const max = Math.max(...vals), min = Math.min(...vals);
  const mean = vals.reduce((x, y) => x + y, 0) / vals.length;
  return { max, min, mean, abs: max - min, rel: mean > 0 ? (max - min) / mean : null };
}

/* ----- per-player accessors ----- */

/** Dense rank per algorithm over the index totals (1 = highest). */
function refreshIndexRanks() {
  state.ranks = new Map(state.algoIds.map((id) => [id, new Map()]));
  for (const id of state.algoIds) {
    state.users.map((u, i) => ({ i, v: num(u.totalPp[id]) }))
      .filter((x) => x.v != null)
      .sort((a, b) => b.v - a.v || a.i - b.i)
      .forEach((x, k) => state.ranks.get(id).set(uidKey(state.users[x.i]), k + 1));
  }
  state.totalsRanked = true;
}
const playerRank = (u, id) => (state.totalsRanked ? (state.ranks.get(id)?.get(uidKey(u)) ?? null) : null);
/** B − A on a player's weighted total, and the same in percent. */
function playerDelta(u, id) {
  const base = num(u.totalPp[state.A]), v = num(u.totalPp[id]);
  return base == null || v == null ? null : v - base;
}
function playerRel(u, id) {
  const base = num(u.totalPp[state.A]), v = num(u.totalPp[id]);
  return base == null || v == null || !(base > 0) ? null : (v / base - 1) * 100;
}
/** ▲/▼: positive means the player climbs when the algorithm is switched. */
function playerMove(u, id) {
  const r = playerRank(u, id), ra = playerRank(u, state.A);
  return r == null || ra == null || id === state.A ? null : ra - r;
}

/** Weighted total of one algorithm: the index value when there is one, else
 *  (a shard loaded on its own) osu!'s 0.95 decay over that algorithm's order. */
function totalFor(id) {
  const u = player();
  if (!u) return { value: null, derived: false };
  const given = num(u.totalPp[id]);
  if (given != null) return { value: given, derived: false };
  const vals = state.scores.map((s) => s.pp[id]).filter((v) => v != null).sort((a, b) => b - a);
  if (!vals.length) return { value: null, derived: false };
  return { value: vals.reduce((acc, v, i) => acc + v * Math.pow(0.95, i), 0), derived: true };
}

/** Rank of every score in the whole bp list ordered by one algorithm (1 = best).
 *  Ties fall back to shard order so ranks are deterministic; a score an
 *  algorithm did not price has no rank. The ranking always covers the whole
 *  list — the search only decides which rows are displayed. */
function computeScoreRanks(list, id) {
  const rank = new Array(list.length).fill(null);
  list.map((s, i) => i).filter((i) => list[i].pp[id] != null)
    .sort((x, y) => list[y].pp[id] - list[x].pp[id] || x - y)
    .forEach((si, k) => { rank[si] = k + 1; });
  return rank;
}
function refreshScoreRanks() {
  state.scoreRanks = state.scores.length
    ? { a: computeScoreRanks(state.scores, state.A), b: computeScoreRanks(state.scores, state.B) }
    : null;
}

/* --------------------------- 4 search language ---------------------------- */
/* osu!'s beatmap-search shape: free text (ANDed) plus `field<op>value` terms,
   case-insensitive, operators = == : != < > <= >=. A name that is not a field
   we have falls back to free text, so a typo widens nothing and silently
   matching nothing is impossible. */

const SEARCH_OPS = ['!=', '==', '<=', '>=', '=', ':', '<', '>'];

/** Split on whitespace, keeping "quoted values" in one piece. */
function tokenize(q) {
  const out = [];
  let buf = '', quote = null;
  for (const ch of String(q)) {
    if (quote) { if (ch === quote) quote = null; else buf += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) { if (buf) out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

/** One query -> terms, against one field map: {kind, field, spec, op, value}. */
function parseQuery(q, fields) {
  return tokenize(q).map((raw) => {
    for (const op of SEARCH_OPS) {
      const at = raw.indexOf(op);
      if (at <= 0) continue;
      const name = raw.slice(0, at).toLowerCase();
      const spec = fields[name];
      if (!spec) continue;                       // not a field we have -> free text
      const value = raw.slice(at + op.length);
      return {
        kind: 'field', field: name, spec, raw,
        op: op === ':' ? '=' : op,
        valueNum: num(value), valueText: value.toLowerCase(),
      };
    }
    return { kind: 'text', value: raw.toLowerCase(), raw };
  });
}

const cmp = (x, y, op) => (op === '=' ? x === y : op === '!=' ? x !== y
  : op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : x >= y);

/** One field term against one row. A null value fails every operator, `!=`
 *  included, so "has no value" can never masquerade as a match. */
function matchTerm(term, item) {
  const v = term.spec.get(item);
  if (v == null) return false;
  if (term.spec.numeric) {
    const n = num(v);
    return n == null || term.valueNum == null ? false : cmp(n, term.valueNum, term.op);
  }
  return cmp(String(v).toLowerCase(), term.valueText, term.op);
}

const matchesScore = (parsed, s) => parsed.every((t) => (t.kind === 'text'
  ? s.text.includes(t.value) : matchTerm(t, s)));
const matchesPlayer = (parsed, u) => parsed.every((t) => (t.kind === 'text'
  ? u.text.includes(t.value) : matchTerm(t, u)));

/** Field names the current dataset cannot satisfy (map creator, say). */
const unsatisfiable = (parsed) => parsed
  .filter((t) => t.kind === 'field' && t.spec.mapper === false).map((t) => t.raw);

/* ----- score fields ----- */

const SCORE_FIELDS = (() => {
  const t = (get, mapper = true) => ({ get, numeric: false, mapper });
  const n = (get, mapper = true) => ({ get, numeric: true, mapper });
  const lnPct = (s) => (s.ln == null ? null : s.ln * 100);
  const modText = (s) => (s.modsLabel === 'NM' ? 'nm' : s.modsParts);
  const fields = {
    artist: t((s) => s.artist),
    title: t((s) => s.title),
    diff: t((s) => s.version),
    version: t((s) => s.version),
    creator: t((s) => s.mapper),                 // `mapper` column of schema 3+
    mapper: t((s) => s.mapper),
    key: n((s) => s.keys),
    keys: n((s) => s.keys),
    od: n((s) => s.od),
    ln: n(lnPct),
    lns: n(lnPct),
    ln_ratio: n((s) => s.ln),
    mod: t(modText),
    mods: t(modText),
    acc: n((s) => s.acc),
    accuracy: n((s) => s.acc),
    star: n((s) => s.starBancho),
    stars: n((s) => s.starBancho),
    sr: n((s) => s.starBancho),
    star_bancho: n((s) => s.starBancho),
    sr_bancho: n((s) => s.starBancho),
    star_sunny: n((s) => s.starSunny),
    sr_sunny: n((s) => s.starSunny),
    star_rice: n((s) => s.starRice),
    sr_rice: n((s) => s.starRice),
    score_id: n((s) => s.scid),
    map_id: n((s) => s.bid),
    beatmap_id: n((s) => s.bid),
    set_id: n((s) => s.sid),
    beatmap_set_id: n((s) => s.sid),
    l_share: n((s) => s.lShare),
    w: n((s) => s.w),
    coord_mod: n((s) => s.coordMod),
    eff_star: n((s) => s.effStar),
    acc_factor: n((s) => s.accFactor),
    nf_factor: n((s) => s.nfFactor),
    // The A/B pair drives the unsuffixed names; `pp_<algo>` / `rank_<algo>` are
    // added below for every algorithm in the dataset.
    pp: n((s) => ppB(s)),
    delta: n((s) => diffOf(s)),
    rel: n((s) => { const r = relOf(s); return r == null ? null : r * 100; }),
    rank: n((s) => (state.scoreRanks ? state.scoreRanks.b[s.i] : null)),
  };
  for (const id of KNOWN_ALGOS) {
    fields[`pp_${id}`] = n((s) => s.pp[id]);
    fields[`rank_${id}`] = n((s) => (state.scoreRanks ? state.scoreRanks.b[s.i] : null));
  }
  return fields;
})();

/* ----- player fields ----- */

/** `pp`, `pp_<algo>`, `rank`, `rank_<algo>`, `delta_<algo>`, `rel_<algo>` and
 *  `move_<algo>` for every algorithm in the dataset, so an added algorithm is
 *  searchable without a page change. */
function rebuildPlayerFields() {
  const fields = {
    uid: { get: (u) => u.uid, numeric: true, mapper: true },
    username: { get: (u) => u.username, numeric: false, mapper: true },
    user: { get: (u) => u.username, numeric: false, mapper: true },
    name: { get: (u) => u.username, numeric: false, mapper: true },
    scores: { get: (u) => u.scoreCount, numeric: true, mapper: true },
    score_count: { get: (u) => u.scoreCount, numeric: true, mapper: true },
    fixture: { get: (u) => u.fixture, numeric: false, mapper: true },
    pp: { get: (u) => u.totalPp[state.B], numeric: true, mapper: true },
    rank: { get: (u) => playerRank(u, state.B), numeric: true, mapper: true },
    delta: { get: (u) => playerDelta(u, state.B), numeric: true, mapper: true },
    rel: { get: (u) => playerRel(u, state.B), numeric: true, mapper: true },
    move: { get: (u) => playerMove(u, state.B), numeric: true, mapper: true },
  };
  for (const id of state.algoIds) {
    const key = id.toLowerCase();
    fields[`pp_${key}`] = { get: (u) => u.totalPp[id], numeric: true, mapper: true };
    fields[`total_${key}`] = { get: (u) => u.totalPp[id], numeric: true, mapper: true };
    fields[`rank_${key}`] = { get: (u) => playerRank(u, id), numeric: true, mapper: true };
    fields[`delta_${key}`] = { get: (u) => playerDelta(u, id), numeric: true, mapper: true };
    fields[`rel_${key}`] = { get: (u) => playerRel(u, id), numeric: true, mapper: true };
    fields[`move_${key}`] = { get: (u) => playerMove(u, id), numeric: true, mapper: true };
  }
  PLAYER_FIELDS = fields;
}
let PLAYER_FIELDS = {
  uid: { get: (u) => u.uid, numeric: true, mapper: true },
  username: { get: (u) => u.username, numeric: false, mapper: true },
};

/* ---------------------------- 5 normalisation ----------------------------- */

/** Index entry -> metadata only; the scores live in the shard. */
function normalizeUser(raw) {
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

/** A shard row is an ARRAY in `columns` order. Unknown columns are ignored and
 *  a missing optional column reads as null, so an older or newer dataset still
 *  renders — the Reimagined internals simply show "–". */
function normalizeScore(row, at, i) {
  const g = (name) => {
    const k = at.get(name);
    return k === undefined || row[k] === undefined ? null : row[k];
  };
  const pp = {};
  for (const id of state.algoIds) pp[id] = num(g(`pp_${id}`));
  const mods = String(g('mods') ?? '').trim().toUpperCase();
  const modsParts = String(g('mods_parts') ?? '').trim().toUpperCase();
  const s = {
    i,
    scid: num(g('score_id')), bid: num(g('beatmap_id')), sid: num(g('beatmap_set_id')),
    artist: String(g('artist') ?? ''), title: String(g('title') ?? ''),
    version: String(g('version') ?? ''),
    // The engine emits this column as `mapper` today; accept `creator` too so a differently
    // named dataset still works instead of silently losing the field.
    mapper: (g('mapper') ?? g('creator')) == null ? null : String(g('mapper') ?? g('creator')),
    keys: num(g('keys')), od: num(g('od')),
    mods, modsLabel: mods === '' ? 'NM' : mods,
    modsParts: modsParts || (mods === '' ? 'NM' : mods),
    acc: num(g('accuracy')),
    counts: ['n320', 'n300', 'n200', 'n100', 'n50', 'miss'].map((k) => num(g(k))),
    pp,
    starBancho: num(g('star_bancho')), starSunny: num(g('star_sunny')), starRice: num(g('star_rice')),
    ln: num(g('ln_ratio')), lShare: num(g('l_share')), w: num(g('w')), coordMod: num(g('coord_mod')),
    effStar: num(g('eff_star')), accFactor: num(g('acc_factor')), nfFactor: num(g('nf_factor')),
  };
  s.text = [s.artist, s.title, s.version, s.mapper ?? '', s.modsLabel, s.modsParts,
    s.bid ?? '', s.sid ?? '', s.keys ?? ''].join(' ').toLowerCase();
  return s;
}

/** Columnar shard -> normalised scores, folding in any extra `pp_*` column. */
function normalizeShard(raw, fallback) {
  const columns = Array.isArray(raw?.columns) ? raw.columns.map(String) : [];
  const extra = columns.filter((c) => c.startsWith('pp_') && c.length > 3).map((c) => c.slice(3));
  if (extra.length) {
    const pool = new Set([...state.algoIds, ...extra]);
    const ordered = KNOWN_ALGOS.filter((id) => pool.has(id));
    for (const id of Array.from(pool).sort()) if (!ordered.includes(id)) ordered.push(id);
    state.algoIds = ordered;
    rebuildPlayerFields();
  }
  const at = new Map(columns.map((c, i) => [c, i]));
  const rows = Array.isArray(raw?.scores) ? raw.scores : [];
  return rows.filter(Array.isArray).map((r, i) => normalizeScore(r, at, i));
}

/* -------------------------------- 6 layers -------------------------------- */
/* Mods are matched on `mods_parts` (falling back to `mods`) by substring, since
   the engine may emit both "EZDT" and "EZDT V2". */

const modHay = (s) => s.modsParts || s.mods;
const hasMod = (s, flag) => modHay(s).includes(flag);
const isNm = (s) => modHay(s) === '' || modHay(s) === 'NM';
const rateUp = (s) => hasMod(s, 'DT') || hasMod(s, 'NC');
const rateDown = (s) => hasMod(s, 'HT') || hasMod(s, 'DC');

/** Layer families. Every family partitions the bp list, so the rows of one
 *  family add up to its size — and only buckets that actually occur come back:
 *  as many layers as there are, no more, no fewer. */
function layerFamilies(list) {
  const fams = [];
  const keyRows = [4, 6, 7].filter((k) => list.some((s) => s.keys === k))
    .map((k) => ({ id: `k${k}`, name: `${k}K`, grade: `${k} keys`, test: (s) => s.keys === k }));
  const otherKeys = (s) => s.keys == null || ![4, 6, 7].includes(s.keys);
  if (list.some(otherKeys)) keyRows.push({ id: 'kother', name: 'Other key modes', grade: 'not 4K, 6K or 7K', test: otherKeys });
  if (keyRows.length) fams.push({ title: 'By key mode', rows: keyRows });

  const modRows = [];
  if (list.some(isNm)) modRows.push({ id: 'nm', name: 'NM', grade: 'no mods', test: isNm });
  if (list.some(rateUp)) modRows.push({ id: 'dt', name: 'Rate-up', grade: 'DT · NC', test: rateUp });
  if (list.some(rateDown)) modRows.push({ id: 'ht', name: 'Rate-down', grade: 'HT · DC', test: rateDown });
  const otherMods = (s) => !isNm(s) && !rateUp(s) && !rateDown(s);
  if (list.some(otherMods)) modRows.push({ id: 'other', name: 'Other mods', grade: 'neither rate-up nor rate-down', test: otherMods });
  if (modRows.length) fams.push({ title: 'By mod family', rows: modRows });

  const styleRows = LN_BUCKETS.filter((b) => list.some((s) => b.test(s.ln)))
    .map((b) => ({ id: b.id, name: b.label, grade: LN_GRADES[b.id], test: (s) => b.test(s.ln) }));
  if (list.some((s) => s.ln == null)) {
    styleRows.push({ id: 'lnunk', name: 'No ln_ratio', grade: 'missing in the dataset', test: (s) => s.ln == null });
  }
  if (styleRows.length) fams.push({ title: 'By LN share (ln_ratio)', rows: styleRows });
  return fams;
}

/** LN bucket of one value, using the one set of cut-offs the page has. */
function lnBucketLabel(ln) {
  if (ln == null) return '–';
  const b = LN_BUCKETS.find((x) => x.test(ln));
  return b ? b.label : '–';
}

/* -------------------------------- 7 tables -------------------------------- */

/** Sortable header row from a column list; one descriptor per column carries
 *  both the header metadata and the cell renderer, so they cannot drift. */
function headHtml(columns) {
  const cells = columns.map((c) => {
    if (!c.key) {
      return `<th scope="col" class="${c.headClass || ''}">`
        + `${c.label ? esc(c.label) : '<span class="sr-only">Expand</span>'}</th>`;
    }
    return `<th scope="col" class="sortable ${c.type === 'num' ? 'num' : ''} ${c.headClass || ''}" `
      + `data-key="${esc(c.key)}" data-type="${c.type}" aria-sort="none" `
      + `title="${esc(c.title || 'Click to sort')}">${esc(c.label)}</th>`;
  }).join('');
  return `<tr>${cells}</tr>`;
}

/** Sorting re-renders only the tbody; the header is patched in place, which
 *  keeps click-to-sort cheap and leaves the scroll position alone. */
function patchSort(table, sort, columns) {
  $$('th[data-key]', $('thead', table)).forEach((th) => {
    const active = th.dataset.key === sort.key;
    th.setAttribute('aria-sort', active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none');
    const col = columns.find((c) => c.key === th.dataset.key);
    if (col) th.title = col.title || 'Click to sort';
  });
}

/** First click on a column sorts it ascending when it reads as text, descending
 *  when it reads as a number; clicking the active column flips it. */
function nextSort(sort, key, type) {
  return { key, dir: sort.key === key ? -sort.dir : (type === 'num' ? -1 : 1) };
}

/** Nulls always sink to the bottom, whichever direction is active; ties fall
 *  back to a text key, then to source order, so every table is deterministic. */
function compareRows(a, b, key, dir, valueOf, textOf, order = (x) => x.i ?? 0) {
  const va = valueOf(a, key), vb = valueOf(b, key);
  const na = va == null, nb = vb == null;
  if (na || nb) return na && nb ? order(a) - order(b) : na ? 1 : -1;
  const numeric = typeof va === 'number' && typeof vb === 'number';
  const r = numeric ? va - vb : String(va) < String(vb) ? -1 : String(va) > String(vb) ? 1 : 0;
  return (r * dir) || textOf(a).localeCompare(textOf(b)) || (order(a) - order(b));
}

/* ------------------------------- 8 routing -------------------------------- */
/* #/players                rankings, state in the query string
 * #/player/{uid}           one player, state in the query string
 * Query: q (search), sort, dir, a (algorithm A), b (algorithm B). A and B are
 * global because they define the comparison; they are written into every hash
 * the page produces, so any view can be linked as it looks right now. */

const parseHashQuery = (search) => {
  const out = {};
  for (const part of String(search).replace(/^\?/, '').split('&')) {
    if (!part) continue;
    const at = part.indexOf('=');
    out[decodeURIComponent(at < 0 ? part : part.slice(0, at))] =
      at < 0 ? '' : decodeURIComponent(part.slice(at + 1));
  }
  return out;
};

/** Legacy/loose sort keys (`pp_bancho`, `rankA`, `rankB`) -> canonical ones. */
function normalizeSortKey(key) {
  if (!key) return null;
  if (key === 'rankA') return `rank:${state.A}`;
  if (key === 'rankB') return `rank:${state.B}`;
  const m = /^(pp|delta|rank)[_:](.+)$/.exec(key);
  if (!m) return key;
  const id = state.algoIds.find((a) => a.toLowerCase() === m[2].toLowerCase());
  return id ? `${m[1]}:${id}` : key;
}
const dirOf = (v, fallback) => (v === 'asc' ? 1 : v === 'desc' ? -1 : fallback);

/** Read the hash into state. Returns the route it resolved to.
 *  Every render starts from the defaults, so the hash alone decides what is on
 *  screen: a link handed to somebody else reproduces this page exactly, and a
 *  URL without a/b falls back to Bancho against Reimagined rather than silently
 *  keeping somebody else's pair. */
function readHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const qAt = raw.indexOf('?');
  const pathPart = qAt < 0 ? raw : raw.slice(0, qAt);
  const q = parseHashQuery(qAt < 0 ? '' : raw.slice(qAt + 1));
  const seg = pathPart.split('/').filter(Boolean);

  state.A = state.algoIds.includes('bancho') ? 'bancho' : (state.algoIds[0] ?? null);
  state.B = state.algoIds.includes('reimagined') ? 'reimagined'
    : (state.algoIds[state.algoIds.length - 1] ?? null);
  if (q.a && state.algoIds.includes(q.a)) state.A = q.a;
  if (q.b && state.algoIds.includes(q.b)) state.B = q.b;
  if (state.B === state.A && state.algoIds.length > 1) {
    state.B = state.algoIds.find((id) => id !== state.A) ?? state.B;
  }
  rebuildPlayerFields();
  refreshScoreRanks();

  if (seg[0] === 'player' && seg[1] != null) {
    const wanted = decodeURIComponent(seg[1]);
    const u = state.users.find((x) => String(x.uid) === wanted || x.username === wanted);
    if (u) {
      const key = normalizeSortKey(q.sort) ?? `rank:${state.B}`;
      state.view.player = { q: q.q ?? '', sort: key, dir: dirOf(q.dir, 1) };
      return { route: 'player', uid: u.uid };
    }
  }
  state.view.players = {
    q: q.q ?? '',
    sort: normalizeSortKey(q.sort) ?? 'pp:bancho',
    dir: dirOf(q.dir, -1),
  };
  return { route: 'players', uid: null };
}

/** Write the state of the current view back into the hash. */
function writeHash(replace = true) {
  const view = state.view[state.route] || { q: '', sort: '', dir: -1 };
  const p = new URLSearchParams();
  if (view.q) p.set('q', view.q);
  if (view.sort) p.set('sort', view.sort);
  p.set('dir', view.dir === 1 ? 'asc' : 'desc');
  if (state.A) p.set('a', state.A);
  if (state.B) p.set('b', state.B);
  const path = state.route === 'player'
    ? `#/player/${encodeURIComponent(String(state.uid))}` : '#/players';
  const url = `${path}?${p.toString()}`;
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
}

/* -------------------------------- 9 panels -------------------------------- */

const cellNum = (v, d = 0) => `<td class="num">${v == null ? '–' : (d ? fmt(v, d) : fmtInt(v))}</td>`;
const cellSigned = (v, d = 1) => `<td class="num ${dirClass(v)}">${signed(v, d)}</td>`;

/** Totals of this player: one row per algorithm, difference against A. */
function renderTotals() {
  const u = player(), head = $('thead', els.totalTable), body = $('tbody', els.totalTable);
  if (!state.algoIds.length || !u) {
    head.innerHTML = '';
    body.innerHTML = '<tr><td class="empty">This dataset carries no algorithm pp values.</td></tr>';
    els.abLine.textContent = '';
    els.totalNote.textContent = '';
    return;
  }
  head.innerHTML = '<tr><th scope="col">Algorithm</th><th scope="col" class="num">Weighted total pp</th>'
    + `<th scope="col" class="num">Δ vs ${esc(algoLabel(state.A))}</th><th scope="col" class="num">Δ %</th></tr>`;
  const base = totalFor(state.A).value;
  const rows = state.algoIds.map((id) => {
    const t = totalFor(id);
    const d = t.value != null && base != null ? t.value - base : null;
    return { id, label: algoMeta(id).label, total: t.value, derived: t.derived, d,
      rel: d != null && base ? d / base : null };
  });
  body.innerHTML = rows.map((r) => {
    const role = [r.id === state.A ? 'A' : null, r.id === state.B ? 'B' : null].filter(Boolean).join(' / ');
    return `<tr class="${r.id === state.A ? 'is-baseline' : ''}">`
      + `<td><span class="alg-name"><i class="dot ${dotClass(r.id)}"></i>${esc(r.label)}`
      + `${role ? `<span class="hint"> — ${esc(role)}</span>` : ''}</span></td>`
      + `<td class="num">${fmtG(r.total)}</td>`
      + `<td class="num ${dirClass(r.d)}">${r.id === state.A ? '–' : signed(r.d)}</td>`
      + `<td class="num ${dirClass(r.d)}">${r.id === state.A ? '–' : pct(r.rel)}</td></tr>`;
  }).join('');
  const tA = base, tB = totalFor(state.B).value;
  const dAB = tA != null && tB != null ? tB - tA : null;
  els.abLine.innerHTML = dAB == null
    ? '<span class="role">A / B</span> — one of the two algorithms carries no total for this player.'
    : `<span class="role">A</span> ${esc(algoLabel(state.A))} ${fmtG(tA)} `
      + `<span class="role">→ B</span> ${esc(algoLabel(state.B))} ${fmtG(tB)} `
      + `<span class="role">· diff (B − A)</span> <span class="${dirClass(dAB)}">${signed(dAB)}</span> `
      + `<span class="role">· relative (B / A − 1)</span> <span class="${dirClass(dAB)}">${pct(tA ? dAB / tA : null)}</span> `
      + `<span class="role">· ratio</span> ${fmt(tA ? tB / tA : null, 4)}`;
  const notes = ['Each total is a 0.95-decay sum over that algorithm\'s own ordering of this player\'s scores.'];
  if (rows.some((r) => r.derived)) notes.push('This file carries no total_pp, so the totals are derived from the shard.');
  if (state.algoIds.length < 2) notes.push('Only one algorithm carries numbers in this dataset.');
  els.totalNote.textContent = notes.join(' ');
}

/* ----- score table ----- */

const COUNT_LABELS = ['320', '300', '200', '100', '50', 'miss'];
const COUNT_TITLE = 'judgement counts 320 / 300 / 200 / 100 / 50 / miss';

/** Columns in the owner's order: rank (A, B, shift — B first because B is the
 *  default sort), map identity, the pp group, then the breakdown. Whatever is
 *  left — every Reimagined internal, the rice star, the ids, the links — lives
 *  in the detail row. */
function scoreColumns() {
  const A = algoLabel(state.A), B = algoLabel(state.B);
  const others = state.algoIds.filter((id) => id !== state.A && id !== state.B);
  return [
    { key: null, label: '', type: 'none', headClass: 'cell-toggle', cell: (s) => expandButton(s) },

    { key: `rank:${state.B}`, label: `Rank ${B}`, type: 'num', headClass: 'rank-cell blk',
      title: `Position of this score in the whole bp list ordered by ${B} (1 = best)`,
      cell: (s) => `<td class="num rank-cell">${state.scoreRanks?.b[s.i] ?? '–'}</td>` },
    { key: `rank:${state.A}`, label: `Rank ${A}`, type: 'num', headClass: 'rank-cell',
      title: `Position of this score ordered by ${A} (1 = best)`,
      cell: (s) => `<td class="num rank-cell">${state.scoreRanks?.a[s.i] ?? '–'}</td>` },
    { key: 'shift', label: 'Shift', type: 'num', headClass: 'blk',
      title: `rank ${B} − rank ${A}; positive means the score drops under ${B}. `
        + `Highlighted from |shift| ≥ ${SHIFT_MID}, strong from ≥ ${SHIFT_BIG}`,
      cell: (s) => {
        const sh = shiftOf(s);
        return `<td class="num shift ${shiftClass(sh)} ${dirClass(sh == null ? null : -sh)}">`
          + `${sh == null ? '–' : (sh > 0 ? '+' : '') + sh}</td>`;
      } },

    { key: 'map', label: 'Beatmap', type: 'str', headClass: 'blk',
      title: 'artist – title [difficulty]; the link needs a beatmap set id, so a score without one '
        + 'is rendered as text',
      cell: (s) => {
        const tt = `${s.artist} – ${s.title}${s.version ? ` [${s.version}]` : ''}`;
        const sub = [
          s.version ? `[${s.version}]` : '[no difficulty name]',
          s.mapper ? `mapped by ${esc(s.mapper)}` : 'mapper not in dataset',
        ].join(' · ');
        const ids = `b${s.bid ?? '?'} · s${s.sid ?? '?'}`;
        return `<td class="map">${link(mapUrl(s), esc(tt), ' class="ttl" target="_blank" rel="noopener noreferrer"')}`
          + `<span class="sub">${sub}</span><span class="ids">${ids}</span></td>`;
      } },
    { key: 'keys', label: 'Keys', type: 'num', title: 'key mode',
      cell: (s) => `<td class="num">${s.keys == null ? '–' : esc(s.keys) + 'K'}</td>` },
    { key: 'mods', label: 'Mods', type: 'str', title: 'mod acronym as the engine reports it',
      cell: (s) => `<td>${esc(s.modsLabel)}</td>` },

    { key: `pp:${state.A}`, label: `${A} pp`, type: 'num', headClass: 'blk',
      title: `${A} — the baseline side`,
      cell: (s) => cellNum(ppA(s), 2) },
    { key: `pp:${state.B}`, label: `${B} pp`, type: 'num', title: `${B} — the compared side`,
      cell: (s) => cellNum(ppB(s), 2) },
    { key: 'diff', label: 'Δ pp', type: 'num', title: `absolute difference ${B} − ${A}`,
      cell: (s) => cellSigned(diffOf(s), 2) },
    { key: 'rel', label: 'Δ %', type: 'num', title: `relative difference ${B} / ${A} − 1`,
      cell: (s) => `<td class="num ${dirClass(relOf(s))}">${pct(relOf(s), 2)}</td>` },
    ...others.map((id) => ({
      key: `pp:${id}`, label: `${algoLabel(id)} pp`, type: 'num', headClass: 'blk',
      title: `${algoLabel(id)} pp`,
      cell: (s) => cellNum(s.pp[id], 2),
    })),

    { key: 'acc', label: 'Acc %', type: 'num', headClass: 'blk', title: 'accuracy in percent',
      cell: (s) => cellNum(s.acc, 2) },
    ...COUNT_LABELS.map((label, i) => ({
      key: `count${i}`, label, type: 'num', title: COUNT_TITLE,
      cell: (s) => cellNum(s.counts[i], 0),
    })),
    { key: 'lnPct', label: 'LN %', type: 'num', headClass: 'blk',
      title: 'share of objects that are long notes, in percent — the layer cut-offs are 10% and 90%',
      cell: (s) => cellNum(s.ln == null ? null : s.ln * 100, 1) },
    { key: 'starBancho', label: '★ Bancho', type: 'num',
      title: "official osu! star rating — the difficulty source behind Bancho's pp",
      cell: (s) => cellNum(s.starBancho, 3) },
    { key: 'starSunny', label: '★ Sunny', type: 'num',
      title: "Sunny's star rating — the difficulty source behind Reimagined's R and L channels",
      cell: (s) => cellNum(s.starSunny, 3) },
  ];
}

function expandButton(s) {
  const open = state.open.has(s.i);
  return `<td class="cell-toggle"><button type="button" class="row-toggle" aria-expanded="${open}" `
    + `aria-label="${open ? 'Hide' : 'Show'} details for ${esc(s.artist)} – ${esc(s.title)}">`
    + `${open ? '−' : '+'}</button></td>`;
}

function rowHtml(s, columns) {
  const row = `<tr data-i="${s.i}">${columns.map((c) => c.cell(s)).join('')}</tr>`;
  if (!state.open.has(s.i)) return row;
  return row + `<tr class="detail"><td colspan="${columns.length}">${detailGrid(s)}</td></tr>`;
}

/** The expanded detail row: everything the data carries that the table above
 *  does not — ids and links, the Reimagined internals, the rice star, and every
 *  algorithm's pp with its delta against A and against the mean. */
function detailGrid(s) {
  const sp = spreadOf(s.pp), mean = sp ? sp.mean : null, aPp = ppA(s), bPp = ppB(s);
  const counts = s.counts.every((c) => c == null) ? '–'
    : s.counts.map((c) => (c == null ? '–' : esc(c))).join(' / ');
  const item = (k, v) => `<dt>${esc(k)}</dt><dd>${v}</dd>`;
  const section = (title, pairs) => `<section><h5>${esc(title)}</h5><dl>${pairs.join('')}</dl></section>`;
  const shift = shiftOf(s);

  const links = [
    link(mapUrl(s), 'Beatmap', ' target="_blank" rel="noopener noreferrer"'),
    link(scoreUrl(s), 'Score', ' target="_blank" rel="noopener noreferrer"'),
    link(userUrl(state.uid), 'Player', ' target="_blank" rel="noopener noreferrer"'),
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
    const vsA = id === state.A ? ' (A)'
      : aPp != null && aPp > 0 && v != null ? ` · ${pct(v / aPp - 1, 2)} vs A` : '';
    const vsMean = v != null && mean != null ? ` · ${signed(v - mean, 2)} vs mean ${fmt(mean, 2)}` : '';
    const role = id === state.B ? ' (B)' : '';
    return item(`pp ${algoMeta(id).label}${role}`, `${fmt(v, 3)}<span class="hint">${vsA}${vsMean}</span>`);
  });
  const ppSection = section('Pp per algorithm', [
    ...ppPairs,
    item('spread (max − min)', sp ? `${signed(sp.abs, 3)} <span class="hint">${pct(sp.rel, 2)} of the mean</span>` : '–'),
    item(`Δ ${algoLabel(state.B)} − ${algoLabel(state.A)}`,
      `${signed(diffOf(s), 3)} <span class="hint">${pct(relOf(s), 2)}</span>`),
    item('ratio B / A', aAspect(aPp, bPp)),
    item('rank A / B', `${state.scoreRanks?.a[s.i] ?? '–'} / ${state.scoreRanks?.b[s.i] ?? '–'}`),
    item('shift (B − A)', shift == null ? '–' : (shift > 0 ? '+' : '') + shift),
  ]);

  const breakdown = section('Accuracy and judgements', [
    item('accuracy', `${fmt(s.acc, 4)}%`),
    item('320 / 300 / 200', s.counts.slice(0, 3).map((c) => (c == null ? '–' : esc(c))).join(' / ')),
    item('100 / 50 / miss', s.counts.slice(3).map((c) => (c == null ? '–' : esc(c))).join(' / ')),
    item('judgements', `${counts}<span class="hint"> 320/300/200/100/50/miss</span>`),
    item('ln_ratio', `${fmt(s.ln, 4)} <span class="hint">LN ${fmt(s.ln == null ? null : s.ln * 100, 2)}%</span>`),
    item('LN bucket', lnBucketLabel(s.ln)),
    item('★ Bancho', fmt(s.starBancho, 4)),
    item('★ Sunny', fmt(s.starSunny, 4)),
  ]);

  const internals = section('Reimagined internals', [
    item('eff_star', fmt(s.effStar, 4)),
    item('★ rice', fmt(s.starRice, 4)),
    item('l_share', fmt(s.lShare, 4)),
    item('w (LN weight)', fmt(s.w, 4)),
    item('coord_mod', fmt(s.coordMod, 4)),
    item('acc_factor', fmt(s.accFactor, 4)),
    item('nf_factor', fmt(s.nfFactor, 4)),
  ]);

  return `<div class="detail-grid">${identity}${ppSection}${breakdown}${internals}</div>`;
}
const aAspect = (a, b) => (a != null && b != null && a > 0 ? fmt(b / a, 4) : '–');

/** The score table's rows: search, then sort. Ranks are unaffected by both. */
function scoreFilteredSorted() {
  const parsed = parseQuery(state.view.player?.q ?? '', SCORE_FIELDS);
  const rows = parsed.length ? state.scores.filter((s) => matchesScore(parsed, s)) : state.scores.slice();
  const sort = state.playerSort;
  rows.sort((a, b) => compareRows(a, b, sort.key, sort.dir, scoreSortValue,
    (s) => `${s.artist} ${s.title} ${s.version}`.toLowerCase(), (s) => s.i));
  return { rows, parsed };
}

function scoreSortValue(s, key) {
  switch (key) {
    case 'map': return `${s.artist} ${s.title} ${s.version}`.toLowerCase();
    case 'mods': return s.modsLabel.toLowerCase();
    case 'shift': return shiftOf(s);
    case 'diff': return diffOf(s);
    case 'rel': return relOf(s);
    case 'lnPct': return s.ln == null ? null : s.ln * 100;
    default: break;
  }
  if (key.startsWith('count')) return s.counts[Number(key.slice(5))] ?? null;
  if (key.startsWith('rank:')) {
    const id = key.slice(5);
    if (!state.scoreRanks) return null;
    return id === state.A ? state.scoreRanks.a[s.i] : id === state.B ? state.scoreRanks.b[s.i] : null;
  }
  if (key.startsWith('pp:')) return s.pp[key.slice(3)] ?? null;
  return s[key] ?? null;
}

function renderScoreTable() {
  const columns = scoreColumns();
  $('thead', els.scoreTable).innerHTML = headHtml(columns);
  const { rows, parsed } = scoreFilteredSorted();
  const slice = rows.slice(0, state.shown);
  $('tbody', els.scoreTable).innerHTML = slice.length
    ? slice.map((s) => rowHtml(s, columns)).join('')
    : `<tr><td colspan="${columns.length}" class="empty">${state.scores.length
      ? 'No score matches the current search.' : 'This bp list has no scores in this dataset.'}</td></tr>`;
  patchSort(els.scoreTable, state.playerSort, columns);

  const left = rows.length - state.shown;
  els.showMore.hidden = left <= 0;
  els.showMore.textContent = `Show more (${Math.min(PAGE_SIZE, left)} of ${left} remaining)`;
  els.scoreCount.textContent = `${slice.length} of ${rows.length} score${rows.length === 1 ? '' : 's'} shown`;
  els.exportCsv.disabled = !rows.length;

  const bits = [];
  if (parsed.length) {
    bits.push(`${rows.length} of ${state.scores.length} scores match`,
      `${parsed.length} term${parsed.length === 1 ? '' : 's'}`);
  }
  els.searchState.textContent = bits.join(' · ');
  const bad = unsatisfiable(parsed);
  els.searchWarn.hidden = !bad.length;
  els.searchWarn.textContent = bad.length
    ? `${bad.join(', ')}: this dataset carries no map creator, so this term matches nothing.` : '';
}

/* ----- layer summary ----- */

/** Layers aggregate the RELATIVE difference (B / A − 1) and are computed over
 *  the WHOLE bp list, deliberately ignoring the search: filtering to 4K would
 *  empty the 7K row and the summary would stop describing the player. */
function renderLayers() {
  const list = state.scores;
  if (!list.length) { els.layerTable.innerHTML = ''; els.layerNote.textContent = ''; return; }
  const stat = (test) => {
    const inLayer = list.filter(test);
    const rels = inLayer.map(relOf).filter((v) => v != null);
    return {
      n: inLayer.length, nBoth: rels.length, medRel: median(rels),
      medPp: median(inLayer.map(ppA).filter((v) => v != null)),
    };
  };
  const cells = (name, grade, st) => `<td class="layer-name">${esc(name)}</td>`
    + `<td class="hint">${esc(grade)}</td>`
    + `<td class="num" title="${st.n} score${st.n === 1 ? '' : 's'}, ${st.nBoth} priced by both A and B">${st.n}</td>`
    + `<td class="num ${dirClass(st.medRel)}">${pct(st.medRel, 2)}</td>`
    + `<td class="num">${fmt(st.medPp, 2)}</td>`;
  const body = layerFamilies(list).map((fam) => {
    const rows = fam.rows.map((r) => `<tr>${cells(r.name, r.grade, stat(r.test))}</tr>`).join('');
    return `<tr class="layer-group"><th colspan="5" scope="colgroup">${esc(fam.title)}</th></tr>${rows}`;
  }).join('');
  els.layerTable.innerHTML = '<table class="grid layers">'
    + '<caption class="sr-only">Layer summary over the whole bp list</caption>'
    + '<thead><tr><th scope="col">Layer</th><th scope="col">Definition</th><th scope="col" class="num">n</th>'
    + '<th scope="col" class="num">Median Δ (B vs A)</th><th scope="col" class="num">Median pp (A)</th></tr></thead>'
    + `<tbody>${body}<tr class="layer-total">${cells('All scores', 'every score of this bp list', stat(() => true))}</tr></tbody></table>`;
  els.layerNote.textContent = 'Rows list the layers that actually occur in this bp list — no empty '
    + 'buckets — and cover every score of it. The search above deliberately does not apply here: '
    + 'filtering to one key mode would empty the others. Δ is B / A − 1 per score and the median of that '
    + `column is shown; median pp is the median of ${algoLabel(state.A)}'s pp inside the layer. Only one `
    + 'category is assigned per score, so the rows inside a family add up to the list size. Rate-up is '
    + 'DT · NC and rate-down is HT · DC, matched as substrings of mods_parts.';
}

/* ----- disagreement and scatter ----- */

function renderDisagreement(list) {
  const rows = list.map((s) => ({ s, sp: spreadOf(s.pp) }))
    .filter((x) => x.sp && x.sp.rel != null)
    .sort((a, b) => b.sp.rel - a.sp.rel || b.sp.abs - a.sp.abs || (a.s.i - b.s.i))
    .slice(0, TOP_DISAGREE);
  if (!rows.length) {
    els.disagree.innerHTML = '<p class="empty">Not enough algorithms priced these scores to measure disagreement.</p>';
    return;
  }
  els.disagree.innerHTML = rows.map((x, i) => {
    const s = x.s, sp = x.sp;
    const pps = state.algoIds.map((id) => `<span class="dis-pp" title="pp ${esc(algoMeta(id).label)}">`
      + `${fmt(s.pp[id] ?? null, 1)}</span>`).join('');
    const meta = [s.keys == null ? null : `${s.keys}K`, s.modsLabel,
      s.ln == null ? null : `LN ${fmt(s.ln * 100, 1)}%`].filter(Boolean).join(' · ');
    const open = state.open.has(s.i);
    return `<div class="dis-row" data-i="${s.i}">`
      + `<button type="button" class="dis-row-main" aria-expanded="${open}">`
      + `<span class="dis-rank">${i + 1}</span>`
      + `<span class="dis-map">${esc(s.artist)} – ${esc(s.title)} <span class="ver">[${esc(s.version || '?')}]</span> `
      + `<span class="meta">${esc(meta)}</span></span>${pps}`
      + `<span class="dis-spread">${pct(sp.rel, 1)}</span>`
      + `<span class="dis-pp dis-extra">${signed(sp.abs, 1)}</span></button>`
      + (open ? `<div class="dis-detail">${detailGrid(s)}</div>` : '') + '</div>';
  }).join('');
}

/** Scatter: x = ln_ratio over the fixed [0, 1] domain, y = the relative
 *  difference of B against A, one dot per score. The dashed rules are the RC /
 *  HB / LN cut-offs — the same numbers the layer table uses. */
function renderScatter(list) {
  const pts = list.filter((s) => s.ln != null && relOf(s) != null).map((s) => ({ s, x: s.ln, y: relOf(s) }));
  const skipped = list.length - pts.length;
  if (!pts.length) {
    els.scatter.innerHTML = '<p class="empty">No score here is priced by both A and B and carries an ln_ratio.</p>';
    els.scatterNote.textContent = skipped ? `${skipped} score${skipped === 1 ? '' : 's'} skipped.` : '';
    return;
  }
  const W = 620, H = 310, L = 52, R = 16, T = 18, B = 46;
  const x0 = L, x1 = W - R, y0 = T, y1 = H - B, mid = (y0 + y1) / 2, half = (y1 - y0) / 2;
  const yMax = Math.max(0.02, ...pts.map((p) => Math.abs(p.y))) * 1.08;
  const xAt = (v) => x0 + clamp(v, 0, 1) * (x1 - x0);
  const yAt = (v) => mid - (v / yMax) * half;
  const med = median(pts.map((p) => p.y));
  const signedPct = (v) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
  const ticks = [yMax, yMax / 2, 0, -yMax / 2, -yMax].map((v) => `<line class="${v === 0 ? 'zero' : 'rule'}" `
      + `x1="${x0}" x2="${x1}" y1="${yAt(v).toFixed(1)}" y2="${yAt(v).toFixed(1)}"/>`
      + `<text x="${x0 - 6}" y="${(yAt(v) + 3.5).toFixed(1)}" text-anchor="end">${pctPlain(v)}</text>`).join('');
  const rules = [LN_RC, LN_HB].map((v) => `<line class="bucket" x1="${xAt(v).toFixed(1)}" `
    + `x2="${xAt(v).toFixed(1)}" y1="${y0}" y2="${y1}"/>`).join('');
  const ruleLabels = `<text class="bucket-label" x="${xAt(LN_RC) + 3}" y="${y1 - 4}">${LN_RC}</text>`
    + `<text class="bucket-label" x="${xAt(LN_HB) + 3}" y="${y1 - 4}">${LN_HB}</text>`;
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((v) => `<text x="${xAt(v).toFixed(1)}" y="${y1 + 14}" `
    + `text-anchor="middle">${v}</text>`).join('');
  const dots = pts.map((p) => `<circle class="dot" cx="${xAt(p.x).toFixed(1)}" cy="${yAt(p.y).toFixed(1)}" r="3">`
    + `<title>${esc(p.s.artist)} – ${esc(p.s.title)} [${esc(p.s.version || '?')}] · ln_ratio ${fmt(p.x, 4)} · `
    + `${esc(algoLabel(state.B))} vs ${esc(algoLabel(state.A))} ${signedPct(p.y)}</title></circle>`).join('');
  const yMed = yAt(clamp(med, -yMax, yMax));
  els.scatter.innerHTML = `<svg class="scatter" viewBox="0 0 ${W} ${H}" role="img" `
    + `aria-label="relative difference of ${esc(algoLabel(state.B))} against ${esc(algoLabel(state.A))} by ln_ratio, one dot per score">`
    + ticks + rules + ruleLabels
    + `<line class="rule" x1="${x0}" x2="${x1}" y1="${y1}" y2="${y1}"/>`
    + `<line class="rule" x1="${x0}" x2="${x0}" y1="${y0}" y2="${y1}"/>`
    + `<line class="median" x1="${x0}" x2="${x1}" y1="${yMed.toFixed(1)}" y2="${yMed.toFixed(1)}"/>`
    + `<text class="median-label" x="${x1 - 2}" y="${(yMed - 4).toFixed(1)}" text-anchor="end">median ${signedPct(med)}</text>`
    + dots + xTicks
    + `<text class="axis-label" x="${x0}" y="${H - 12}">ln_ratio — share of long notes `
    + `(rules at ${LN_RC} and ${LN_HB}: RC / HB / LN)</text>`
    + `<text class="axis-label" x="0" y="12">${esc(algoLabel(state.B))} vs ${esc(algoLabel(state.A))}</text></svg>`;
  const bucketMed = LN_BUCKETS.map((b) => {
    const ys = pts.filter((p) => b.test(p.x)).map((p) => p.y);
    return { b, v: median(ys), n: ys.length };
  }).filter((x) => x.v != null);  els.scatterNote.textContent = `${pts.length} score${pts.length === 1 ? '' : 's'} plotted, `
    + `y axis ±${pctPlain(yMax)}; median ${signedPct(med)}`
    + bucketMed.map((x) => `, ${x.b.label} median ${signedPct(x.v)} (n=${x.n})`).join('')
    + '. A gap between the bucket medians is the systematic long-note preference.'
    + (skipped ? ` ${skipped} score${skipped === 1 ? '' : 's'} skipped (no ln_ratio or no pp on one side).` : '');
}

/* ------------------------------- 10 views --------------------------------- */

function renderRoutes() {
  // With no dataset there is no view at all — the loader above is the page.
  const hasData = !!state.source;
  els.viewPlayers.hidden = !hasData || state.route !== 'players';
  els.viewPlayer.hidden = !hasData || state.route !== 'player';
  const u = player();
  document.title = state.route === 'player' && u
    ? `${u.username} — mania-sr-pp-reimagined`
    : 'mania-sr-pp-reimagined — osu!mania PP algorithm';
}

function renderLegend() {
  const ids = state.algoIds.length ? state.algoIds : KNOWN_ALGOS;
  els.legend.innerHTML = ids.map((id) => {
    const m = algoMeta(id);
    const roles = [id === state.A ? 'A' : null, id === state.B ? 'B' : null].filter(Boolean);
    return `<div class="card"><div class="name"><i class="dot ${dotClass(id)}"></i>${esc(m.label)}`
      + `${roles.length ? `<span class="role"> — ${esc(roles.join(' / '))}</span>` : ''}</div>`
      + `<div class="desc">${esc(m.description)}</div></div>`;
  }).join('');
  els.legend.hidden = !ids.length;
}

/* ----- rankings ----- */

/** Identity, then per algorithm: the weighted total, the rank, and the absolute
 *  and relative difference against the anchor (Bancho, or A once A changes).
 *  Every value comes from the index, so the table needs no shard. */
function rankingColumns() {
  const anchor = state.algoIds.includes('bancho') ? 'bancho' : state.A;
  const columns = [
    { key: 'username', label: 'Player', type: 'str', title: 'Click a row to open that player',
      cell: (u) => `<td class="pname">${esc(u.username)}`
        + `${u.uid == null ? '' : `<span class="uid"> #${esc(u.uid)}</span>`}</td>` },
    { key: 'scores', label: 'Scores', type: 'num', title: 'scores in this dataset',
      cell: (u) => `<td class="num">${esc(u.scoreCount)}</td>` },
  ];
  for (const id of state.algoIds) {
    const label = algoLabel(id);
    const isAnchor = id === anchor;
    columns.push({
      key: `pp:${id}`, label, type: 'num', headClass: 'blk',
      title: `${label}: weighted total pp`,
      cell: (u) => `<td class="num">${fmtG(num(u.totalPp[id]), 1)}</td>`,
    });
    columns.push({
      key: `rank:${id}`, label: `${label} rank`, type: 'num',
      title: `${label}: rank over the players in this dataset (1 = highest weighted total)`,
      cell: (u) => `<td class="num rank">${playerRank(u, id) ?? '–'}${moveBadge(u, id, anchor)}</td>`,
    });
    columns.push({
      key: `delta:${id}`, label: `Δ ${label}`, type: 'num', headClass: 'blk',
      title: isAnchor ? `the anchor column (${label})` : `${label} minus ${algoLabel(anchor)}, absolute and %`,
      cell: (u) => {
        const d = playerDelta(u, id), r = playerRel(u, id);
        if (isAnchor) return '<td class="num">–</td>';
        return `<td class="num ${dirClass(d)}">${signed(d, 1)}`
          + `<span class="hint"> ${r == null ? '–' : pct(r / 100, 1)}</span></td>`;
      },
    });
  }
  return columns;
}

/** ▲/▼ against the anchor's rank for the same player. */
function moveBadge(u, id, anchor) {
  if (id === anchor) return '';
  const move = playerMove(u, id);
  if (move == null) return '';
  if (move === 0) return '<span class="hint rank-move">=</span>';
  return `<span class="rank-move ${dirClass(move)}" title="${move > 0 ? 'up' : 'down'} ${Math.abs(move)} `
    + `against ${esc(algoLabel(anchor))}">${move > 0 ? '▲' : '▼'}${Math.abs(move)}</span>`;
}

function playerSortValue(u, key) {
  if (key === 'username') return u.username.toLowerCase();
  if (key === 'scores') return u.scoreCount;
  const m = /^([a-z]+):(.+)$/.exec(key);
  if (!m) return null;
  const id = state.algoIds.find((a) => a === m[2]);
  if (!id) return null;
  if (m[1] === 'pp') return num(u.totalPp[id]);
  if (m[1] === 'rank') return playerRank(u, id);
  if (m[1] === 'delta') return playerDelta(u, id);
  return null;
}

function filteredPlayers() {
  const parsed = parseQuery(state.view.players?.q ?? '', PLAYER_FIELDS);
  const rows = parsed.length ? state.users.filter((u) => matchesPlayer(parsed, u)) : state.users.slice();
  const sort = state.playersSort;
  rows.sort((a, b) => compareRows(a, b, sort.key, sort.dir, playerSortValue,
    (u) => u.username.toLowerCase(), (u) => state.users.indexOf(u)));
  return { rows, parsed };
}

function renderRankings() {
  const columns = rankingColumns();
  $('thead', els.playersTable).innerHTML = headHtml(columns);
  const { rows, parsed } = filteredPlayers();
  $('tbody', els.playersTable).innerHTML = rows.length ? rows.map((u) => {
    const active = state.uid != null && u.uid === state.uid;
    return `<tr data-uid="${esc(String(u.uid ?? ''))}"${active ? ' class="row-active"' : ''} `
      + `tabindex="0" role="link" aria-label="Open ${esc(u.username)}">`
      + columns.map((c) => c.cell(u)).join('') + '</tr>';
  }).join('') : `<tr><td colspan="${columns.length}" class="empty">`
    + `${state.users.length ? 'No player matches the current search.' : 'This dataset contains no players.'}</td></tr>`;
  patchSort(els.playersTable, state.playersSort, columns);

  const bad = unsatisfiable(parsed);
  els.playersCount.textContent = (parsed.length
    ? `${rows.length} of ${state.users.length} players match · ${parsed.length} term${parsed.length === 1 ? '' : 's'}`
    : `${rows.length} player${rows.length === 1 ? '' : 's'}`)
    + (bad.length ? ` · ${bad.join(', ')} always matches nothing (no map creator in the dataset)` : '');
  const anchor = state.algoIds.includes('bancho') ? 'bancho' : state.A;
  els.playersNote.textContent = `Ranks cover the ${state.users.length} player`
    + `${state.users.length === 1 ? '' : 's'} in this dataset (1 = highest weighted total) and come from `
    + `data/index.json alone — no player shard is fetched for this view. ▲/▼ is the move against the same `
    + `player's ${algoLabel(anchor)} rank, so it shows who gains or loses when the algorithm is switched.`;
}

/* ----- player ----- */

function syncAlgoControls() {
  const fill = (sel) => {
    sel.innerHTML = state.algoIds.map((id) => `<option value="${esc(id)}">${esc(algoMeta(id).label)}</option>`).join('');
    sel.disabled = state.algoIds.length < 2;
  };
  fill(els.algoA); fill(els.algoB);
  els.algoA.value = state.A ?? '';
  els.algoB.value = state.B ?? '';
  els.abNote.innerHTML = state.algoIds.length
    ? `A = <strong>${esc(algoLabel(state.A))}</strong> · B = <strong>${esc(algoLabel(state.B))}</strong> — Δ columns are B − A`
    : '';
}

function renderPlayerHead() {
  const u = player();
  const uid = u?.uid ?? state.uid;
  els.playerTitle.innerHTML = u
    ? `${esc(u.username)}${uid == null ? '' : ` <span class="hint">#${esc(uid)}</span>`}`
    : 'Player';
  const url = userUrl(uid);
  const bits = [];
  if (url) bits.push(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">osu.ppy.sh/users/${esc(uid)}</a>`);
  if (u?.fixture) bits.push(`fixture <code>${esc(u.fixture)}</code>`);
  if (u) bits.push(`${esc(u.scoreCount)} scores in the dataset`);
  if (state.shard === 'loading') bits.push('loading scores…');
  if (state.shard === 'ready') bits.push(`${state.scores.length} score${state.scores.length === 1 ? '' : 's'} loaded`);
  els.playerSub.innerHTML = bits.join(' · ');
}

/** The shard error panel and the empty bp list. */
function renderShardState() {
  const u = player(), broken = state.shard === 'error';
  const blank = state.shard === 'ready' && !state.scores.length;
  els.panelShardError.hidden = !(broken || blank);
  if (els.panelShardError.hidden) return;
  els.shardErrorTitle.textContent = broken ? 'Player data unavailable' : 'This player has no scores';
  els.shardErrorText.textContent = broken
    ? `Could not read the scores of ${u?.username ?? 'this player'} — ${state.shardError}`
    : `${u?.username ?? 'This player'} has no scores in this dataset (the index lists `
      + `${u?.scoreCount ?? 0}), so there is nothing to rank, summarise or export.`;
  els.shardErrorHint.textContent = broken
    ? 'The weighted totals above come from data/index.json and stay valid; everything that needs the '
      + 'individual scores does not. Retrying refetches just this player.'
    : 'That is a normal state for a player the engine could not harvest, not an error.';
  els.shardRetry.hidden = !broken;
}

function renderPlayerAll() {
  renderPlayerHead();
  syncAlgoControls();
  renderTotals();
  renderShardState();
  renderList();
}

/** Panels driven by the search, the sort and the A/B pair. */
function renderList() {
  const ready = state.shard === 'ready' && state.scores.length > 0;
  els.panelScores.hidden = !ready;
  els.panelLayers.hidden = !ready;
  els.panelDisagree.hidden = !ready;
  if (!ready) {
    $('thead', els.scoreTable).innerHTML = '';
    $('tbody', els.scoreTable).innerHTML = '';
    els.scoreCount.textContent = '';
    els.searchState.textContent = '';
    els.searchWarn.hidden = true;
    els.showMore.hidden = true;
    els.layerTable.innerHTML = '';
    els.layerNote.textContent = '';
    els.disagree.innerHTML = '';
    els.scatter.innerHTML = '';
    els.scatterNote.textContent = '';
    return;
  }
  const { rows } = scoreFilteredSorted();
  renderScoreTable();
  renderLayers();
  renderDisagreement(rows);
  renderScatter(rows);
}

function renderAll() {
  renderRoutes();
  renderLegend();
  renderMeta();
  renderNotice();
  renderProvenance();
  if (state.route === 'players') {
    if (!state.totalsRanked) refreshIndexRanks();
    renderRankings();
  } else {
    renderPlayerAll();
  }
  syncThemeButton();
}

/* -------------------------------- 11 csv ---------------------------------- */

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvNum = (v, d = 3) => (v == null ? '' : Number(v).toFixed(d));

function download(name, text) {
  const blob = new Blob([`\uFEFF${text}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function flash(btn, text, restore) {
  btn.textContent = text;
  setTimeout(() => { btn.textContent = restore; }, 2200);
}

/** The current search and sort, not just the visible page. The header carries
 *  both algorithm ids, so a file kept next to another comparison stays clear. */
function exportScoresCsv() {
  const { rows } = scoreFilteredSorted();
  if (!rows.length) return;
  const A = state.A, B = state.B;
  const head = [
    ...CSV_ORDER.map((c) => c.toUpperCase()),
    ...state.algoIds.map((id) => `PP_${id.toUpperCase()}`),
    'DIFF_PP', 'REL_PCT', `RANK_${A.toUpperCase()}`, `RANK_${B.toUpperCase()}`, 'RANK_SHIFT',
    'SPREAD_REL_PCT', 'OSU_LINKS',
  ];
  const lines = rows.map((s) => {
    const sp = spreadOf(s.pp);
    const first = CSV_ORDER.map((c) => csvCell({
      score_id: s.scid, beatmap_id: s.bid, beatmap_set_id: s.sid, artist: s.artist,
      title: s.title, version: s.version, mapper: s.mapper, keys: s.keys, od: s.od,
      mods: s.mods, accuracy: s.acc, n320: s.counts[0], n300: s.counts[1], n200: s.counts[2],
      n100: s.counts[3], n50: s.counts[4], miss: s.counts[5], star_bancho: s.starBancho,
      star_sunny: s.starSunny, star_rice: s.starRice, ln_ratio: s.ln, l_share: s.lShare,
      w: s.w, coord_mod: s.coordMod, eff_star: s.effStar, acc_factor: s.accFactor,
      nf_factor: s.nfFactor,
    }[c])).join(',');
    return [first,
      state.algoIds.map((id) => csvNum(s.pp[id])).join(','),
      csvNum(diffOf(s)), relOf(s) == null ? '' : csvNum(relOf(s) * 100, 4),
      state.scoreRanks?.a[s.i] ?? '', state.scoreRanks?.b[s.i] ?? '', shiftOf(s) ?? '',
      sp?.rel == null ? '' : csvNum(sp.rel * 100, 4),
      csvCell([mapUrl(s), scoreUrl(s), userUrl(state.uid)].filter(Boolean).join(' ')),
    ].join(',');
  });
  download(`scores_${state.uid ?? 'player'}_${A}_vs_${B}.csv`, [head.join(','), ...lines].join('\r\n') + '\r\n');
  flash(els.exportCsv, `Exported ${rows.length} rows`, 'Export CSV');
}

/** The rankings export is not wired to a button (the view's Reset control is
 *  the only toolbar there); it exists for parity with the score table and is
 *  reachable from the console or a future control. */
function exportPlayersCsv() {
  const { rows } = filteredPlayers();
  if (!rows.length) return;
  const anchor = state.algoIds.includes('bancho') ? 'bancho' : state.A;
  const head = ['UID', 'USERNAME', 'SCORES',
    ...state.algoIds.map((id) => `PP_${id.toUpperCase()}`),
    ...state.algoIds.map((id) => `RANK_${id.toUpperCase()}`),
    ...state.algoIds.map((id) => `DELTA_${id.toUpperCase()}`),
    ...state.algoIds.map((id) => `REL_PCT_${id.toUpperCase()}`),
    ...state.algoIds.map((id) => `MOVE_${id.toUpperCase()}_VS_${anchor.toUpperCase()}`)];
  const lines = rows.map((u) => [u.uid, u.username, u.scoreCount,
    ...state.algoIds.map((id) => csvNum(num(u.totalPp[id]))),
    ...state.algoIds.map((id) => playerRank(u, id) ?? ''),
    ...state.algoIds.map((id) => csvNum(playerDelta(u, id))),
    ...state.algoIds.map((id) => csvNum(playerRel(u, id), 4)),
    ...state.algoIds.map((id) => playerMove(u, id) ?? ''),
  ].map(csvCell).join(','));
  download('players_rankings.csv', [head.join(','), ...lines].join('\r\n') + '\r\n');
}
window.maniaSrPpExportPlayersCsv = exportPlayersCsv;

/* ------------------------------- 12 loading ------------------------------- */

function engineCommand(extra = '') {
  return [
    'cargo run --release -p mania-pp-cli -- \\',
    `  --fixture ${SAMPLE_FIXTURE} \\`,
    `  --maps    ${SAMPLE_MAPS} \\`,
    `  --out     docs/data${extra}`,
  ].join('\n');
}

/** Everything the header, the notice bar and the footer say about the source. */
function renderMeta() {
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

function renderNotice() {
  const s = state.source, msgs = [];
  if (s?.origin === 'file') msgs.push(`Showing a locally loaded file: <code>${esc(s.filename || '(unnamed)')}</code>.`);
  const version = num(s?.schema_version);
  if (version != null && version !== SCHEMA_VERSION) {
    msgs.push(version > SCHEMA_VERSION
      ? `<strong>Newer <code>schema_version</code> ${esc(version)}</strong> than this page knows `
        + `(${SCHEMA_VERSION}): the fields it understands are rendered and anything newer is ignored.`
      : `<strong>Older <code>schema_version</code> ${esc(version)}</strong> (this page knows `
        + `${SCHEMA_VERSION}): missing fields show “–”.`);
  }
  if (state.loadError) msgs.push(`<strong>Could not load that file</strong> — ${esc(state.loadError)}`);
  const warn = Array.isArray(s?.warnings) ? s.warnings.length : 0;
  if (warn) msgs.push(`${warn} engine warning${warn === 1 ? '' : 's'} — listed in the provenance footer.`);
  els.note.hidden = !msgs.length;
  els.note.innerHTML = msgs.join('<br>');
}

function renderProvenance() {
  const s = state.source, e = s?.engine || {};
  const rows = s ? [
    ['engine', [e.name, e.version].filter(Boolean).join(' ') || '–'],
    ['spec version', e.spec_version || '–'],
    ['rosu-pp revision', e.rosu_pp_rev || '–'],
    ['generated at', fmtDate(s.generated_at) || '–'],
    ['schema version', s.schema_version == null ? '–' : String(s.schema_version)],
    ['players', String(state.users.length)],
    ['scores', s.score_count == null ? '–' : String(s.score_count)],
    ['dataset source', s.origin === 'file' ? `local file: ${s.filename || '(unnamed)'}` : INDEX_URL],
    ['repository', `<a href="${esc(REPO_URL)}" target="_blank" rel="noopener noreferrer">${esc(REPO_URL.replace('https://', ''))}</a>`],
  ] : [['dataset', 'not loaded']];
  const warn = Array.isArray(s?.warnings) ? s.warnings : [];
  els.prov.innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')
    + `<dt>warnings</dt><dd>${warn.length ? `<span class="warn">${warn.length}</span>` : 'none'}</dd>`
    + (warn.length ? `<dt></dt><dd><ul class="warn-list">${warn.slice(0, WARN_LIMIT)
      .map((w) => `<li>${esc(w)}</li>`).join('')}`
      + `${warn.length > WARN_LIMIT ? `<li>… (+${warn.length - WARN_LIMIT} more)</li>` : ''}</ul></dd>` : '');
}

/** The syntax panel, built from the field maps so it cannot claim a field the
 *  code does not have. */
function renderHelp() {
  const row = (names, what, example) => `<tr><td>${names.map((n) => `<code>${esc(n)}</code>`).join(', ')}</td>`
    + `<td>${what}</td><td><code>${esc(example)}</code></td></tr>`;
  els.helpFields.innerHTML = [
    row(['artist', 'title'], 'one field only', 'title:"eternal white"'),
    row(['diff', 'version'], 'difficulty name', 'diff:extra'),
    row(['creator', 'mapper'], 'map creator — <em>not carried by this dataset</em>, so it matches nothing', 'mapper:shimizushi'),
    row(['key', 'keys'], 'key mode', 'key=4'),
    row(['od'], 'overall difficulty', 'od&gt;=9'),
    row(['ln', 'lns'], 'share of holds in percent (0–100)', 'lns&gt;90'),
    row(['ln_ratio'], 'the same share as a 0–1 fraction', 'ln_ratio&lt;0.1'),
    row(['mod', 'mods'], 'mod acronym; <code>mod=NM</code> is no mods', 'mod=DT'),
    row(['acc', 'accuracy'], 'accuracy in percent', 'acc&gt;=99'),
    row(['pp'], `weighted pp of B (${esc(algoLabel(state.B))})`, 'pp&gt;500'),
    row(['pp_bancho', 'pp_sunny', 'pp_codexxy', 'pp_reimagined'], 'weighted pp of a named algorithm', 'pp_sunny&gt;400'),
    row(['rank'], `rank of the score under B (${esc(algoLabel(state.B))})`, 'rank&lt;=10'),
    row(['delta'], `B − A pp (${esc(algoLabel(state.B))} − ${esc(algoLabel(state.A))})`, 'delta&lt;-20'),
    row(['rel'], 'B against A in percent', 'rel&gt;10'),
    row(['star', 'stars', 'sr', 'star_bancho'], "official osu! star rating (Bancho's)", 'star&lt;7'),
    row(['star_sunny', 'sr_sunny'], "Sunny's star rating", 'sr_sunny&gt;=8'),
    row(['star_rice', 'sr_rice'], "rice star rating (Sunny's rice variant)", 'sr_rice&lt;6'),
    row(['score_id', 'map_id', 'set_id'], 'identifiers, compared as numbers', 'map_id=3525702'),
    row(['eff_star', 'l_share', 'w', 'coord_mod', 'acc_factor', 'nf_factor'], 'Reimagined internals', 'eff_star&gt;7'),
  ].join('');
  els.helpPlayerFields.innerHTML = [
    row(['uid'], 'osu! user id', 'uid=21207706'),
    row(['username', 'user', 'name'], 'free text over usernames', 'shirasu'),
    row(['scores'], 'scores the dataset holds for that player', 'scores&gt;=100'),
    row(['pp'], `weighted total of B (${esc(algoLabel(state.B))})`, 'pp&gt;10000'),
    row(['pp_bancho', 'pp_sunny', 'pp_codexxy', 'pp_reimagined'], 'weighted total of a named algorithm', 'pp_reimagined&gt;10000'),
    row(['rank'], `rank under B (${esc(algoLabel(state.B))})`, 'rank&lt;5'),
    row(['rank_bancho', 'rank_sunny', 'rank_codexxy', 'rank_reimagined'], 'rank under a named algorithm', 'rank_bancho=1'),
    row(['delta', 'delta_bancho'], `total minus A (${esc(algoLabel(state.A))})`, 'delta_bancho&lt;-500'),
    row(['rel', 'rel_reimagined'], 'total against A in percent', 'rel_reimagined&gt;5'),
    row(['move', 'move_reimagined'], 'rank movement against A (positive = climbs)', 'move_reimagined&gt;3'),
  ].join('');
  els.helpFieldsNote.innerHTML = 'Free text matches artist, title, difficulty, mapper and the mods, and several '
    + 'terms are ANDed. Every operator works on a numeric field; <code>=</code> and <code>!=</code> also '
    + 'work on text. A name that is not a field falls back to free text, so nothing is ever matched '
    + `silently. The pair in play right now is A = ${esc(algoLabel(state.A))}, B = ${esc(algoLabel(state.B))}.`;
}

/** Example chips: the ones quoted in the repository instructions are fixed, and
 *  the rest are computed from the loaded shard so they always return rows. */
function renderHelpExamples() {
  const examples = [{ q: 'mod=DT key=4 star<7', why: 'rate-up 4K below 7 stars' }, { q: 'lns>90', why: 'LN-heavy maps' }];
  if (state.scores.length) {
    const mid = (vals, step) => {
      const m = median(vals.filter((v) => v != null));
      return m == null ? null : Math.round(m / step) * step;
    };
    const ln = mid(state.scores.map((s) => (s.ln == null ? null : s.ln * 100)), 10);
    const pp = mid(state.scores.map(ppB), 50);
    const sr = mid(state.scores.map((s) => s.starBancho), 0.5);
    const d = mid(state.scores.map(diffOf), 10);
    if (d != null) examples.push({ q: `delta<${d}`, why: `B costs more than ${-d} pp against A` });
    if (pp != null) examples.push({ q: `pp>${pp}`, why: 'the upper half of this list' });
    if (ln != null) examples.push({ q: `lns<${ln}`, why: 'the rice side of this list' });
    if (sr != null) examples.push({ q: `star<${sr.toFixed(1)}`, why: 'below the median star rating' });
  } else {
    examples.push({ q: 'delta<-20', why: 'B prices at least 20 pp below A' },
      { q: 'pp>500', why: 'scores worth more than 500 pp' });
  }
  examples.push({ q: 'acc>=99 mod=NM', why: 'accurate no-mod scores' });
  els.helpExamples.innerHTML = examples.map((e) => `<li><button type="button" class="example" `
    + `data-q="${esc(e.q)}" title="${esc(e.why)}">${esc(e.q)}</button> <span class="why">${esc(e.why)}</span></li>`).join('');
}

/** Empty state: no usable dataset. Say why, show the command, offer the file. */
function showEmpty(reason, blocked) {
  state.source = null; state.users = []; state.scores = []; state.shard = 'empty';
  state.scoreRanks = null; state.algoIds = []; state.totalsRanked = false;
  state.view = { players: null, player: null };
  state.route = 'players'; state.uid = null;
  els.loader.hidden = false;
  els.loaderErr.hidden = true; els.loaderErr.textContent = '';
  els.loaderWhy.textContent = reason;
  els.loaderHint.innerHTML = blocked
    ? 'This page was opened straight from disk (<code>file://</code>), where the browser refuses to read '
      + 'sibling files. Serve <code>docs/</code> over HTTP, or load <code>index.json</code> below.'
    : 'Run the command below to write <code>docs/data/index.json</code>, then reload — or load an '
      + 'existing <code>index.json</code> (or a single player shard) below.';
  els.loaderCmd.textContent = engineCommand();
  renderAll();
}

/** Adopt an index document. `eagerShard` carries a shard dropped in on its own. */
function applyIndex(raw, origin, eagerShard) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('top level is not a JSON object');
  const users = (Array.isArray(raw.users) ? raw.users : []).filter((u) => u && typeof u === 'object');
  if (!users.length && !Array.isArray(raw.algorithms)) throw new Error('no "users" array and no "algorithms" array');
  state.source = Object.assign({}, raw, { origin: origin.kind, filename: origin.filename });
  state.users = users.map(normalizeUser);
  state.scores = []; state.scoreRanks = null;
  state.shard = 'empty'; state.shardError = null;
  state.algoIds = []; state.A = null; state.B = null; state.totalsRanked = false;
  state.uid = null; state.open.clear(); state.shown = PAGE_SIZE; state.loadError = null;
  state.view = { players: null, player: null };
  state.eagerShard = eagerShard || null;
  resolveAlgorithms(raw);
  rebuildPlayerFields();
  refreshIndexRanks();
  els.loader.hidden = true;
  els.loaderErr.hidden = true; els.loaderErr.textContent = '';
  renderHelp();
  // The hash decides which view opens; an empty hash means the rankings.
  const next = readHash();
  state.route = next.route;
  if (next.route === 'player') {
    state.uid = next.uid;
    state.playerSort = { key: state.view.player.sort, dir: state.view.player.dir };
    els.scoresQ.value = state.view.player.q;
    renderAll();
    loadShard();
    return;
  }
  state.playersSort = { key: state.view.players.sort, dir: state.view.players.dir };
  els.playersQ.value = state.view.players.q;
  els.scoresQ.value = '';
  renderAll();
}

/** Fetch (or reuse) the shard of state.uid, then rank it. */
async function loadShard() {
  const u = player(), eager = state.eagerShard;
  state.scores = []; state.scoreRanks = null; state.shardError = null;
  state.shown = PAGE_SIZE; state.open.clear();
  state.eagerShard = null;
  if (!u) { state.shard = 'empty'; renderAll(); return; }
  if (eager) {
    state.scores = normalizeShard(eager, u);
    state.shard = 'ready';
  } else {
    const url = DATA_DIR + (u.file || `players/${u.uid}.json`);
    const token = ++state.shardToken;
    state.shard = 'loading';
    renderAll();
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const raw = await res.json();
      if (token !== state.shardToken) return;          // a newer selection won the race
      state.scores = normalizeShard(raw, u);
      state.shard = 'ready';
    } catch (err) {
      if (token !== state.shardToken) return;
      state.shard = 'error';
      state.shardError = `${url} — ${err?.message ?? err}`;
      renderAll();
      return;
    }
  }
  refreshScoreRanks();
  renderPlayerAll();
  renderHelpExamples();
}

async function boot() {
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
function loadText(text, filename) {
  const report = (msg) => {
    if (state.source) { state.loadError = msg; renderNotice(); } else {
      showEmpty(msg, location.protocol === 'file:');
      els.loaderErr.hidden = false; els.loaderErr.textContent = msg;
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
        users: [{ uid: raw.uid ?? null, username: raw.username ?? 'local shard', fixture: filename,
          scores: n, file: null, total_pp: {} }],
        score_count: n, warnings: [],
      }, { kind: 'file', filename }, raw);
    }
    throw new Error('expected an index document ("users" array) or a player shard ("columns" + "scores")');
  } catch (err) { report(`${filename}: ${err.message}`); }
}

function readFile(file) {
  if (!file) return;
  const r = new FileReader();
  r.onload = () => loadText(String(r.result), file.name);
  r.onerror = () => loadText('', file.name);            // surfaces as a JSON parse error
  r.readAsText(file);
}

/** Open a player. The hash is the source of truth, so navigation and deep links
 *  are the same code path. */
function openPlayer(uid) {
  const p = new URLSearchParams();
  if (state.A) p.set('a', state.A);
  if (state.B) p.set('b', state.B);
  location.hash = `#/player/${encodeURIComponent(String(uid))}?${p.toString()}`;
}

/** Apply the hash: load whatever the new view needs, then render. */
function applyRoute() {
  if (!state.source) { renderAll(); return; }
  const prevRoute = state.route, prevUid = state.uid;
  const next = readHash();
  state.route = next.route;
  if (next.route === 'players') {
    state.playersSort = { key: state.view.players.sort, dir: state.view.players.dir };
    els.playersQ.value = state.view.players.q;
    refreshIndexRanks();
    renderAll();
    return;
  }
  state.playerSort = { key: state.view.player.sort, dir: state.view.player.dir };
  els.scoresQ.value = state.view.player.q;
  state.uid = next.uid;
  renderAll();
  if (prevRoute !== 'player' || prevUid !== next.uid) loadShard();
}

/* ------------------------------- 13 events -------------------------------- */

/* ----- theme: auto -> light -> dark, persisted, defaulting to the system ----- */

const THEMES = [
  { id: 'auto', label: 'Auto', icon: '◐', title: 'Colour theme: auto (follows the system)' },
  { id: 'light', label: 'Light', icon: '☀', title: 'Colour theme: light' },
  { id: 'dark', label: 'Dark', icon: '☾', title: 'Colour theme: dark' },
];
const currentTheme = () => THEMES.find((t) => t.id === (els.html.getAttribute('data-theme') || 'auto')) || THEMES[0];
function syncThemeButton() {
  const t = currentTheme();
  els.themeLabel.textContent = t.label;
  els.themeIcon.textContent = t.icon;
  els.themeBtn.title = t.title;
  els.themeBtn.setAttribute('aria-label', `${t.title} — activate to change`);
}
function cycleTheme() {
  const i = THEMES.findIndex((t) => t.id === currentTheme().id);
  const next = THEMES[(i + 1) % THEMES.length];
  els.html.setAttribute('data-theme', next.id);
  try { localStorage.setItem(THEME_KEY, next.id); } catch (e) { /* private mode */ }
  syncThemeButton();
}
els.themeBtn.addEventListener('click', cycleTheme);

/* ----- A / B ----- */

function setPair(a, b) {
  state.A = a; state.B = b;
  rebuildPlayerFields();
  refreshScoreRanks();
  if (state.route === 'player') {
    state.view.player = Object.assign({}, state.view.player, { sort: `rank:${state.B}`, dir: 1 });
    state.playerSort = { key: `rank:${state.B}`, dir: 1 };
  } else {
    state.view.players = Object.assign({}, state.view.players, { sort: `pp:${a}`, dir: -1 });
    state.playersSort = { key: `pp:${a}`, dir: -1 };
  }
  writeHash(true);
  renderAll();
  renderHelp();
  if (state.scores.length) renderHelpExamples();
}
els.algoA.addEventListener('change', (e) => {
  const a = e.target.value;
  setPair(a, state.B === a ? (state.algoIds.find((id) => id !== a) ?? a) : state.B);
});
els.algoB.addEventListener('change', (e) => {
  const b = e.target.value;
  setPair(state.A === b ? (state.algoIds.find((id) => id !== b) ?? b) : state.A, b);
});
els.swapAB.addEventListener('click', () => setPair(state.B, state.A));

/* ----- search boxes ----- */

const onPlayersInput = debounce(() => {
  state.view.players.q = els.playersQ.value;
  state.shown = PAGE_SIZE;
  writeHash(true);
  renderRankings();
}, 120);
const onScoresInput = debounce(() => {
  state.view.player.q = els.scoresQ.value;
  state.shown = PAGE_SIZE;
  writeHash(true);
  renderList();
}, 120);
els.playersQ.addEventListener('input', onPlayersInput);
els.scoresQ.addEventListener('input', onScoresInput);

/** Reset clears the search, the sort and the A / B pair of the current view. */
function resetView() {
  state.shown = PAGE_SIZE;
  state.A = state.algoIds.includes('bancho') ? 'bancho' : (state.algoIds[0] ?? null);
  state.B = state.algoIds.includes('reimagined') ? 'reimagined'
    : (state.algoIds[state.algoIds.length - 1] ?? null);
  if (state.B === state.A) state.B = state.algoIds.find((id) => id !== state.A) ?? state.A;
  if (state.route === 'players') {
    state.view.players = { q: '', sort: 'pp:bancho', dir: -1 };
    state.playersSort = { key: 'pp:bancho', dir: -1 };
    els.playersQ.value = '';
  } else {
    state.view.player = { q: '', sort: `rank:${state.B}`, dir: 1 };
    state.playerSort = { key: `rank:${state.B}`, dir: 1 };
    els.scoresQ.value = '';
  }
  rebuildPlayerFields();
  refreshScoreRanks();
  writeHash(true);
  renderAll();
  renderHelp();
  if (state.scores.length) renderHelpExamples();
}
els.playersReset.addEventListener('click', resetView);
els.scoresReset.addEventListener('click', resetView);

/* ----- sortable tables ----- */

els.scoreTable.addEventListener('click', (ev) => {
  const th = ev.target.closest('th[data-key]');
  if (th) {
    state.playerSort = nextSort(state.playerSort, th.dataset.key, th.dataset.type);
    state.view.player.sort = state.playerSort.key;
    state.view.player.dir = state.playerSort.dir;
    state.shown = PAGE_SIZE;
    writeHash(true);
    renderScoreTable();
    return;
  }
  if (ev.target.closest('a')) return;
  const tr = ev.target.closest('tr[data-i]');
  if (!tr) return;
  const i = Number(tr.dataset.i);
  if (state.open.has(i)) state.open.delete(i); else state.open.add(i);
  renderScoreTable();
});

els.playersTable.addEventListener('click', (ev) => {
  const th = ev.target.closest('th[data-key]');
  if (th) {
    state.playersSort = nextSort(state.playersSort, th.dataset.key, th.dataset.type);
    state.view.players.sort = state.playersSort.key;
    state.view.players.dir = state.playersSort.dir;
    writeHash(true);
    renderRankings();
    return;
  }
  const tr = ev.target.closest('tr[data-uid]');
  if (!tr) return;
  const u = state.users.find((x) => String(x.uid) === tr.dataset.uid);
  if (u) openPlayer(u.uid);
});
els.playersTable.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter' && ev.key !== ' ') return;
  const tr = ev.target.closest('tr[data-uid]');
  if (!tr) return;
  ev.preventDefault();
  const u = state.users.find((x) => String(x.uid) === tr.dataset.uid);
  if (u) openPlayer(u.uid);
});

/* ----- disagreement list ----- */

els.disagree.addEventListener('click', (ev) => {
  const row = ev.target.closest('.dis-row');
  if (!row) return;
  const i = Number(row.dataset.i);
  if (state.open.has(i)) state.open.delete(i); else state.open.add(i);
  renderDisagreement(scoreFilteredSorted().rows);
});

/* ----- search help ----- */

els.helpExamples.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-q]');
  if (!btn) return;
  const input = state.route === 'players' ? els.playersQ : els.scoresQ;
  input.value = btn.dataset.q;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
});

/* ----- buttons, loading, drag & drop ----- */

els.showMore.addEventListener('click', () => { state.shown += PAGE_SIZE; renderScoreTable(); });
els.exportCsv.addEventListener('click', exportScoresCsv);
els.shardRetry.addEventListener('click', () => loadShard());
els.loadOpen.addEventListener('click', () => els.fileInput.click());
els.loaderBrowse.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', (ev) => {
  readFile(ev.target.files && ev.target.files[0]);
  ev.target.value = '';
});

for (const type of ['dragenter', 'dragover']) {
  window.addEventListener(type, (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault();                       // stop the browser from navigating to the file
    els.dragHint.hidden = false;
    els.drop.classList.add('over');
  });
}
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget !== null) return;
  els.dragHint.hidden = true;
  els.drop.classList.remove('over');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  els.dragHint.hidden = true;
  els.drop.classList.remove('over');
  readFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
});

/* ----- keyboard: / focuses the search, Esc clears it, Enter opens a match ----- */

const isTyping = (el) => !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

window.addEventListener('keydown', (ev) => {
  const input = state.route === 'players' ? els.playersQ : els.scoresQ;
  if (ev.key === '/' && !isTyping(document.activeElement) && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
    if (state.route === 'player' && els.viewPlayer.hidden) return;
    ev.preventDefault();
    if (state.route === 'player') els.help.open = true;   // make the syntax discoverable
    input.focus();
    input.select();
    return;
  }
  if (ev.key === 'Escape') {
    if (isTyping(document.activeElement)) {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.blur();
    } else if (els.help.open) {
      els.help.open = false;
    }
    return;
  }
  if (ev.key === 'Enter' && document.activeElement === els.playersQ && state.route === 'players') {
    const { rows } = filteredPlayers();
    if (rows.length) { ev.preventDefault(); openPlayer(rows[0].uid); }
  }
});

window.addEventListener('hashchange', applyRoute);

/* ----- go ----- */

renderHelp();
syncThemeButton();
boot();
