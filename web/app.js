'use strict';
/* ===========================================================================
 * mania-sr-pp-reimagined — PP algorithm comparison front-end.
 * Vanilla JS, no dependencies, no build step. Data contract: see README.md.
 *
 * mania-pp-cli writes web/data/results.json; this page fetches it and, when it
 * is absent or unreadable, shows an empty state with a drag-and-drop /
 * file-input loader. Over file:// that loader is the only way in, because
 * browsers refuse fetch() on file:// documents.
 *
 * The repository ships no sample dataset: an empty state is a normal state.
 * =========================================================================== */
/* --------------------------------- config -------------------------------- */

const DATA_URL = 'data/results.json';   // written by mania-pp-cli, sibling of this page
const PAGE_SIZE = 50;                   // score rows rendered at a time ("show more" appends)
const TOP_DISAGREE = 15;                // rows in the disagreement view
const LN_RATIO_CUTOFF = 0.2;            // ln_ratio >= cutoff counts as an LN map, below as rice
const ALGO_ORDER = ['bancho', 'sunny', 'surface', 'reimagined'];
const COLS_HINT = 'click a header to sort';

/** Used when the data file carries no label/description for a known algorithm id. */
const FALLBACK_ALGOS = [
  { id: 'bancho', label: 'bancho (official)', description: 'official osu! pp (osu!lazer mania)' },
  { id: 'sunny', label: 'sunny (SRR)', description: 'community Star-Rating-Rebirth (pattern + accuracy part)' },
  { id: 'surface', label: 'surface', description: 'sunny plus the surface map-based timing model' },
  { id: 'reimagined', label: 'reimagined (ours)', description: 'three-channel R/L/A algorithm' },
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
const dirClass = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const clamp = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
/** One `detail` value: integers stay bare, fractions get 3 decimals. */
const fmtDetail = (v) => (typeof v === 'number' && Number.isFinite(v)
  ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : String(v));

/** "2026-09-13T00:00:00Z" -> "2026-09-13 00:00 UTC"; unparsable input passes through. */
function fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? String(iso) : d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}
/* ---------------------------------- state --------------------------------- */

const state = {
  users: [], algoIds: [], algoMeta: new Map(), baseId: null, focusId: null,
  source: null, loadError: null, userIndex: 0,
  sort: { key: null, dir: -1 }, q: '', f: { keys: 'all', mods: 'all', ln: 'all' },
  shown: PAGE_SIZE, open: new Set(),
};
/* ------------------------------ normalisation ----------------------------- */

/**
 * Algorithm ids = those that actually carry numbers, bancho/sunny/surface/
 * reimagined first, then anything extra alphabetically. Falls back to the
 * declared `algorithms` array when the data has no pp at all.
 */
function resolveAlgorithms(raw, users) {
  const seen = new Set();
  for (const u of users) {
    for (const id of Object.keys(u.total_pp || {})) seen.add(String(id));
    for (const sc of u.scores || []) for (const id of Object.keys(sc.pp || {})) seen.add(String(id));
  }
  const declared = (Array.isArray(raw.algorithms) ? raw.algorithms : []).filter((a) => a && a.id);
  state.algoMeta = new Map(declared.map((a) => [String(a.id), {
    id: String(a.id), label: String(a.label || a.id), description: String(a.description || ''),
  }]));
  const pool = seen.size ? seen : new Set(state.algoMeta.keys());
  const ids = ALGO_ORDER.filter((id) => pool.has(id));
  for (const id of [...pool].sort()) if (!ids.includes(id)) ids.push(id);
  return ids;
}

function normalizeScore(sc) {
  const mods = String(sc.mods ?? '').trim().toUpperCase();
  const pp = {};
  for (const [k, v] of Object.entries(sc.pp || {})) {
    const n = num(v);
    if (n !== null) pp[String(k)] = n;
  }
  const artist = String(sc.artist ?? ''), title = String(sc.title ?? ''), version = String(sc.version ?? '');
  const det = sc.detail && typeof sc.detail === 'object' && !Array.isArray(sc.detail) ? sc.detail : {};
  return {
    bid: num(sc.beatmap_id), artist, title, version, keys: num(sc.keys), od: num(sc.od),
    mods, modsLabel: mods === '' ? 'NM' : mods, // an empty mod string is NoMod in osu!
    acc: num(sc.accuracy), pp, counts: Array.isArray(sc.counts) ? sc.counts : [],
    detail: det, ln: num(det.ln_ratio),
    hay: [artist, title, version, mods, sc.beatmap_id ?? '', sc.keys ?? ''].join(' ').toLowerCase(),
  };
}

