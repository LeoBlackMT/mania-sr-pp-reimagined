'use strict';
/* ===========================================================================
 * mania-sr-pp-reimagined — comparison site front-end.
 * Vanilla JS, no dependencies, no build step; data contract in docs/web.md.
 *
 * The CLI writes `data/index.json` plus one shard per player. The index loads
 * eagerly and a shard is fetched when that bp list is selected. A missing index
 * is a normal state — this repository ships no sample dataset — so the page then
 * explains itself and offers the drag-and-drop / file-input loader instead.
 * =========================================================================== */
/* --------------------------------- config -------------------------------- */

const INDEX_URL = 'data/index.json';  // written by mania-pp-cli, sibling of this page
const DATA_DIR = 'data/';             // prefix for the shard paths listed in the index
const SCHEMA_VERSION = 2;             // index + columnar shards
const PAGE_SIZE = 50;                 // score rows rendered at a time ("show more" appends)
const TOP_DISAGREE = 15;              // rows in the disagreement list
const LN_RICE = 0.05;                 // style buckets: rice < 0.05 <= mix < 0.35 <= LN
const LN_FULL = 0.35;
const SHIFT_MID = 4;                  // |rank shift| that counts as a visible move
const SHIFT_BIG = 10;                 // |rank shift| that counts as a large move
const WARN_LIMIT = 25;                // warnings listed in the provenance footer
const ALGO_ORDER = ['bancho', 'sunny', 'codexxy', 'reimagined'];
const COLS_HINT = 'click a header to sort';
const SHORT_LABEL = { bancho: 'Bancho', sunny: 'Sunny', codexxy: 'Codexxy', reimagined: 'Reimagined' };
const PP_KEYS = ['n320', 'n300', 'n200', 'n100', 'n50', 'miss'];
const PP_LABELS = ['320', '300', '200', '100', '50', 'miss'];
const COUNT_TITLE = 'judgement counts 320 / 300 / 200 / 100 / 50 / miss';
const FALLBACK_ALGOS = [ { id: 'bancho', label: 'Bancho', description: 'official osu! pp (osu!lazer mania pp)' },
  { id: 'sunny', label: 'Sunny', description: 'community algorithm by [Crz]sunnyxxy (its repository is named Star-Rating-Rebirth)' },
  { id: 'codexxy', label: 'Codexxy', description: 'sunny plus a map-based timing surface' }, { id: 'reimagined', label: 'Reimagined', description: "this project's three-channel R/L/A algorithm" },
];
/* --------------------------------- helpers ------------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escape anything taken from the JSON before it reaches innerHTML. */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
/** Finite number, or null when absent/unparsable (nulls render "–" and sort last). */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
const fmt = (v, d = 2) => (v == null ? '–' : v.toFixed(d));
const fmtG = (v, d = 2) => (v == null ? '–' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const signed = (v, d = 2) => (v == null ? '–' : (v > 0 ? '+' : '') + v.toFixed(d));
const signedPct = (v, d = 1) => (v == null ? '–' : (v > 0 ? '+' : '') + (v * 100).toFixed(d) + '%');
/** Sign colouring; positive is "up". The rank-shift column inverts this on purpose. */
const dirClass = (v) => (v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');
const clamp = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
const shortLabel = (id) => SHORT_LABEL[id] || legendMeta(id).label;
/** "2026-09-13T09:22:32Z" -> "2026-09-13 09:22 UTC"; unparsable input passes through. */
function fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? String(iso) : d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}
/** Median of a numeric array (mean of the two middles for even counts); null when empty. */
function median(values) {
  if (!values.length) return null;
  const a = values.slice().sort((x, y) => x - y), mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}
/* ---------------------------------- state --------------------------------- */

const state = { source: null,                                 // raw index document (+ origin/filename)
  users: [],                                    // index users: metadata + totals, no scores
  algoIds: [], algoMeta: new Map(), userIndex: 0, shard: null,                                  // {uid, username, scores} of the selected list
  shardState: 'empty',                          // empty | loading | ready | error
  shardError: null, eagerShard: null, shardToken: 0, A: null, B: null,                             // the compared pair; A is the baseline
  ranks: null,                                  // {a: [rank per score], b: [...]} over ALL scores
  sort: { key: null, dir: -1 }, q: '', f: { keys: 'all', mods: 'all', ln: 'all' }, shown: PAGE_SIZE, open: new Set(), loadError: null,
};

const user = () => state.users[state.userIndex] || null;
const scores = () => (state.shard ? state.shard.scores : []);
const ppOf = (s, id) => (id == null ? null : s.pp[id] ?? null);
const ppA = (s) => ppOf(s, state.A);
const ppB = (s) => ppOf(s, state.B);
/** B − A on one score; null unless both algorithms priced it. */
const diffOf = (s) => { const a = ppA(s), b = ppB(s); return a == null || b == null ? null : b - a; };
/** Relative difference B / A − 1 (a share, printed as a percentage). */
const relOf = (s) => { const a = ppA(s), b = ppB(s); return a == null || b == null || !(a > 0) ? null : b / a - 1; };
/** Rank shift B − A: positive means the score drops when the list is ordered by B. */
function shiftOf(s) {
  if (!state.ranks) return null;
  const ra = state.ranks.a[s.i], rb = state.ranks.b[s.i];
  return ra == null || rb == null ? null : rb - ra;
}
const shiftClass = (v) => (v == null ? '' : Math.abs(v) >= SHIFT_BIG ? 'shift-big' : Math.abs(v) >= SHIFT_MID ? 'shift-mid' : '');
/* ------------------------------ normalisation ----------------------------- */

const legendMeta = (id) => state.algoMeta.get(id) || FALLBACK_ALGOS.find((a) => a.id === id)
  || { id, label: id, description: 'no description in this data file' };
const dotClass = (id) => `c-${ALGO_ORDER.includes(id) ? id : 'other'}`;

/** Order ids: the four known ones first, then anything extra alphabetically. */
function orderAlgos(pool) {
  const ids = ALGO_ORDER.filter((id) => pool.has(id));
  for (const id of [...pool].sort()) if (!ids.includes(id)) ids.push(id);
  return ids;
}

/** Algorithm ids from the declared list and from every total_pp / pp_* key seen. */
function resolveAlgorithms(raw, users) {
  const declared = (Array.isArray(raw.algorithms) ? raw.algorithms : []).filter((a) => a && a.id);
  state.algoMeta = new Map(declared.map((a) => [String(a.id), { id: String(a.id), label: String(a.label || a.id), description: String(a.description || '') }]));
  const pool = new Set(state.algoMeta.keys());
  for (const u of users) for (const id of Object.keys(u.total_pp || {})) pool.add(String(id));
  if (state.shard) for (const id of Object.keys(state.shard.scores[0]?.pp || {})) pool.add(id);
  state.algoIds = orderAlgos(pool);
  if (!state.A || !state.algoIds.includes(state.A)) state.A = state.algoIds.includes('bancho') ? 'bancho' : state.algoIds[0] ?? null;
  if (!state.B || !state.algoIds.includes(state.B)) state.B = state.algoIds.includes('reimagined') ? 'reimagined' : state.algoIds[state.algoIds.length - 1] ?? null;
  if (state.B === state.A) state.B = state.algoIds.find((id) => id !== state.A) ?? state.A;
}

/** Index user -> metadata only; the scores live in the shard. */
const normalizeUser = (u) => ({ uid: u.uid ?? null, username: String(u.username ?? u.uid ?? 'unknown'), fixture: u.fixture == null ? null : String(u.fixture),
  scoreCount: num(u.scores) ?? 0, file: u.file == null ? null : String(u.file), totalPp: Object.fromEntries(Object.entries(u.total_pp || {}).map(([k, v]) => [String(k), num(v)])),
});

/** A shard row is an ARRAY in `columns` order; unknown columns are ignored and
 *  a missing optional column reads as null. */
function normalizeScore(row, at, i) {
  const g = (name) => {
    const k = at.get(name), v = k === undefined ? undefined : row[k];
    return v === undefined ? null : v;
  };
  const mods = String(g('mods') ?? '').trim().toUpperCase();
  const modsParts = String(g('mods_parts') ?? '').trim().toUpperCase();
  const pp = {};
  for (const id of state.algoIds) pp[id] = num(g(`pp_${id}`));
  const artist = String(g('artist') ?? ''), title = String(g('title') ?? ''), version = String(g('version') ?? '');
  return {
    i, bid: num(g('beatmap_id')), artist, title, version, keys: num(g('keys')), od: num(g('od')),
    mods, modsLabel: mods === '' ? 'NM' : mods, modsParts: modsParts || (mods === '' ? 'NM' : mods), acc: num(g('accuracy')), counts: PP_KEYS.map((k) => num(g(k))), pp,
    starsFull: num(g('stars_full')), starsRice: num(g('stars_rice')), ln: num(g('ln_ratio')), lShare: num(g('l_share')), w: num(g('w')), coordMod: num(g('coord_mod')), effStar: num(g('eff_star')),
    accFactor: num(g('acc_factor')), nfFactor: num(g('nf_factor')), hay: [artist, title, version, mods, modsParts, g('beatmap_id') ?? '', g('keys') ?? ''].join(' ').toLowerCase(),
  };
}

/** A player shard -> normalized scores, folding any unknown `pp_*` column in first. */
function normalizeShard(raw, fallback) {
  const columns = Array.isArray(raw.columns) ? raw.columns.map(String) : [];
  const extra = columns.filter((c) => c.startsWith('pp_') && c.length > 3).map((c) => c.slice(3));
  if (extra.length) state.algoIds = orderAlgos(new Set([...state.algoIds, ...extra]));
  const at = new Map(columns.map((c, i) => [c, i]));
  const rows = Array.isArray(raw.scores) ? raw.scores : [];
  return { uid: raw.uid ?? fallback?.uid ?? null, username: String(raw.username ?? fallback?.username ?? 'unknown'), scores: rows.filter(Array.isArray).map((row, i) => normalizeScore(row, at, i)),
  };
}
/* ------------------------------- layer rules ------------------------------ */
/* Mods are matched by substring: the engine emits both "EZDT" and "EZDTV2". */
const modHay = (s) => s.modsParts || s.mods;
const hasMod = (s, flag) => modHay(s).includes(flag);
const isNm = (s) => modHay(s) === '' || modHay(s) === 'NM';
const rateUp = (s) => hasMod(s, 'DT') || hasMod(s, 'NC');
const rateDown = (s) => hasMod(s, 'HT') || hasMod(s, 'DC');
/** The three layer families. Each family's rows partition the bp list, so the
 *  "other" rows are the remainder and the numbers can be added up. */
const KEY_LAYERS = [ ['4K', (s) => s.keys === 4], ['6K', (s) => s.keys === 6], ['7K', (s) => s.keys === 7], ['other K', (s) => ![4, 6, 7].includes(s.keys)],      // 5K/8K/… and unknown key counts
];
const MOD_LAYERS = [ ['NM', isNm], ['DT · NC', rateUp], ['HT · DC', rateDown], ['other', (s) => !isNm(s) && !rateUp(s) && !rateDown(s)],
];
/** Style buckets on ln_ratio; a score with no ln_ratio stays unclassified. */
const STYLE_LAYERS = [ ['rice (ln < 0.05)', (s) => s.ln != null && s.ln < LN_RICE], ['mix (0.05 ≤ ln < 0.35)', (s) => s.ln != null && s.ln >= LN_RICE && s.ln < LN_FULL],
  ['LN (ln ≥ 0.35)', (s) => s.ln != null && s.ln >= LN_FULL], ['unclassified', (s) => s.ln == null],
];
const keyLayer = (s) => (s.keys === 4 ? '4' : s.keys === 6 ? '6' : s.keys === 7 ? '7' : 'other');
const modLayer = (s) => (isNm(s) ? 'nm' : rateUp(s) ? 'dt' : rateDown(s) ? 'ht' : 'other');
const styleLayer = (s) => (s.ln == null ? 'unk' : s.ln < LN_RICE ? 'rice' : s.ln < LN_FULL ? 'mix' : 'ln');
/* ------------------------------- derived data ----------------------------- */

/** max−min spread across every algorithm that priced this score. */
function spreadOf(pp) {
  const vals = state.algoIds.map((id) => pp[id]).filter((v) => v != null);
  if (vals.length < 2) return null;
  const max = Math.max(...vals), min = Math.min(...vals);
  const mean = vals.reduce((x, y) => x + y, 0) / vals.length;
  return { max, min, mean, abs: max - min, rel: mean > 0 ? (max - min) / mean : null };
}

/** Rank of every score in the whole bp list ordered by one algorithm (1 = best).
 *  Ties fall back to the shard order, so ranks are deterministic, and a score
 *  the algorithm did not price has no rank at all. Ranks always cover the whole
 *  list — the filters only decide which rows are displayed. */function computeRanks(list, id) {
  const rank = new Array(list.length).fill(null);
  list.map((s, i) => i).filter((i) => list[i].pp[id] != null) .sort((x, y) => list[y].pp[id] - list[x].pp[id] || x - y) .forEach((si, k) => { rank[si] = k + 1; });
  return rank;
}
const refreshRanks = () => { state.ranks = { a: computeRanks(scores(), state.A), b: computeRanks(scores(), state.B) }; };

/** Weighted total of one algorithm: the index value when it is there, else (a
 *  shard loaded on its own) osu!'s 0.95 decay over that algorithm's ranking. */
function totalFor(id) {
  const u = user();
  if (!u) return { value: null, derived: false };
  const given = num(u.totalPp[id]);
  if (given != null) return { value: given, derived: false };
  const vals = scores().map((s) => s.pp[id]).filter((v) => v != null).sort((a, b) => b - a);
  if (!vals.length) return { value: null, derived: false };
  return { value: vals.reduce((acc, v, i) => acc + v * Math.pow(0.95, i), 0), derived: true };
}

function filteredSorted() {
  if (!user()) return [];
  const q = state.q.trim().toLowerCase(), f = state.f;
  const rows = scores().filter((s) => (f.keys === 'all' || keyLayer(s) === f.keys)
    && (f.mods === 'all' || modLayer(s) === f.mods) && (f.ln === 'all' || styleLayer(s) === f.ln)
    && (!q || s.hay.includes(q)));
  return state.sort.key ? rows.slice().sort((a, b) => compare(a, b) * state.sort.dir) : rows;
}

function sortValue(s, key) {
  switch (key) {
    case 'map': return `${s.artist} ${s.title} ${s.version}`.toLowerCase();
    case 'mods': return s.modsLabel.toLowerCase();
    case 'ppA': return ppA(s);
    case 'ppB': return ppB(s);
    case 'diff': return diffOf(s);
    case 'rel': return relOf(s);
    case 'rankA': return state.ranks ? state.ranks.a[s.i] : null;
    case 'rankB': return state.ranks ? state.ranks.b[s.i] : null;
    case 'shift': return shiftOf(s);
    default: break;
  }
  if (key.startsWith('pp:')) return s.pp[key.slice(3)] ?? null;
  return s[key] ?? null;
}

/** Nulls always sink to the bottom, whichever direction is active. */
function compare(a, b) {
  const key = state.sort.key, numeric = key !== 'map' && key !== 'mods';
  const va = sortValue(a, key), vb = sortValue(b, key);
  const na = va == null, nb = vb == null;
  if (na || nb) return na && nb ? 0 : na ? 1 : -1;
  const r = numeric ? va - vb : va < vb ? -1 : va > vb ? 1 : 0;
  return r || sortValue(a, 'map').localeCompare(sortValue(b, 'map')) || (a.i - b.i);
}
/* -------------------------------- rendering ------------------------------- */

function renderMeta(src) {
  const e = state.source?.engine || {}, parts = [];
  if (e.name) parts.push(`${e.name}${e.version ? ' ' + e.version : ''}`);
  if (e.spec_version) parts.push(`spec ${e.spec_version}`);
  if (e.rosu_pp_rev) parts.push(`rosu-pp ${e.rosu_pp_rev}`);
  const gen = fmtDate(state.source?.generated_at);
  if (gen) parts.push(`generated ${gen}`);
  if (state.source) parts.push(`${state.users.length} bp list${state.users.length === 1 ? '' : 's'}`,
    `${num(state.source.score_count) ?? scores().length} scores`);
  $('#meta').textContent = parts.concat(src).join('  ·  ');
}

function renderNotice() {
  const s = state.source, msgs = [];
  if (s?.origin === 'file') msgs.push(`Showing a locally loaded file: <code>${esc(s.filename || '(unnamed)')}</code>.`);
  if (s?.schema_version != null && num(s.schema_version) !== SCHEMA_VERSION) {
    msgs.push(`<strong>Unexpected <code>schema_version</code> ${esc(s.schema_version)}</strong> ` + `(this build expects ${SCHEMA_VERSION}) — missing fields are tolerated.`);
  }
  if (state.loadError) msgs.push(`<strong>Could not load that file</strong> — ${esc(state.loadError)}`);
  const warn = Array.isArray(s?.warnings) ? s.warnings.length : 0;
  if (warn) msgs.push(`${warn} engine warning${warn === 1 ? '' : 's'} — listed in the provenance footer.`);
  $('#source-note').hidden = !msgs.length;
  $('#source-note').innerHTML = msgs.join('<br>');
}

function renderLegend() {
  const builtin = state.algoIds.length === 0;
  const ids = builtin ? FALLBACK_ALGOS.map((a) => a.id) : state.algoIds;
  const cards = ids.map((id) => {
    const m = legendMeta(id);
    const roles = [id === state.A ? 'A' : null, id === state.B ? 'B' : null].filter(Boolean);
    return `<div class="card"><div class="name"><i class="dot ${dotClass(id)}"></i>${esc(m.label)}` + `${roles.length ? `<span class="hint"> (${roles.join(', ')})</span>` : ''}</div>`
      + `<div class="desc">${esc(m.description || 'no description in this data file')}</div></div>`;
  }).join('');
  $('#legend').innerHTML = cards + (builtin ? '<p class="hint legend-note">Built-in descriptions — a loaded dataset supplies its own labels.</p>' : '');
  $('#legend').hidden = !ids.length;
}

function renderUsers() {
  const sel = $('#user-select');
  sel.innerHTML = state.users.map((u, i) => `<option value="${i}"${i === state.userIndex ? ' selected' : ''}` + `${u.fixture ? ` title="fixture: ${esc(u.fixture)}"` : ''}>${esc(u.username)}`
    + `${u.uid != null ? ` (${esc(u.uid)})` : ''} — ${u.scoreCount} scores</option>`).join('');
  sel.disabled = state.users.length < 2;
}

function renderAlgoSelects() {
  const fill = (sel) => { sel.innerHTML = state.algoIds.map((id) => `<option value="${esc(id)}">${esc(shortLabel(id))}</option>`).join(''); };
  fill($('#algo-a')); fill($('#algo-b'));
  $('#algo-a').value = state.A ?? '';
  $('#algo-b').value = state.B ?? '';
  $('#ab-note').innerHTML = state.algoIds.length ? `A = <strong>${esc(shortLabel(state.A))}</strong> · B = <strong>${esc(shortLabel(state.B))}</strong> — Δ columns are B − A` : '';
}

/** Per-algorithm totals, the A/B difference line, and the zoomed bar chart. */
function renderTotals() {
  const box = $('#total-table'), chart = $('#total-chart'), note = $('#total-note'), u = user();
  if (!state.algoIds.length || !u) {
    box.innerHTML = `<p class="empty">${state.algoIds.length ? 'This dataset contains no players, so there is nothing to compare.'
      : 'This dataset carries no algorithm pp values, so there is nothing to compare.'}</p>`;
    chart.innerHTML = ''; $('#ab-line').textContent = ''; note.textContent = '';
    return;
  }
  const base = totalFor(state.A).value;
  const rows = state.algoIds.map((id) => {
    const t = totalFor(id), d = t.value != null && base != null ? t.value - base : null;
    return { id, label: legendMeta(id).label, total: t.value, derived: t.derived, d, p: d != null && base ? d / base : null };
  });
  const role = (id) => (id === state.A ? 'A' : '') + (id === state.B && id !== state.A ? 'B' : '');
  box.innerHTML = '<table class="totals"><thead><tr><th scope="col">algorithm</th>' + `<th scope="col" class="num">total pp</th><th scope="col" class="num">Δ vs ${esc(shortLabel(state.A))}</th>`
    + '<th scope="col" class="num">Δ %</th></tr></thead><tbody>' + rows.map((r) => `<tr class="${r.id === state.A ? 'is-baseline' : ''}">`
      + `<td><span class="alg-name"><i class="dot ${dotClass(r.id)}"></i>${esc(r.label)}`
      + `${role(r.id) ? `<span class="hint"> ${role(r.id)}</span>` : ''}</span></td>`
      + `<td class="num">${fmtG(r.total)}</td>` + `<td class="num ${dirClass(r.d)}">${r.id === state.A ? '–' : signed(r.d)}</td>`
      + `<td class="num ${dirClass(r.d)}">${r.id === state.A ? '–' : signedPct(r.p)}</td></tr>`).join('') + '</tbody></table>';
  const tA = base, tB = totalFor(state.B).value, dAB = tA != null && tB != null ? tB - tA : null;
  $('#ab-line').innerHTML = dAB == null ? '<span class="role">A / B</span> — one of the two algorithms carries no total in this dataset.'
    : `<span class="role">A</span> ${esc(shortLabel(state.A))} ${fmtG(tA)} ` + `<span class="role">→ B</span> ${esc(shortLabel(state.B))} ${fmtG(tB)} `
      + `<span class="role">· diff (B − A)</span> <span class="${dirClass(dAB)}">${signed(dAB)}</span> `
      + `<span class="role">· relative (B / A)</span> <span class="${dirClass(dAB)}">${signedPct(tA ? dAB / tA : null)}</span> ` + `<span class="role">· ratio</span> ${fmt(tA ? tB / tA : null, 4)}`;
  const items = rows.filter((r) => r.total != null).map((r) => ({ id: r.id, label: clamp(r.label, 24), value: r.total, cls: `alg-${ALGO_ORDER.includes(r.id) ? r.id : 'other'}`,
    delta: r.id === state.A ? null : r.p, isA: r.id === state.A, isB: r.id === state.B,
  }));
  const drawn = items.length >= 2 ? barChart(items) : null;
  chart.innerHTML = drawn ? drawn.svg : '';
  const notes = [];
  if (drawn?.axisNote) notes.push(drawn.axisNote);
  if (rows.some((r) => r.derived)) notes.push("This file carries no total_pp for that player — the totals are approximated from the shard with osu!'s 0.95 decay.");
  if (state.algoIds.length < 2) notes.push('Only one algorithm carries numbers in this dataset.');
  note.textContent = notes.join(' ');
}

/** Inline SVG bars, one per algorithm. The axis is zoomed to the observed range:
 *  four totals within a few percent of each other would compare nothing from
 *  zero. Each bar prints its exact figure and its difference against A. */
function barChart(items) {
  const W = 680, ROW = 24, LBL = 136, VAL = 96, DEL = 68, PAD = 8;
  const track = W - LBL - VAL - DEL - PAD, H = items.length * ROW + PAD * 2;
  const vals = items.map((it) => it.value);
  const max = Math.max(...vals), min = Math.min(...vals);
  const pad = max > min ? (max - min) * 0.35 : 1;    // 35% of the spread on both sides
  const lo = min - pad, hi = max + pad;
  const bars = items.map((it, i) => {
    const y = PAD + i * ROW, txt = fmtG(it.value);
    const frac = hi > lo ? (it.value - lo) / (hi - lo) : 1;
    const w = Math.max(2, Math.min(1, frac) * track);
    const badge = it.isA && it.isB ? 'A=B' : it.isA ? 'A' : it.isB ? 'B' : '';
    const dTxt = it.isA ? 'baseline' : signedPct(it.delta);
    return `<g class="${esc(it.cls)}${it.isA ? ' is-a' : ''}${it.isB ? ' is-b' : ''}">`
      + `<title>${esc(it.label)}${badge ? ` (${badge})` : ''}: ${esc(txt)} pp${it.isA ? '' : `, ${esc(signedPct(it.delta))} vs A`}</title>`
      + `<text class="lbl" x="0" y="${y + 16}">${esc(it.label)}${badge ? ` · ${badge}` : ''}</text>` + `<rect class="track" x="${LBL}" y="${y + 4}" width="${track}" height="${ROW - 9}" rx="2"/>`
      + `<rect class="bar" x="${LBL}" y="${y + 4}" width="${w.toFixed(1)}" height="${ROW - 9}" rx="2"/>`
      + `<text class="val" x="${LBL + track + VAL}" y="${y + 16}" text-anchor="end">${esc(txt)}</text>`
      + `<text class="delta ${it.delta == null ? '' : dirClass(it.delta)}" x="${W}" y="${y + 16}" text-anchor="end">${esc(dTxt)}</text></g>`;
  }).join('');
  const axisNote = max > min ? `Bar length uses a zoomed axis starting at ${fmtG(lo)} pp (not 0), so a small gap stays visible; `
      + `the exact totals are above and Δ % is relative to A (${shortLabel(state.A)}).` : '';
  return { svg: `<svg class="barchart" viewBox="0 0 ${W} ${H}" role="img" ` + `aria-label="weighted total pp per algorithm, A = ${esc(shortLabel(state.A))}, B = ${esc(shortLabel(state.B))}">`
    + `${bars}</svg>`, axisNote };
}

/* ------------------------------- score table ------------------------------ */

/** One descriptor per column: header metadata AND cell renderer, so the head and
 *  the body of the table cannot drift apart. */
function columns() {
  const A = shortLabel(state.A), B = shortLabel(state.B);
  const others = state.algoIds.filter((id) => id !== state.A && id !== state.B);
  const num = (key, label, title, cell) => ({ key, label, type: 'num', title, cell });
  const txt = (key, label, cell) => ({ key, label, type: 'str', cell });
  const nnum = (v, d) => `<td class="num">${fmt(v, d)}</td>`;
  return [ { key: null, label: '', type: 'none', cell: (s) => {
      const open = state.open.has(s.i);
      return `<td class="cell-toggle"><button type="button" class="row-toggle" aria-expanded="${open}" ` + `aria-label="${open ? 'hide' : 'show'} details">${open ? '−' : '+'}</button></td>`;
    } },
    txt('map', 'beatmap', (s) => {
      const label = `${esc(s.artist)} – ${esc(s.title)}`;
      const map = s.bid == null ? label : `<a href="https://osu.ppy.sh/beats/${encodeURIComponent(s.bid)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      return `<td class="map">${map} <span class="ver">[${esc(s.version || '?')}]</span>` + `${s.bid == null ? '' : `<br><span class="bid">b${esc(s.bid)}</span>`}</td>`;
    }),
    num('keys', 'keys', null, (s) => `<td class="num">${s.keys == null ? '–' : esc(s.keys) + 'K'}</td>`),
    num('od', 'OD', null, (s) => nnum(s.od, 1)),
    txt('mods', 'mods', (s) => `<td>${esc(s.modsLabel)}</td>`),
    num('acc', 'acc %', null, (s) => nnum(s.acc, 2)),
    ...PP_KEYS.map((k, i) => num(k, PP_LABELS[i], COUNT_TITLE, (s) => `<td class="num">${s.counts[i] == null ? '–' : esc(s.counts[i])}</td>`)),
    num('starsFull', '★ full', 'Reimagined: sunny star rating of the full map', (s) => nnum(s.starsFull, 3)),
    num('starsRice', '★ rice', 'Reimagined: sunny star rating of the rice variant (every hold read as a tap)', (s) => nnum(s.starsRice, 3)),
    num('ln', 'ln ratio', 'share of objects that are long notes', (s) => nnum(s.ln, 4)),
    num('ppA', `pp ${A}`, `${A} — the A side`, (s) => nnum(ppA(s), 1)),
    num('ppB', `pp ${B}`, `${B} — the B side`, (s) => nnum(ppB(s), 1)),
    num('diff', `Δ ${B} − ${A}`, 'absolute difference B − A', (s) => `<td class="num ${dirClass(diffOf(s))}">${signed(diffOf(s), 1)}</td>`),
    num('rel', 'Δ % (B / A)', 'relative difference B / A − 1', (s) => `<td class="num ${dirClass(relOf(s))}">${signedPct(relOf(s))}</td>`),
    num('rankA', `rank ${A}`, `position in this bp list ordered by ${A}`, (s) => `<td class="num">${state.ranks?.a[s.i] ?? '–'}</td>`),
    num('rankB', `rank ${B}`, `position ordered by ${B}`, (s) => `<td class="num">${state.ranks?.b[s.i] ?? '–'}</td>`),
    num('shift', 'shift', `rank ${B} − rank ${A}; positive means the score drops under B. Highlighted from |shift| ≥ ${SHIFT_MID}, strong from ≥ ${SHIFT_BIG}`, (s) => {
      const sh = shiftOf(s);
      // A negative shift means the score climbed under B, so the colour is inverted.
      return `<td class="num shift ${shiftClass(sh)} ${dirClass(sh == null ? null : -sh)}" title="rank ${esc(B)} − rank ${esc(A)}">` + `${sh == null ? '–' : (sh > 0 ? '+' : '') + sh}</td>`;
    }),
    ...others.map((id) => num(`pp:${id}`, `pp ${shortLabel(id)}`, `${shortLabel(id)} pp`, (s) => nnum(s.pp[id] ?? null, 1))),
  ];
}

function renderTable() {
  const cols = columns();
  $('#score-table thead').innerHTML = `<tr>${cols.map((c) => {
    if (!c.key) return '<th class="cell-toggle" scope="col"><span class="hint">·</span></th>';
    const aria = state.sort.key !== c.key ? 'none' : state.sort.dir === 1 ? 'ascending' : 'descending';
    return `<th scope="col" class="sortable ${c.type === 'num' ? 'num' : ''}" data-key="${esc(c.key)}" `
      + `data-type="${c.type}" aria-sort="${aria}" title="${esc(c.title || COLS_HINT)}">${esc(c.label)}</th>`;
  }).join('')}</tr>`;
  const rows = filteredSorted(), slice = rows.slice(0, state.shown);
  $('#score-table tbody').innerHTML = slice.length ? slice.map((s) => rowHtml(s, cols)).join('') : `<tr><td colspan="${cols.length}" class="empty">${scores().length
      ? 'No score matches the current filters.' : 'This bp list has no scores in this dataset.'}</td></tr>`;
  $('#score-count').textContent = `${slice.length} of ${rows.length} ` + `${rows.length === scores().length ? 'scores' : 'matching scores'} shown`;
  const left = rows.length - state.shown;
  $('#show-more').hidden = left <= 0;
  $('#show-more').textContent = `show more (${Math.min(PAGE_SIZE, left)} of ${left} remaining)`;
  $('#export-csv').disabled = !rows.length;
}

function rowHtml(s, cols) {
  const open = state.open.has(s.i);
  const row = `<tr data-i="${s.i}">${cols.map((c) => c.cell(s)).join('')}</tr>`;
  // The detail row reuses the shared grid; it spans every column of the table.
  return open ? row + `<tr class="detail"><td colspan="${cols.length}"><div class="detail-grid">${detailGrid(s)}</div></td></tr>` : row;
}

/** The expanded detail block, shared by the score table and the disagreement
 *  list: full metadata, the Reimagined internals, every algorithm's pp, spread. */
function detailGrid(s) {
  const sp = spreadOf(s.pp), shift = shiftOf(s), mean = sp ? sp.mean : null, aPp = ppA(s);
  const counts = s.counts.every((c) => c == null) ? '–' : s.counts.map((c) => (c == null ? '–' : esc(c))).join(' / ');
  const dl = (pairs) => `<dl>${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
  return dl([ ['keys / OD / mods', `${s.keys == null ? '–' : esc(s.keys) + 'K'} / ${fmt(s.od, 1)} / ${esc(s.modsLabel)}`], ['mods_parts', esc(s.modsParts || '–')], ['accuracy', `${fmt(s.acc, 2)}%`],
    ['judgements', `${counts}<span class="hint"> 320/300/200/100/50/miss</span>`], ['beatmap id', s.bid == null ? '–' : esc(s.bid)], ['ln_ratio', fmt(s.ln, 4)], ['l_share', fmt(s.lShare, 4)],
    ['stars_full', fmt(s.starsFull, 3)], ['stars_rice', fmt(s.starsRice, 3)], ['w', fmt(s.w, 4)], ['coord_mod', fmt(s.coordMod, 4)], ['eff_star', fmt(s.effStar, 3)],
    ['acc_factor', fmt(s.accFactor, 4)], ['nf_factor', fmt(s.nfFactor, 4)],
  ]) + dl([ ['pp spread', sp ? `${signed(sp.abs, 1)} pp = ${signedPct(sp.rel)} (max/min ${fmt(sp.max / (sp.min || 1), 2)}×)` : '–'],
    [`rank ${shortLabel(state.A)} / ${shortLabel(state.B)}`, `${state.ranks?.a[s.i] ?? '–'} / ${state.ranks?.b[s.i] ?? '–'}`], ['shift (B − A)', shift == null ? '–' : (shift > 0 ? '+' : '') + shift],
    [`Δ ${shortLabel(state.B)} − ${shortLabel(state.A)}`, `${signed(diffOf(s), 1)} (${signedPct(relOf(s))})`],
  ]) + dl(state.algoIds.map((id) => {
    const v = s.pp[id] ?? null, dev = v != null && mean ? v - mean : null;
    const vsA = id === state.A ? ' (A)' : aPp > 0 && v != null ? ` ${signedPct(v / aPp - 1)} vs A` : '';
    return [`pp ${shortLabel(id)}`, `${fmt(v, 3)}<span class="hint">${vsA}${dev == null ? '' : ` · ${signed(dev, 1)} vs mean`}</span>`];
  }));
}
/* ------------------------------ layer summary ----------------------------- */

/** Layers aggregate the RELATIVE difference (B / A − 1) over every score of the
 *  bp list; the filters above deliberately do not apply, since filtering to 4K
 *  would empty the 6K and 7K rows. */
function renderLayers() {
  const box = $('#layer-table'), note = $('#layer-note'), list = scores();
  if (!list.length) { box.innerHTML = ''; note.textContent = ''; return; }
  /** n, how many are priced by both sides, the median relative diff and median pp under A. */
  const stat = (test) => {
    const inLayer = list.filter(test);
    const rels = inLayer.map(relOf).filter((v) => v != null);
    return { n: inLayer.length, nBoth: rels.length, medRel: median(rels), medPp: median(inLayer.map(ppA).filter((v) => v != null)) };
  };
  const cells = (name, st) => `<td class="layer-name">${esc(name)}</td>` + `<td class="num" title="${st.n} score${st.n === 1 ? '' : 's'}, ${st.nBoth} priced by both A and B">${st.n}</td>`
    + `<td class="num ${dirClass(st.medRel)}">${signedPct(st.medRel, 2)}</td><td class="num">${fmt(st.medPp, 2)}</td>`;
  const groups = [['by key mode', KEY_LAYERS], ['by mod family', MOD_LAYERS], ['by style bucket (ln_ratio)', STYLE_LAYERS.filter(([, test]) => list.some(test))]];
  box.innerHTML = '<table class="layers"><thead><tr><th scope="col">layer</th>' + '<th scope="col" class="num">n</th><th scope="col" class="num">median Δ (B vs A)</th>'
    + '<th scope="col" class="num">median pp (A)</th></tr></thead><tbody>' + groups.map(([g, rows]) => `<tr class="layer-group"><th colspan="4" scope="colgroup">${esc(g)}</th></tr>`
      + rows.map(([name, test]) => `<tr>${cells(name, stat(test))}</tr>`).join('')).join('') + `<tr class="layer-total">${cells('all scores', stat(() => true))}</tr></tbody></table>`;
  note.textContent = 'Layers cover every score of this bp list — the filters above do not apply here. '
    + `Relative difference is B / A − 1 per score, and the median of that column is shown; median pp is `
    + `the median of ${shortLabel(state.A)}'s pp in the layer. Mods are matched by substring (DT and NC ` + 'both count as rate-up).';
}
/* ------------------------- disagreement & scatter ------------------------- */

function renderDisagreement(list) {
  const rows = list.map((s) => ({ s, sp: spreadOf(s.pp) })).filter((x) => x.sp && x.sp.rel != null)
    .sort((a, b) => b.sp.rel - a.sp.rel || b.sp.abs - a.sp.abs || (a.s.i - b.s.i)).slice(0, TOP_DISAGREE);
  if (!rows.length) {
    $('#disagree').innerHTML = '<p class="empty">Not enough algorithms on these scores to measure disagreement.</p>';
    return;
  }
  $('#disagree').innerHTML = rows.map((x, i) => {
    const s = x.s, sp = x.sp;
    const pps = state.algoIds.map((id) => `<span class="dis-pp" title="${esc(id)}">${fmt(s.pp[id] ?? null, 1)}</span>`).join('');
    return `<div class="dis-row" data-i="${s.i}"><div class="dis-row-main"><span class="dis-rank">${i + 1}</span>`
      + `<span class="dis-map">${esc(s.artist)} – ${esc(s.title)} <span class="ver">[${esc(s.version || '?')}]</span> `
      + `<span class="hint">${s.keys == null ? '' : esc(s.keys) + 'K · '}${esc(s.modsLabel)}` + `${s.ln == null ? '' : ` · ln ${fmt(s.ln, 3)}`}</span></span>${pps}`
      + `<span class="dis-spread">${signedPct(sp.rel)}</span>` + `<span class="dis-pp dis-extra">${fmt(sp.max / (sp.min || 1), 2)}×</span></div>`
      + (state.open.has(s.i) ? `<div class="dis-detail"><div class="detail-grid" style="padding:7px 8px">${detailGrid(s)}</div></div>` : '') + '</div>';
  }).join('');
}

/** Scatter: x = ln_ratio, y = relative difference B vs A, one dot per score.
 *  Scaling: x is the fixed ln_ratio domain [0, 1] cut by the style thresholds at
 *  0.05 and 0.35; y is symmetric linear over ±max|relative difference| (at least
 *  ±2 %) so zero sits on the mid-line; the dashed line is the median. */
function renderScatter(list) {
  const host = $('#scatter'), note = $('#scatter-note');
  const pts = list.filter((s) => s.ln != null && relOf(s) != null).map((s) => ({ s, x: s.ln, y: relOf(s) }));
  const missing = list.length - pts.length;
  if (!pts.length) {
    host.innerHTML = '<p class="empty">No score here is priced by both A and B and carries an ln_ratio.</p>';
    note.textContent = missing ? `${missing} score${missing === 1 ? '' : 's'} skipped (missing ln_ratio or a pp value).` : '';
    return;
  }
  const W = 600, H = 300, L = 46, R = 14, T = 16, B = 42;
  const x0 = L, x1 = W - R, y0 = T, y1 = H - B, mid = (y0 + y1) / 2, half = (y1 - y0) / 2;
  const yMax = Math.max(0.02, ...pts.map((p) => Math.abs(p.y))) * 1.08;
  const xAt = (v) => x0 + Math.max(0, Math.min(1, v)) * (x1 - x0);
  const yAt = (v) => mid - (v / yMax) * half;
  const med = median(pts.map((p) => p.y));
  const pct = (v) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;    // signed, for values
  const pctPlain = (v) => `${(v * 100).toFixed(1)}%`;                  // unsigned, for axis ticks
  const yTicks = [yMax, yMax / 2, 0, -yMax / 2, -yMax].map((v) => `<line class="${v === 0 ? 'zero' : 'rule'}" ` + `x1="${x0}" x2="${x1}" y1="${yAt(v).toFixed(1)}" y2="${yAt(v).toFixed(1)}"/>`
    + `<text x="${x0 - 6}" y="${(yAt(v) + 3.5).toFixed(1)}" text-anchor="end">${pctPlain(v)}</text>`).join('');
  // Everything left of the first dashed line is rice, right of the second is LN.
  const buckets = [LN_RICE, LN_FULL].map((v) => `<line class="bucket" x1="${xAt(v).toFixed(1)}" x2="${xAt(v).toFixed(1)}" `
    + `y1="${y0}" y2="${y1}"/><text x="${(xAt(v) + 3).toFixed(1)}" y="${y0 + 10}">${v}</text>`).join('');
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((v) => `<text x="${xAt(v).toFixed(1)}" y="${y1 + 14}" text-anchor="middle">${v}</text>`).join('');
  const dots = pts.map((p) => `<circle class="dot" cx="${xAt(p.x).toFixed(1)}" cy="${yAt(p.y).toFixed(1)}" r="3">`
    + `<title>${esc(p.s.artist)} – ${esc(p.s.title)} [${esc(p.s.version || '?')}] · ln_ratio ${fmt(p.x, 4)} · `
    + `${esc(shortLabel(state.B))} vs ${esc(shortLabel(state.A))} ${pct(p.y)}</title></circle>`).join('');
  const yMed = yAt(Math.max(-yMax, Math.min(yMax, med)));
  const medLine = `<line class="median" x1="${x0}" x2="${x1}" y1="${yMed.toFixed(1)}" y2="${yMed.toFixed(1)}"/>`
    + `<text class="median-label" x="${x1 - 2}" y="${(yMed - 4).toFixed(1)}" text-anchor="end">median ${pct(med)}</text>`;
  host.innerHTML = `<svg class="scatter" viewBox="0 0 ${W} ${H}" role="img" `
    + `aria-label="relative difference of ${esc(shortLabel(state.B))} against ${esc(shortLabel(state.A))} by ln_ratio, one dot per score">`
    + yTicks + buckets + `<line class="rule" x1="${x0}" x2="${x1}" y1="${y1}" y2="${y1}"/>` + `<line class="rule" x1="${x0}" x2="${x0}" y1="${y0}" y2="${y1}"/>` + medLine + dots + xTicks
    + `<text class="axis-label" x="${x0}" y="${H - 12}">ln_ratio — share of long notes (0.05 and 0.35 = the layer cut-offs)</text>`
    + `<text class="axis-label" x="0" y="12">${esc(shortLabel(state.B))} vs ${esc(shortLabel(state.A))}</text></svg>`;
  const rice = pts.filter((p) => p.x < LN_RICE), ln = pts.filter((p) => p.x >= LN_FULL);
  const mr = median(rice.map((p) => p.y)), ml = median(ln.map((p) => p.y));
  note.textContent = `${pts.length} score${pts.length === 1 ? '' : 's'} plotted, y axis ±${pctPlain(yMax)}; median ${pct(med)}` + (mr != null ? `, rice median ${pct(mr)} (n=${rice.length})` : '')
    + (ml != null ? `, LN median ${pct(ml)} (n=${ln.length})` : '') + '. A gap between the two medians is the systematic long-note preference.'
    + (missing ? ` ${missing} score${missing === 1 ? '' : 's'} skipped (missing ln_ratio or a pp value).` : '');
}
/* --------------------------- cross-player overview ------------------------ */

function renderOverview() {
  const box = $('#overview-table'), note = $('#overview-note');
  box.innerHTML = '';
  if (!state.users.length || !state.algoIds.length) return;
  // Dense rank per algorithm over the index totals (1 = highest total).
  const ranks = new Map(state.algoIds.map((id) => [id, new Map()]));
  for (const id of state.algoIds) {
    state.users.map((u, i) => ({ i, v: num(u.totalPp[id]) })).filter((x) => x.v != null) .sort((a, b) => b.v - a.v || a.i - b.i)
      .forEach((x, k) => ranks.get(id).set(state.users[x.i].uid ?? x.i, k + 1));
  }
  const shiftCell = (id, uid) => {
    const r = ranks.get(id).get(uid), rb = ranks.get('bancho')?.get(uid);
    if (r == null) return '–';
    if (rb == null || id === 'bancho') return `${r}`;
    const d = rb - r;                                    // positive = the player moves up
    return `${r}${d ? `<span class="rank-shift ${dirClass(d)}">${d > 0 ? '▲' : '▼'}${Math.abs(d)}</span>` : ''}`;
  };
  box.innerHTML = '<table class="overview"><thead>' + '<tr><th scope="col" rowspan="2">player</th><th scope="col" class="num" rowspan="2">scores</th>'
    + `<th scope="col" class="group" colspan="${state.algoIds.length}">weighted total pp</th>` + `<th scope="col" class="group" colspan="${state.algoIds.length}">Δ vs Bancho</th>`
    + `<th scope="col" class="group" colspan="${state.algoIds.length}">rank (▲▼ vs Bancho)</th></tr><tr>`
    + state.algoIds.map((id) => `<th scope="col" class="num">${esc(shortLabel(id))}</th>`).join('') + state.algoIds.map(() => '<th scope="col" class="num blk">Δ %</th>').join('')
    + state.algoIds.map(() => '<th scope="col" class="num blk">rank</th>').join('') + '</tr></thead><tbody>' + state.users.map((u, i) => {
      const key = u.uid ?? i, base = num(u.totalPp['bancho']);
      return `<tr data-u="${i}"${i === state.userIndex ? ' class="row-active"' : ''}>` + `<td class="pname">${esc(u.username)}${u.uid == null ? '' : `<span class="hint"> (${esc(u.uid)})</span>`}</td>`
        + `<td class="num">${u.scoreCount}</td>` + state.algoIds.map((id) => `<td class="num">${fmtG(num(u.totalPp[id]))}</td>`).join('') + state.algoIds.map((id) => {
          const t = num(u.totalPp[id]), d = t != null && base ? t / base - 1 : null;
          return `<td class="num blk ${dirClass(d)}">${id === 'bancho' ? '–' : signedPct(d)}</td>`;
        }).join('') + state.algoIds.map((id) => `<td class="num blk rank">${shiftCell(id, key)}</td>`).join('') + '</tr>';
    }).join('') + '</tbody></table>';
  note.textContent = `Ranks run over the ${state.users.length} player${state.users.length === 1 ? '' : 's'} here (1 = highest `
    + "weighted total); ▲/▼ is the move against the same player's Bancho rank, so it shows who gains or "
    + 'loses when the algorithm is switched. Built from data/index.json alone — no player shard is needed.';
}

/** Provenance: exactly which build produced the numbers on screen. */
function renderProvenance() {
  const dl = $('#prov'), s = state.source, e = s?.engine || {};
  if (!s) { dl.innerHTML = '<dt>dataset</dt><dd>not loaded</dd>'; return; }
  const rows = [ ['engine', [e.name, e.version].filter(Boolean).join(' ') || '–'], ['spec version', e.spec_version || '–'], ['rosu-pp revision', e.rosu_pp_rev || '–'],
    ['generated at', fmtDate(s.generated_at) || '–'], ['schema version', s.schema_version == null ? '–' : String(s.schema_version)],
    ['players', String(state.users.length)], ['scores', s.score_count == null ? '–' : String(s.score_count)],
    ['dataset source', s.origin === 'file' ? `local file: ${s.filename || '(unnamed)'}` : INDEX_URL],
  ];
  const warn = Array.isArray(s.warnings) ? s.warnings : [];
  dl.innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('') + `<dt>warnings</dt><dd>${warn.length ? `<span class="warn">${warn.length}</span>` : 'none'}</dd>`
    + (warn.length ? `<dt></dt><dd><ul class="warn-list">${warn.slice(0, WARN_LIMIT).map((w) => `<li>${esc(w)}</li>`).join('')}`
      + `${warn.length > WARN_LIMIT ? `<li>… (+${warn.length - WARN_LIMIT} more)</li>` : ''}</ul></dd>` : '');
}

/** A shard that failed to load, or a bp list the dataset has no scores for. */
function renderShardError() {
  const panel = $('#panel-shard-error'), u = user();
  const broken = state.shardState === 'error';
  const blank = state.shardState === 'ready' && !!state.shard && !scores().length;
  panel.hidden = !(broken || blank);
  if (panel.hidden) return;
  $('#shard-error-title').textContent = broken ? 'Player data unavailable' : 'No scores in this bp list';
  $('#shard-error-text').textContent = broken ? `Could not read the scores of ${u?.username ?? 'this bp list'} — ${state.shardError}`
    : `${u?.username ?? 'This bp list'} has no scores in this dataset (the index lists ${u?.scoreCount ?? 0}), ` + 'so there is nothing to rank, chart or export.';
  $('#shard-retry').hidden = !broken;
}

/** Everything that depends on data (not on the filters). */
function renderAll() {
  const ready = state.shardState === 'ready' && scores().length > 0;
  renderLegend();
  renderMeta(state.source?.origin === 'file' ? `source: ${state.source.filename || 'local file'}` : `source: ${INDEX_URL}`);
  renderNotice();
  renderUsers();
  renderAlgoSelects();
  $('#panel-summary').hidden = !state.source;
  $('#panel-scores').hidden = !ready;
  $('#panel-layers').hidden = !ready;
  $('#panel-disagree').hidden = !ready;
  $('#panel-overview').hidden = !state.users.length;
  renderTotals();
  renderShardError();
  renderOverview();
  renderProvenance();
  renderList();
}

/** The views driven by the filter / sort / page state. */
function renderList() {
  if (state.shardState !== 'ready' || !scores().length) {
    $('#score-table thead').innerHTML = ''; $('#score-table tbody').innerHTML = '';
    $('#disagree').innerHTML = ''; $('#scatter').innerHTML = ''; $('#layer-table').innerHTML = '';
    $('#scatter-note').textContent = ''; $('#score-count').textContent = ''; $('#show-more').hidden = true;
    return;
  }
  const list = filteredSorted();
  renderTable();
  renderLayers();
  renderDisagreement(list);
  renderScatter(list);
}
/* --------------------------------- CSV ----------------------------------- */

/** One CSV field: quoted when it contains a comma, a quote or a newline. */
const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvNum = (v, d = 3) => (v == null ? '' : Number(v).toFixed(d));

/**
 * Export the current view as CSV: the filter and sort apply, paging does not.
 * The A/B/diff/rank columns carry both algorithm ids in their names, so a file
 * kept next to another comparison stays unambiguous; the BOM keeps Excel from
 * mangling UTF-8 artist names.
 */
function exportCsv() {
  const rows = filteredSorted();
  if (!rows.length) return;
  const A = state.A, B = state.B;
  const head = ['beatmap_id', 'artist', 'title', 'version', 'keys', 'od', 'mods', 'mods_parts', 'accuracy',
    ...PP_KEYS, ...state.algoIds.map((id) => `pp_${id}`),
    `diff_pp_${B}_minus_${A}`, `rel_pct_${B}_over_${A}`, `rank_${A}`, `rank_${B}`, `rank_shift_${B}_minus_${A}`,
    'spread_rel', 'stars_full', 'stars_rice', 'ln_ratio', 'l_share', 'w', 'coord_mod', 'eff_star', 'acc_factor', 'nf_factor'];
  const lines = rows.map((s) => {
    const sp = spreadOf(s.pp);
    return [s.bid, s.artist, s.title, s.version, s.keys, s.od, s.mods, s.modsParts, csvNum(s.acc),
      ...s.counts, ...state.algoIds.map((id) => csvNum(s.pp[id] ?? null)),
      csvNum(diffOf(s)), relOf(s) == null ? '' : csvNum(relOf(s) * 100, 4),
      state.ranks?.a[s.i] ?? '', state.ranks?.b[s.i] ?? '', shiftOf(s) ?? '',
      sp?.rel == null ? '' : csvNum(sp.rel * 100, 4),
      csvNum(s.starsFull), csvNum(s.starsRice), csvNum(s.ln, 4), csvNum(s.lShare, 4), csvNum(s.w, 4),
      csvNum(s.coordMod, 4), csvNum(s.effStar, 3), csvNum(s.accFactor, 4), csvNum(s.nfFactor, 4)] .map(csvCell).join(',');
  });
  const blob = new Blob([`\uFEFF${[head.join(','), ...lines].join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `scores_${user()?.uid ?? 'player'}_${A}_vs_${B}.csv`;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  const btn = $('#export-csv');
  btn.textContent = `exported ${rows.length} rows`;
  setTimeout(() => { btn.textContent = 'Export CSV'; }, 2500);
}
/* --------------------------------- loading -------------------------------- */

function applyIndex(raw, origin, eagerShard) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('top level is not a JSON object');
  const rawUsers = (Array.isArray(raw.users) ? raw.users : []).filter((u) => u && typeof u === 'object');
  if (!rawUsers.length && !Array.isArray(raw.algorithms)) throw new Error('no "users" array and no "algorithms" array');
  state.source = Object.assign({}, raw, { origin: origin.kind, filename: origin.filename });
  state.users = rawUsers.map(normalizeUser);
  state.shard = null; state.ranks = null; state.shardState = 'empty';
  state.algoIds = []; state.A = null; state.B = null;
  resolveAlgorithms(raw, rawUsers);
  state.userIndex = 0; state.shown = PAGE_SIZE; state.open.clear(); state.loadError = null;
  state.eagerShard = eagerShard || null;
  state.sort = { key: state.A ? `pp:${state.A}` : 'map', dir: state.A ? -1 : 1 };
  $('#loader').hidden = true;
  $('#loader-err').hidden = true; $('#loader-err').textContent = '';
  renderAll();
  loadShard();
}

/** Fetch (or reuse) the shard of the selected player and rank it. */
async function loadShard() {
  const u = user(), eager = state.eagerShard;
  state.shard = null; state.ranks = null; state.shardError = null;
  state.shown = PAGE_SIZE; state.open.clear();
  state.eagerShard = null;
  if (!u) { state.shardState = 'empty'; renderAll(); return; }
  if (eager) {                                     // a shard dropped in on its own
    state.shard = normalizeShard(eager, u);
    state.shardState = 'ready';
  } else if (u.scoreCount === 0) {                 // nothing to fetch: the index says so
    state.shard = { uid: u.uid, username: u.username, scores: [] };
    state.shardState = 'ready';
  } else {
    const url = DATA_DIR + (u.file || `players/${u.uid}.json`);
    const token = ++state.shardToken;
    state.shardState = 'loading';
    renderAll();
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const raw = await res.json();
      if (token !== state.shardToken) return;      // a newer selection won the race
      state.shard = normalizeShard(raw, u);
      state.shardState = 'ready';
    } catch (err) {
      if (token !== state.shardToken) return;
      state.shardState = 'error';
      state.shardError = `${url} — ${err?.message ?? err}`;
      renderAll();
      return;
    }
  }
  resolveAlgorithms(state.source || {}, state.source?.users || []);
  refreshRanks();
  renderAll();
}

/** Empty state: no usable dataset. Say why, point at the CLI, and keep the
 *  drag-and-drop / file-input loader — over file:// it is the only way in. */
function showEmpty(reason, blocked) {
  state.source = null; state.users = []; state.algoIds = []; state.shard = null;
  state.ranks = null; state.shardState = 'empty'; state.loadError = null;
  ['#panel-summary', '#panel-scores', '#panel-layers', '#panel-disagree', '#panel-overview', '#panel-shard-error'] .forEach((sel) => { $(sel).hidden = true; });
  $('#loader').hidden = false;
  $('#loader-err').hidden = true; $('#loader-err').textContent = '';
  $('#loader-why').textContent = reason;
  $('#loader-hint').innerHTML = blocked ? 'This page was opened straight from disk (<code>file://</code>), where browsers refuse to read '
      + 'sibling files. Serve the directory over HTTP, or load <code>index.json</code> below.' : 'Generate <code>docs/data/index.json</code> with the CLI above, then reload this page — or load an '
      + 'existing <code>index.json</code> (or a single player shard) below.';
  renderMeta('no dataset loaded');
  renderLegend();
  renderProvenance();
  renderList();
}

/** Fetch the index; on any failure fall through to the empty state. */
async function boot() {
  const fromDisk = location.protocol === 'file:';
  const fail = (what, err) => showEmpty(`${INDEX_URL} ${what}: ${err?.message ?? err}.`, fromDisk);
  let res;
  // A TypeError ("Failed to fetch") is what file:// and offline pages produce.
  try { res = await fetch(INDEX_URL, { cache: 'no-store' }); } catch (err) { return fail('could not be fetched', err); }
  if (!res.ok) return showEmpty(`${INDEX_URL} is not available: HTTP ${res.status} ${res.statusText}.`, fromDisk);
  let text;
  try { text = await res.text(); } catch (err) { return fail('could not be read', err); }
  try { applyIndex(JSON.parse(text), { kind: 'live' }); } catch (err) { fail('is not usable', err); }
}

/** Manual load: an index document (the normal case) or a single player shard,
 *  which renders on its own with its totals derived from the scores. */
function loadText(text, filename) {
  const report = (msg) => {
    if (state.source) { state.loadError = msg; renderNotice(); }
    else {
      showEmpty(msg, location.protocol === 'file:');
      $('#loader-err').hidden = false; $('#loader-err').textContent = msg;
    }
  };
  let raw;
  try { raw = JSON.parse(text); } catch (err) { return report(`${filename}: ${err.message}`); }
  try {
    if (Array.isArray(raw?.users)) return applyIndex(raw, { kind: 'file', filename });
    if (Array.isArray(raw?.columns) && Array.isArray(raw?.scores)) {          // a lone player shard
      const n = raw.scores.length;
      return applyIndex({ schema_version: raw.schema_version, generated_at: null, engine: null, algorithms: null, users: [{
          uid: raw.uid ?? null, username: raw.username ?? 'local shard', fixture: filename, scores: n, file: null, total_pp: {},
        }], score_count: n, warnings: [],
      }, { kind: 'file', filename }, raw);
    }
    throw new Error('expected an index document ("users" array) or a player shard ("columns" + "scores")');
  } catch (err) { report(`${filename}: ${err.message}`); }
}

function readFile(file) {
  if (!file) return;
  const r = new FileReader();
  r.onload = () => loadText(String(r.result), file.name);
  r.onerror = () => loadText('', file.name);  // surfaces as a JSON parse error
  r.readAsText(file);
}
/* ---------------------------------- events -------------------------------- */

/** Sorting: first click on a numeric column sorts descending, text ascending. */
$('#score-table thead').addEventListener('click', (ev) => {
  const th = ev.target.closest('th[data-key]');
  if (!th) return;
  const key = th.dataset.key;
  state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: th.dataset.type === 'num' ? -1 : 1 };
  state.shown = Math.max(state.shown, PAGE_SIZE);
  renderTable();
});
// Row click (or the disclosure button) expands the detail row of that score.
$('#score-table tbody').addEventListener('click', (ev) => {
  if (ev.target.closest('a')) return;
  const tr = ev.target.closest('tr[data-i]');
  if (!tr) return;
  const i = Number(tr.dataset.i);
  if (state.open.has(i)) state.open.delete(i); else state.open.add(i);
  renderTable();
});
$('#disagree').addEventListener('click', (ev) => {
  const row = ev.target.closest('.dis-row');
  if (!row) return;
  const i = Number(row.dataset.i);
  if (state.open.has(i)) state.open.delete(i); else state.open.add(i);
  renderDisagreement(filteredSorted());
});
$('#overview-table').addEventListener('click', (ev) => {
  const tr = ev.target.closest('tr[data-u]');
  if (!tr) return;
  state.userIndex = Number(tr.dataset.u) || 0;
  loadShard();
});
$('#q').addEventListener('input', (ev) => { state.q = ev.target.value; state.shown = PAGE_SIZE; renderList(); });
$('.filters').addEventListener('click', (ev) => {
  const chip = ev.target.closest('.chip[data-f]');
  if (!chip) return;
  state.f[chip.dataset.f] = chip.dataset.v;
  for (const sib of chip.parentElement.children) {
    sib.classList.toggle('is-on', sib === chip);
    sib.setAttribute('aria-pressed', String(sib === chip));
  }
  state.shown = PAGE_SIZE;
  renderList();
});
$('#f-reset').addEventListener('click', () => {
  state.q = ''; state.f = { keys: 'all', mods: 'all', ln: 'all' }; state.shown = PAGE_SIZE;
  $('#q').value = '';
  document.querySelectorAll('.chips .chip').forEach((c) => {
    const on = c.dataset.v === 'all';
    c.classList.toggle('is-on', on);
    c.setAttribute('aria-pressed', String(on));
  });
  renderList();
});
$('#show-more').addEventListener('click', () => { state.shown += PAGE_SIZE; renderTable(); });
$('#export-csv').addEventListener('click', exportCsv);
$('#user-select').addEventListener('change', (ev) => { state.userIndex = Number(ev.target.value) || 0; loadShard(); });
$('#shard-retry').addEventListener('click', () => loadShard());

/** A and B drive every comparison on the page; ranks and both charts follow. */
function setPair(a, b) {
  state.A = a; state.B = b;
  refreshRanks();
  renderAlgoSelects();
  renderTotals();
  renderList();
}
$('#algo-a').addEventListener('change', (ev) => {
  const a = ev.target.value;
  setPair(a, state.B === a ? (state.algoIds.find((id) => id !== a) ?? a) : state.B);
});
$('#algo-b').addEventListener('change', (ev) => {
  const b = ev.target.value;
  setPair(state.A === b ? (state.algoIds.find((id) => id !== b) ?? b) : state.A, b);
});
$('#swap-ab').addEventListener('click', () => setPair(state.B, state.A));
for (const el of [$('#file-head'), $('#file-drop')]) {
  el.addEventListener('change', (ev) => readFile(ev.target.files && ev.target.files[0]));
}
/* Drag & drop anywhere on the page; file:// visitors need this to load data. */
const dragHint = $('#drag-hint');
for (const ev of ['dragenter', 'dragover']) {
  window.addEventListener(ev, (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault();                       // stop the browser from navigating to the file
    dragHint.hidden = false;
  });
}
window.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) dragHint.hidden = true; });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragHint.hidden = true;
  readFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
});

boot();