function normalizeUser(u, algoIds) {
  const scores = (Array.isArray(u.scores) ? u.scores : [])
    .filter((sc) => sc && typeof sc === 'object')
    .map((sc, i) => Object.assign(normalizeScore(sc), { idx: i }));
  const totals = {};
  let given = false;
  for (const id of algoIds) {
    const t = num((u.total_pp || {})[id]);
    if (t !== null) given = true;
    totals[id] = t;
  }
  // Tolerate a missing total_pp: approximate with osu!'s 0.95-weighted best sum.
  let derived = false;
  if (!given && scores.length) {
    for (const id of algoIds) {
      const vals = scores.map((s) => s.pp[id]).filter((v) => v != null).sort((a, b) => b - a);
      if (!vals.length) { totals[id] = null; continue; }
      totals[id] = vals.reduce((acc, v, i) => acc + v * Math.pow(0.95, i), 0);
      derived = true;
    }
  }
  return {
    uid: u.uid ?? null, username: String(u.username ?? u.uid ?? 'unknown'),
    fixture: u.fixture == null ? null : String(u.fixture), totals, derived, scores,
  };
}
/* --------------------------------- layers --------------------------------- */
/* Mods are matched by substring, because the engine emits both "EZDT" and "EZDTV2". */

const keyLayer = (s) => (s.keys === 4 ? '4' : s.keys === 7 ? '7' : 'other');
function modLayer(s) {
  if (s.mods === '' || s.mods === 'NM') return 'nm';
  if (s.mods.includes('DT') || s.mods.includes('NC')) return 'dt';
  if (s.mods.includes('HT') || s.mods.includes('DC')) return 'ht';
  return 'other';
}
// A score with no ln_ratio is unclassified: visible in "all", in neither single layer.
const lnLayer = (s) => (s.ln == null ? 'unk' : s.ln >= LN_RATIO_CUTOFF ? 'ln' : 'rc');
/* ------------------------------- derived data ----------------------------- */

const user = () => state.users[state.userIndex] || null;

/** focus − base, i.e. reimagined − bancho whenever both are present. */
function deltaOf(s) {
  const a = s.pp[state.focusId], b = s.pp[state.baseId];
  return a == null || b == null ? null : a - b;
}

/** max−min spread across the algorithms that priced this score. */
function spreadOf(pp) {
  const vals = state.algoIds.map((id) => pp[id]).filter((v) => v != null);
  if (vals.length < 2) return null;
  const max = Math.max(...vals), min = Math.min(...vals);
  const mean = vals.reduce((x, y) => x + y, 0) / vals.length;
  return { max, min, mean, abs: max - min, rel: mean > 0 ? (max - min) / mean : null };
}

function filteredSorted() {
  const u = user();
  if (!u) return [];
  const q = state.q.trim().toLowerCase(), f = state.f;
  const rows = u.scores.filter((s) => (f.keys === 'all' || keyLayer(s) === f.keys)
    && (f.mods === 'all' || modLayer(s) === f.mods)
    && (f.ln === 'all' || lnLayer(s) === f.ln)
    && (!q || s.hay.includes(q)));
  const { key, dir } = state.sort;
  if (!key) return rows;
  const isNum = key !== 'map' && key !== 'mods';
  return rows.slice().sort((a, b) => compare(a, b, key, isNum) * dir);
}

function sortValue(s, key) {
  if (key === 'map') return `${s.artist} ${s.title} ${s.version}`.toLowerCase();
  if (key === 'mods') return s.modsLabel.toLowerCase();
  if (key === 'delta') return deltaOf(s);
  if (key.startsWith('pp:')) return s.pp[key.slice(3)] ?? null;
  return s[key] ?? null;
}

/** Nulls always sink to the bottom, whichever direction is active. */
function compare(a, b, key, isNum) {
  const va = sortValue(a, key), vb = sortValue(b, key);
  const na = va == null, nb = vb == null;
  if (na || nb) return na && nb ? 0 : na ? 1 : -1;
  const r = isNum ? va - vb : va < vb ? -1 : va > vb ? 1 : 0;
  return r || sortValue(a, 'map').localeCompare(sortValue(b, 'map')) || (a.idx - b.idx);
}
/* -------------------------------- rendering ------------------------------- */

function renderMeta(src) {
  const e = state.source?.engine || {};
  const parts = [];
  if (e.name) parts.push(`${e.name}${e.version ? ' ' + e.version : ''}`);
  if (e.spec_version) parts.push(`spec ${e.spec_version}`);
  if (e.rosu_pp_rev) parts.push(`rosu-pp ${e.rosu_pp_rev}`);
  const gen = fmtDate(state.source?.generated_at);
  if (gen) parts.push(`generated ${gen}`);
  parts.push(`${state.users.length} bp list${state.users.length === 1 ? '' : 's'}`, src);
  $('#meta').textContent = parts.join('  ·  ');
}

/** Legend entry: the data file's own metadata, else the built-in description. */
const legendMeta = (id) => state.algoMeta.get(id) || FALLBACK_ALGOS.find((a) => a.id === id)
  || { id, label: id, description: 'no description in this data file' };
const dotClass = (id) => `c-${ALGO_ORDER.includes(id) ? id : 'other'}`;

function renderNotice() {
  const s = state.source, msgs = [];
  if (s?.origin === 'file') {
    msgs.push(`Showing a locally loaded file: <code>${esc(s.filename || '(unnamed)')}</code>.`);
  }
  if (s?.schema_version != null && num(s.schema_version) !== 1) {
    msgs.push(`<strong>Unexpected <code>schema_version</code> ${esc(s.schema_version)}</strong> `
      + '(this build expects 1) — missing fields are tolerated.');
  }
  // The engine reports skipped scores / failed algorithms here; keep them visible.
  const warn = Array.isArray(s?.warnings) ? s.warnings : [];
  if (warn.length) {
    msgs.push(`<strong>${warn.length} engine warning${warn.length === 1 ? '' : 's'}:</strong> `
      + warn.slice(0, 3).map((w) => esc(w)).join('; ')
      + (warn.length > 3 ? ` … (+${warn.length - 3} more)` : ''));
  }
  // A failed manual load must not look like a missing dataset: report it here and
  // keep whatever is already rendered.
  if (state.loadError) msgs.push(`<strong>Could not load that file</strong> — ${esc(state.loadError)}`);
  $('#source-note').hidden = !msgs.length;
  $('#source-note').innerHTML = msgs.join('<br>');
}

function renderLegend() {
  // With no dataset yet, still explain what the site compares.
  const builtin = state.algoIds.length === 0;
  const ids = builtin ? FALLBACK_ALGOS.map((a) => a.id) : state.algoIds;
  const cards = ids.map((id) => {
    const m = legendMeta(id);
    return `<div class="card"><div class="name"><i class="dot ${dotClass(id)}"></i>${esc(m.label)}</div>`
      + `<div class="desc">${esc(m.description || 'no description in this data file')}</div></div>`;
  }).join('');
  const el = $('#legend');
  el.innerHTML = cards + (builtin
    ? '<p class="hint legend-note">Built-in descriptions — a loaded dataset supplies its own labels.</p>' : '');
  el.hidden = !ids.length;
}

function renderUsers() {
  const sel = $('#user-select');
  sel.innerHTML = state.users.map((u, i) => `<option value="${i}"${i === state.userIndex ? ' selected' : ''}`
    + `${u.fixture ? ` title="fixture: ${esc(u.fixture)}"` : ''}>${esc(u.username)}`
    + `${u.uid != null ? ` (${esc(u.uid)})` : ''} — ${u.scores.length} scores</option>`).join('');
  sel.disabled = state.users.length < 2;
}

function renderSummary() {
  const u = user(), box = $('#total-table'), chart = $('#total-chart'), note = $('#total-note');
  if (!state.algoIds.length || !u) {
    box.innerHTML = `<p class="empty">${state.algoIds.length
      ? 'This file contains no users, so there is nothing to compare.'
      : 'This file carries no algorithm pp values, so there is nothing to compare.'}</p>`;
    chart.innerHTML = ''; note.textContent = '';
    return;
  }
  const base = u.totals[state.baseId] ?? null;
  const rows = state.algoIds.map((id) => {
    const total = u.totals[id] ?? null;
    const d = total != null && base != null ? total - base : null;
    return { id, label: legendMeta(id).label, total, d, p: d != null && base ? d / base : null };
  });
  box.innerHTML = `<table class="totals"><thead><tr><th>algorithm</th><th class="num">total pp</th>`
    + `<th class="num">Δ vs ${esc(state.baseId)}</th><th class="num">Δ %</th></tr></thead><tbody>`
    + rows.map((r) => `<tr><td><span class="alg-name"><i class="dot ${dotClass(r.id)}"></i>${esc(r.label)}</span>`
      + `${r.id === state.baseId ? '<span class="hint"> baseline</span>' : ''}</td>`
      + `<td class="num">${fmtG(r.total)}</td>`
      + `<td class="num ${dirClass(r.d)}">${r.id === state.baseId ? '–' : signed(r.d)}</td>`
      + `<td class="num ${dirClass(r.d)}">${r.id === state.baseId ? '–' : signedPct(r.p)}</td></tr>`).join('')
    + '</tbody></table>';

  const items = rows.filter((r) => r.total != null)
    .map((r) => ({ label: clamp(r.label, 22), value: r.total, cls: `alg-${ALGO_ORDER.includes(r.id) ? r.id : 'other'}` }));
  const drawn = items.length >= 2 ? barChart(items) : null;
  chart.innerHTML = drawn ? drawn.svg : '';
  const notes = [];
  if (drawn?.axisNote) notes.push(drawn.axisNote);
  if (u.derived) notes.push("No total_pp in the data — the totals above are approximated from the scores with osu!'s 0.95 decay.");
  if (!u.derived && state.algoIds.length < 2) notes.push('Only one algorithm carries numbers in this file.');
  note.textContent = notes.join(' ');
}

/**
 * Inline SVG horizontal bars, one per algorithm.
 * The axis is zoomed to the observed range: with four totals inside a few percent
 * of each other, bars drawn from zero would look identical and compare nothing.
 * Every bar prints its exact figure and the note says where the axis starts.
 */
function barChart(items) {
  const W = 560, ROW = 24, LBL = 132, VAL = 92, PAD = 6;
  const track = W - LBL - VAL, H = items.length * ROW + PAD * 2;
  const vals = items.map((it) => it.value ?? 0);
  const max = Math.max(...vals), min = Math.min(...vals);
  const pad = max > min ? (max - min) * 0.35 : 1;   // 35% of the spread on both sides
  const lo = min - pad, hi = max + pad;
  const bars = items.map((it, i) => {
    const y = PAD + i * ROW, txt = fmtG(it.value);
    const frac = hi > lo ? (it.value - lo) / (hi - lo) : 1;
    const w = Math.max(2, Math.min(1, frac) * track);
    return `<g class="${esc(it.cls)}"><title>${esc(it.label)}: ${esc(txt)} pp</title>`
      + `<text x="0" y="${y + 16}">${esc(it.label)}</text>`
      + `<rect class="track" x="${LBL}" y="${y + 4}" width="${track}" height="${ROW - 9}" rx="2"/>`
      + `<rect x="${LBL}" y="${y + 4}" width="${w.toFixed(1)}" height="${ROW - 9}" rx="2"/>`
      + `<text class="val" x="${W}" y="${y + 16}" text-anchor="end">${esc(txt)}</text></g>`;
  }).join('');
  const axisNote = max > min
    ? `Bar length uses a zoomed axis starting at ${fmtG(lo)} pp (not 0), so a small gap stays visible; `
      + 'the exact totals are above.' : '';
  return { svg: `<svg class="barchart" viewBox="0 0 ${W} ${H}" role="img" `
    + `aria-label="total pp per algorithm">${bars}</svg>`, axisNote };
}

function columns() {
  return [
    { key: 'map', label: 'beatmap', type: 'str' }, { key: 'keys', label: 'keys', type: 'num' },
    { key: 'od', label: 'OD', type: 'num' }, { key: 'mods', label: 'mods', type: 'str' },
    { key: 'acc', label: 'acc %', type: 'num' },
    ...state.algoIds.map((id) => ({ key: `pp:${id}`, label: `pp ${id}`, type: 'num' })),
    { key: 'delta', label: `Δ ${state.focusId} − ${state.baseId}`, type: 'num' },
  ];
}

function renderTable() {
  const cols = columns();
  $('#score-table thead').innerHTML = `<tr>${cols.map((c) => {
    const aria = state.sort.key !== c.key ? 'none' : state.sort.dir === 1 ? 'ascending' : 'descending';
    return `<th class="sortable ${c.type === 'num' ? 'num' : ''}" data-key="${esc(c.key)}" data-type="${c.type}"`
      + ` aria-sort="${aria}" title="${COLS_HINT}">${esc(c.label)}</th>`;
  }).join('')}</tr>`;

  const rows = filteredSorted(), slice = rows.slice(0, state.shown);
  $('#score-table tbody').innerHTML = slice.length ? slice.map(rowHtml).join('')
    : `<tr><td colspan="${cols.length}" class="empty">No score matches the current filters.</td></tr>`;
  $('#score-count').textContent = `${rows.length} of ${user()?.scores.length ?? 0} scores shown`;
  const left = rows.length - state.shown;
  $('#show-more').hidden = left <= 0;
  $('#show-more').textContent = `show more (${Math.min(PAGE_SIZE, left)} of ${left} remaining)`;
}

function rowHtml(s) {
  const label = `${esc(s.artist)} – ${esc(s.title)}`;
  const map = s.bid == null ? label
    : `<a href="https://osu.ppy.sh/beats/${encodeURIComponent(s.bid)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  const d = deltaOf(s), base = s.pp[state.baseId];
  return `<tr data-idx="${s.idx}"><td class="map">${map} <span class="ver">[${esc(s.version || '?')}]</span>`
    + `${s.bid == null ? '' : `<br><span class="bid">b${esc(s.bid)}</span>`}</td>`
    + `<td class="num">${s.keys == null ? '–' : esc(s.keys) + 'K'}</td><td class="num">${fmt(s.od, 1)}</td>`
    + `<td>${esc(s.modsLabel)}</td><td class="num">${fmt(s.acc, 2)}</td>`
    + state.algoIds.map((id) => `<td class="num">${fmt(s.pp[id] ?? null, 1)}</td>`).join('')
    + `<td class="num ${dirClass(d)}" title="${esc(signedPct(d != null && base ? d / base : null))}">`
    + `${signed(d, 1)}</td></tr>`;
}

function renderDisagreement() {
  const rows = filteredSorted().map((s) => ({ s, sp: spreadOf(s.pp) }))
    .filter((x) => x.sp && x.sp.rel != null)
    .sort((a, b) => b.sp.rel - a.sp.rel || b.sp.abs - a.sp.abs || (a.s.idx - b.s.idx))
    .slice(0, TOP_DISAGREE);
  if (!rows.length) {
    $('#disagree').innerHTML = '<p class="empty">Not enough algorithms on these scores to measure disagreement.</p>';
    return;
  }
  $('#disagree').innerHTML = rows.map((x, i) => {
    const s = x.s, sp = x.sp;
    const pps = state.algoIds.map((id) => `<span class="dis-pp" title="${esc(id)}">${fmt(s.pp[id] ?? null, 1)}</span>`).join('');
    return `<div class="dis-row" data-idx="${s.idx}"><div class="dis-row-main">`
      + `<span class="dis-rank">${i + 1}</span>`
      + `<span class="dis-map">${esc(s.artist)} – ${esc(s.title)} <span class="ver">[${esc(s.version || '?')}]</span>`
      + ` <span class="hint">${s.keys == null ? '' : esc(s.keys) + 'K · '}${esc(s.modsLabel)}</span></span>`
      + pps
      + `<span class="dis-spread">${signedPct(sp.rel)}</span>`
      + `<span class="dis-pp dis-extra">${fmt(sp.max / (sp.min || 1), 2)}×</span>`
      + `</div>${state.open.has(s.idx) ? detailHtml(s, sp) : ''}</div>`;
  }).join('');
}

/** Expanded disagreement row: every algorithm's deviation from the score mean + `detail`. */
function detailHtml(s, sp) {
  const mean = sp ? sp.mean : null;
  const perAlgo = state.algoIds.map((id) => {
    const v = s.pp[id], dev = v != null && mean ? v - mean : null;
    return `<dt>${esc(id)} vs mean</dt><dd class="${dirClass(dev)}">${signed(dev, 1)}`
      + `<span class="hint"> (${signedPct(dev != null && mean ? dev / mean : null)})</span></dd>`;
  }).join('');
  // `counts` is [320, 300, 200, 100, 50, miss] in the engine's output.
  const counts = s.counts.length
    ? `<dt>counts</dt><dd>${s.counts.map(esc).join(' / ')}<span class="hint"> 320/300/200/100/50/miss</span></dd>` : '';
  const det = Object.entries(s.detail);
  return `<div class="dis-detail"><div class="detail-grid" style="padding:7px 8px">`
    + `<dl><dt>keys / OD / mods</dt><dd>${s.keys == null ? '–' : esc(s.keys) + 'K'} / ${fmt(s.od, 1)} / ${esc(s.modsLabel)}</dd>`
    + `<dt>accuracy</dt><dd>${fmt(s.acc, 2)}%</dd>${counts}`
    + `<dt>spread</dt><dd>${signed(sp.abs, 1)} pp = ${signedPct(sp.rel)} (max/min ${fmt(sp.max / (sp.min || 1), 2)}×)</dd>`
    + `<dt>Δ ${esc(state.focusId)} − ${esc(state.baseId)}</dt><dd>${signed(deltaOf(s), 1)}</dd></dl>`
    + `<dl><dt>algorithm pp</dt><dd>${state.algoIds.map((id) => `${esc(id)} ${fmt(s.pp[id] ?? null, 1)}`).join('  ')}</dd>`
    + `${perAlgo}</dl>`
    + `<dl>${det.length ? det.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(fmtDetail(v))}</dd>`).join('')
      : '<dt>detail</dt><dd>–</dd>'}</dl></div></div>`;
}

function renderAll() {
  const ok = state.algoIds.length > 0 && !!user();
  renderLegend();
  $('#panel-summary').hidden = !state.source;
  $('#panel-scores').hidden = !ok;
  $('#panel-disagree').hidden = !ok;
  renderSummary();
  if (!ok) {
    // Drop anything left over from a previously loaded dataset.
    $('#score-table thead').innerHTML = ''; $('#score-table tbody').innerHTML = '';
    $('#disagree').innerHTML = ''; $('#score-count').textContent = ''; $('#show-more').hidden = true;
    return;
  }
  renderTable();
  renderDisagreement();
}
/* --------------------------------- loading -------------------------------- */

function applyData(raw, origin) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('top level is not a JSON object');
  const rawUsers = (Array.isArray(raw.users) ? raw.users : []).filter((u) => u && typeof u === 'object');
  state.source = Object.assign({}, raw, { origin: origin.kind, filename: origin.filename });
  state.loadError = null;
  state.algoIds = resolveAlgorithms(raw, rawUsers);
  state.users = rawUsers.map((u) => normalizeUser(u, state.algoIds));
  // bancho is the reference when present; otherwise the first algorithm in order.
  state.baseId = state.algoIds.includes('bancho') ? 'bancho' : state.algoIds[0] ?? null;
  state.focusId = state.algoIds.includes('reimagined') ? 'reimagined' : state.algoIds[state.algoIds.length - 1] ?? null;
  state.userIndex = 0;
  state.shown = PAGE_SIZE;
  state.open.clear();
  state.sort = state.focusId ? { key: `pp:${state.focusId}`, dir: -1 } : { key: 'map', dir: 1 };
  $('#loader').hidden = true;
  $('#loader-err').hidden = true;
  $('#loader-err').textContent = '';
  renderMeta(origin.kind === 'file' ? `source: ${origin.filename || 'local file'}` : `source: ${DATA_URL}`);
  renderNotice();
  renderUsers();
  renderAll();
}

/**
 * Empty state: there is no usable dataset. Say why, point at the CLI, and keep
 * the drag-and-drop / file-input loader available — that path is a feature, not
 * a failure: over file:// it is the only way to load anything.
 */
function showEmpty(reason, blocked) {
  state.source = null; state.algoIds = []; state.users = []; state.loadError = null;
  $('#panel-summary').hidden = true; $('#panel-scores').hidden = true; $('#panel-disagree').hidden = true;
  $('#loader').hidden = false;
  $('#loader-err').hidden = true; $('#loader-err').textContent = '';
  $('#loader-why').textContent = reason;
  $('#loader-hint').innerHTML = blocked
    ? 'This page was opened straight from disk (<code>file://</code>), where browsers refuse to read '
      + 'sibling files. Serve the directory over HTTP, or load a dataset below.'
    : 'Generate <code>web/data/results.json</code> with the CLI above, then reload this page — '
      + 'or load an existing <code>results.json</code> below.';
  $('#meta').textContent = 'no dataset loaded';
  renderLegend();
}

/** Fetch the dataset; on any failure fall through to the empty state. */
async function boot() {
  const fromDisk = location.protocol === 'file:';
  const fail = (what, err) => showEmpty(`${DATA_URL} ${what}: ${err?.message ?? err}.`, fromDisk);
  let res;
  // A TypeError ("Failed to fetch") is what file:// and offline pages produce.
  try { res = await fetch(DATA_URL, { cache: 'no-store' }); } catch (err) { return fail('could not be fetched', err); }
  if (!res.ok) return showEmpty(`${DATA_URL} is not available: HTTP ${res.status} ${res.statusText}.`, fromDisk);
  let text;
  try { text = await res.text(); } catch (err) { return fail('could not be read', err); }
  try { applyData(JSON.parse(text), { kind: 'live' }); } catch (err) { return fail('is not usable', err); }
}
/* ---------------------------------- events -------------------------------- */

function loadText(text, filename) {
  try {
    applyData(JSON.parse(text), { kind: 'file', filename });
  } catch (err) {
    const msg = `${filename}: ${err.message}`;
    if (state.source) {                       // keep the current dataset, report the failure
      state.loadError = msg;
      renderNotice();
    } else {
      showEmpty(msg, location.protocol === 'file:');
      $('#loader-err').hidden = false;
      $('#loader-err').textContent = msg;
    }
  }
}

function readFile(file) {
  if (!file) return;
  const r = new FileReader();
  r.onload = () => loadText(String(r.result), file.name);
  r.onerror = () => loadText('', file.name);  // surfaces as a JSON parse error
  r.readAsText(file);
}

/** Sorting: first click on a numeric column sorts descending, text ascending. */
$('#score-table thead').addEventListener('click', (ev) => {
  const th = ev.target.closest('th[data-key]');
  if (!th) return;
  const key = th.dataset.key;
  state.sort = state.sort.key === key ? { key, dir: -state.sort.dir }
    : { key, dir: th.dataset.type === 'num' ? -1 : 1 };
  state.shown = Math.max(state.shown, PAGE_SIZE);
  renderTable();
});

// Row click scrolls to that score in the disagreement view, when it is listed there.
$('#score-table tbody').addEventListener('click', (ev) => {
  if (ev.target.closest('a')) return;
  const tr = ev.target.closest('tr[data-idx]');
  const card = tr && $(`.dis-row[data-idx="${tr.dataset.idx}"]`);
  if (card) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
});

$('#disagree').addEventListener('click', (ev) => {
  const row = ev.target.closest('.dis-row');
  if (!row) return;
  const idx = Number(row.dataset.idx);
  if (state.open.has(idx)) state.open.delete(idx); else state.open.add(idx);
  renderDisagreement();
});

$('#q').addEventListener('input', (ev) => {
  state.q = ev.target.value; state.shown = PAGE_SIZE; renderTable(); renderDisagreement();
});

$('.filters').addEventListener('click', (ev) => {
  const chip = ev.target.closest('.chip[data-f]');
  if (!chip) return;
  state.f[chip.dataset.f] = chip.dataset.v;
  for (const sib of chip.parentElement.children) sib.classList.toggle('is-on', sib === chip);
  state.shown = PAGE_SIZE;
  renderTable();
  renderDisagreement();
});

$('#f-reset').addEventListener('click', () => {
  state.q = ''; state.f = { keys: 'all', mods: 'all', ln: 'all' }; state.shown = PAGE_SIZE;
  $('#q').value = '';
  document.querySelectorAll('.chips .chip').forEach((c) => c.classList.toggle('is-on', c.dataset.v === 'all'));
  renderTable();
  renderDisagreement();
});

$('#show-more').addEventListener('click', () => { state.shown += PAGE_SIZE; renderTable(); });

$('#user-select').addEventListener('change', (ev) => {
  state.userIndex = Number(ev.target.value) || 0;
  state.shown = PAGE_SIZE; state.open.clear();
  renderAll();
});

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
