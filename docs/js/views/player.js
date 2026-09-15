/* ===========================================================================
 * views/player.js — #/player/{uid}, one bp list in full.
 *
 * The totals come from the index and stay valid even when the shard does not load; everything else comes from that one shard, which this view fetches when it is entered and never for any other player.
 * The score table has two layouts. COMPACT, the default, is the owner's column order and nothing else: Rank A, Rank B, Shift, Beatmap, one star column per star the shard publishes, Keys, OD, LN %, PP A, PP B, Δ (B−A), Δ %, Acc %, the six judgement counts, Mods. GROUPED puts every algorithm's pp side by side and appends the detail columns, which is the wider table the compact layout exists to replace.
 * The analysis panels below it all come from the same shard and no other field: how the weighted total builds up, what a star pays under A, the top ten under each side, the mod families and their share of the total, and the spread of the Reimagined internals.
 * The layers panel, the build-up curve, the top ten, the mod families and the internals are computed over the whole bp list and deliberately ignore the search box; the score table, the disagreement list, the scatter and the pp-per-star chart all follow it.
 * =========================================================================== */

import { $, $$ } from '../dom.js';
import { cellNum, cellSigned, clamp, csvCell, csvNum, debounce, dirClass, downloadCsv, esc, EXTERNAL, flash, fmt, fmtG, idle, link, median, pct, pctPlain, quantile, signed } from '../format.js';
import {
  CSV_ORDER, LN_BUCKETS, LN_HB, LN_RC, SHIFT_BIG, SHIFT_MID, algoLabel, compareRows, detailGrid, diffOf, expandButton, headHtml,
  layerFamilies, loadShard, modFamilies, nextSort, pageArg, pageScrollIntoView, pageTarget, pageWindow, patchSort, ppA, ppB, player,
  primaryStar, registerView, relOf, resetPaging, scoreRank, setSort, shiftClass, shiftOf, spreadOf, starColumns, starValue, state,
  syncPager, totalFor, writeHash,
} from '../core.js';
import { matchesScore, parseQuery, scoreFields, unsatisfiable } from '../search.js';

const el = {
  title: $('#player-title'),
  sub: $('#player-sub'),
  totalTable: $('#total-table'),
  abLine: $('#ab-line'),
  totalNote: $('#total-note'),
  panelError: $('#panel-shard-error'),
  errTitle: $('#shard-error-title'),
  errText: $('#shard-error-text'),
  errHint: $('#shard-error-hint'),
  retry: $('#shard-retry'),
  panelScores: $('#panel-scores'),
  panelCumulative: $('#panel-cumulative'),
  panelEfficiency: $('#panel-efficiency'),
  panelTop: $('#panel-top'),
  panelMod: $('#panel-modfamily'),
  panelInternals: $('#panel-internals'),
  panelLayers: $('#panel-layers'),
  panelDisagree: $('#panel-disagree'),
  q: $('#scores-q'),
  reset: $('#scores-reset'),
  exportBtn: $('#export-csv'),
  layoutBox: $('#layout-toggle'),
  count: $('#score-count'),
  filter: $('#scores-filter'),
  searchState: $('#search-state'),
  searchWarn: $('#search-warn'),
  table: $('#score-table'),
  pager: $('#scores-pager'),
  pageInfo: $('#scores-page-info'),
  cumulative: $('#cumulative'),
  cumulativeNote: $('#cumulative-note'),
  efficiency: $('#efficiency'),
  efficiencyNote: $('#efficiency-note'),
  topTables: $('#top-tables'),
  topNote: $('#top-note'),
  modTable: $('#modfamily-table'),
  modNote: $('#modfamily-note'),
  internalsTable: $('#internals-table'),
  internalsNote: $('#internals-note'),
  layerTable: $('#layer-table'),
  layerNote: $('#layer-note'),
  disagree: $('#disagree'),
  scatter: $('#scatter'),
  scatterNote: $('#scatter-note'),
};

const COUNT_LABELS = ['320', '300', '200', '100', '50', 'miss'];
const COUNT_TITLE = 'judgement counts 320 / 300 / 200 / 100 / 50 / miss';
/** How many scores the two top-ten tables list. */
const TOP_N = 10;
/** How long the score box waits for the typing to stop before it filters. */
const FILTER_DELAY = 220;

/** Default sort: the rank under A ascending, so the best scores under the baseline come first. */
const defaultSort = () => ({ key: state.A ? `rank:${state.A}` : 'map', dir: 1 });

/* ------------------------------ score columns ----------------------------- */

/** The whole column set of one layout. Every descriptor carries its header metadata and its cell renderer together, so they cannot drift apart. */
function scoreColumns(layout) {
  const A = algoLabel(state.A), B = algoLabel(state.B);
  const stars = starColumns();
  const columns = [
    { key: null, cls: 'c-toggle', cell: (s) => expandButton(s) },

    { key: `rank:${state.A}`, label: 'Rank A', type: 'num', cls: 'c-rank',
      title: `Position of this score in the whole bp list ordered by A (${A}), 1 = best`,
      cell: (s) => `<td class="num rank-cell">${scoreRank(s, state.A) ?? '–'}</td>` },
    { key: `rank:${state.B}`, label: 'Rank B', type: 'num', cls: 'c-rank',
      title: `Position of this score ordered by B (${B}), 1 = best`,
      cell: (s) => `<td class="num rank-cell">${scoreRank(s, state.B) ?? '–'}</td>` },
    { key: 'shift', label: 'Shift', type: 'num', cls: 'c-shift',
      title: `rank B − rank A; positive means the score drops under B. Highlighted from |shift| ≥ ${SHIFT_MID}, strong from ≥ ${SHIFT_BIG}`,
      cell: (s) => {
        const sh = shiftOf(s);
        return `<td class="num shift ${shiftClass(sh)} ${dirClass(sh == null ? null : -sh)}">${sh == null ? '–' : (sh > 0 ? '+' : '') + sh}</td>`;
      } },

    { key: 'map', label: 'Beatmap', type: 'str', cls: 'c-map',
      title: 'artist – title, with the difficulty and the mapper underneath; the link needs a beatmap set id, so a score without one renders as text',
      cell: (s) => mapCell(s) },

    ...stars.map((st) => ({
      key: st.key, label: `★ ${st.label}`, type: 'num', cls: 'c-star',
      title: `${st.label} star rating of the map with this score's mods`,
      cell: (s) => cellNum(starValue(s, st.id), 3),
    })),

    { key: 'keys', label: 'Keys', type: 'num', cls: 'c-keys', title: 'key mode',
      cell: (s) => `<td class="num">${s.keys == null ? '–' : esc(s.keys) + 'K'}</td>` },
    { key: 'od', label: 'OD', type: 'num', cls: 'c-od', title: 'overall difficulty of the map',
      cell: (s) => cellNum(s.od, 1) },
    { key: 'lnPct', label: 'LN %', type: 'num', cls: 'c-ln', title: 'share of objects that are long notes, in percent — the layer cut-offs are 10% and 90%',
      cell: (s) => cellNum(s.ln == null ? null : s.ln * 100, 1) },
  ];

  if (layout === 'grouped') {
    for (const id of state.algoIds) {
      columns.push({
        key: `pp:${id}`, label: `PP ${algoLabel(id)}`, type: 'num', cls: 'c-pp blk',
        title: `${algoLabel(id)} pp${id === state.A ? ' — A, the baseline' : id === state.B ? ' — B, the compared side' : ''}`,
        cell: (s) => cellNum(s.pp[id], 2),
      });
    }
  } else {
    columns.push(
      { key: `pp:${state.A}`, label: 'PP A', type: 'num', cls: 'c-pp blk', title: `${A} pp — A, the baseline`, cell: (s) => cellNum(ppA(s), 2) },
      { key: `pp:${state.B}`, label: 'PP B', type: 'num', cls: 'c-pp', title: `${B} pp — B, the compared side`, cell: (s) => cellNum(ppB(s), 2) },
    );
  }

  columns.push(
    { key: 'diff', label: 'Δ (B−A)', type: 'num', cls: 'c-delta', title: `absolute pp difference ${B} − ${A}`, cell: (s) => cellSigned(diffOf(s), 2) },
    { key: 'rel', label: 'Δ %', type: 'num', cls: 'c-rel', title: `relative difference ${B} / ${A} − 1`, cell: (s) => `<td class="num ${dirClass(relOf(s))}">${pct(relOf(s), 2)}</td>` },
    { key: 'acc', label: 'Acc %', type: 'num', cls: 'c-acc', title: 'accuracy in percent', cell: (s) => cellNum(s.acc, 2) },
    ...COUNT_LABELS.map((label, i) => ({
      key: `count${i}`, label, type: 'num', cls: 'c-count', title: COUNT_TITLE,
      cell: (s) => cellNum(s.counts[i], 0),
    })),
    { key: 'mods', label: 'Mods', type: 'str', cls: 'c-mods', title: 'mod acronym as the engine reports it', cell: (s) => `<td>${esc(s.modsLabel)}</td>` },
  );

  if (layout === 'grouped') {
    const used = new Set(stars.map((st) => st.id));
    const extraStars = Array.from(state.starKeys).filter((x) => !used.has(x));
    for (const x of extraStars) {
      columns.push({
        key: `star:${x}`, label: `★ ${x}`, type: 'num', cls: 'c-star blk', title: `star_${x} as the shard publishes it`,
        cell: (s) => cellNum(starValue(s, x), 3),
      });
    }
    columns.push(
      { key: 'scid', label: 'Score id', type: 'num', cls: 'c-sid blk', title: 'osu! score id', cell: (s) => `<td class="num">${s.scid == null ? '–' : esc(s.scid)}</td>` },
      { key: 'lShare', label: 'L share', type: 'num', cls: 'c-detail', title: 'Reimagined internals: l_share, w, coord_mod, eff_star, acc_factor and nf_factor', cell: (s) => cellNum(s.lShare, 4) },
      { key: 'w', label: 'w', type: 'num', cls: 'c-detail', title: 'LN weight', cell: (s) => cellNum(s.w, 4) },
      { key: 'coordMod', label: 'coord', type: 'num', cls: 'c-detail', title: 'coordination modifier', cell: (s) => cellNum(s.coordMod, 4) },
      { key: 'effStar', label: 'eff ★', type: 'num', cls: 'c-detail', title: 'effective star rating of the R + L channels', cell: (s) => cellNum(s.effStar, 3) },
      { key: 'accFactor', label: 'acc f.', type: 'num', cls: 'c-detail', title: 'accuracy factor', cell: (s) => cellNum(s.accFactor, 4) },
      { key: 'nfFactor', label: 'nf f.', type: 'num', cls: 'c-detail', title: 'no-fail factor', cell: (s) => cellNum(s.nfFactor, 4) },
    );
  }
  return columns;
}

/** The map cell: the song title link, the difficulty and the mapper underneath, the ids in the tooltip. The difficulty is printed once — the title never re-embeds it. */
function mapCell(s) {
  const title = s.version && s.title.endsWith(`[${s.version}]`) ? s.title.slice(0, s.title.length - s.version.length - 2).trim() : s.title;
  const url = s.bid != null && s.sid != null ? `https://osu.ppy.sh/beatmapsets/${s.sid}#mania/${s.bid}` : null;
  const sub = [s.version ? `[${s.version}]` : '[no difficulty name]', s.mapper ? `mapped by ${esc(s.mapper)}` : 'mapper not in dataset'].join(' · ');
  const ids = `b${s.bid ?? '?'} · s${s.sid ?? '?'}`;
  return `<td class="map" title="${esc(`${s.artist} – ${s.title}`)} · ${esc(ids)}">`
    + link(url, esc(`${s.artist} – ${title}`), ` class="ttl"${EXTERNAL}`)
    + `<span class="sub">${sub}</span></td>`;
}

function sortValue(s, key) {
  switch (key) {
    case 'map': return `${s.artist} ${s.title} ${s.version}`.toLowerCase();
    case 'mods': return s.modsLabel.toLowerCase();
    case 'shift': return shiftOf(s);
    case 'diff': return diffOf(s);
    case 'rel': return relOf(s);
    case 'lnPct': return s.ln == null ? null : s.ln * 100;
    case 'acc': return s.acc;
    case 'keys': return s.keys;
    case 'od': return s.od;
    case 'scid': return s.scid;
    case 'lShare': return s.lShare;
    case 'w': return s.w;
    case 'coordMod': return s.coordMod;
    case 'effStar': return s.effStar;
    case 'accFactor': return s.accFactor;
    case 'nfFactor': return s.nfFactor;
    default: break;
  }
  if (key.startsWith('count')) return s.counts[Number(key.slice(5))] ?? null;
  if (key.startsWith('rank:')) return scoreRank(s, key.slice(5));
  if (key.startsWith('pp:')) return s.pp[key.slice(3)] ?? null;
  if (key.startsWith('star:')) return starValue(s, key.slice(5));
  return null;
}

/** Search, then sort, memoised on the inputs that define the result. Ranks are unaffected by both: they always cover the whole bp list. */
let cache = { key: '', rows: [], parsed: [] };
function selected() {
  const view = state.view.player || {};
  const sort = state.sort.player || defaultSort();
  const key = [view.q ?? '', sort.key, sort.dir, state.A, state.B, state.dataVersion].join('\u0001');
  if (cache.key === key) return cache;
  const parsed = parseQuery(view.q ?? '', scoreFields());
  const rows = parsed.length ? state.scores.filter((s) => matchesScore(parsed, s)) : state.scores.slice();
  rows.sort((a, b) => compareRows(a, b, sort.key, sort.dir, sortValue, (s) => `${s.artist} ${s.title} ${s.version}`.toLowerCase(), (s) => s.i));
  cache = { key, rows, parsed };
  return cache;
}

/* --------------------------------- panels -------------------------------- */

function renderHead() {
  const u = player();
  const uid = u?.uid ?? state.uid;
  el.title.innerHTML = u ? `${esc(u.username)}${uid == null ? '' : ` <span class="hint">#${esc(uid)}</span>`}` : 'Player';
  const bits = [];
  if (uid != null) bits.push(`<a href="https://osu.ppy.sh/users/${esc(uid)}"${EXTERNAL}>osu.ppy.sh/users/${esc(uid)}</a>`);
  if (u?.fixture) bits.push(`fixture <code>${esc(u.fixture)}</code>`);
  if (u) bits.push(`${esc(u.scoreCount)} scores in the dataset`);
  if (state.shard === 'loading') bits.push('loading scores…');
  if (state.shard === 'ready') bits.push(`${state.scores.length} score${state.scores.length === 1 ? '' : 's'} loaded`);
  el.sub.innerHTML = bits.join(' · ');
}

function renderTotals() {
  const u = player(), head = $('thead', el.totalTable), body = $('tbody', el.totalTable);
  if (!state.algoIds.length || !u) {
    head.innerHTML = '';
    body.innerHTML = '<tr><td class="empty">This dataset carries no algorithm pp values.</td></tr>';
    el.abLine.textContent = '';
    el.totalNote.textContent = '';
    return;
  }
  head.innerHTML = `<tr><th scope="col">Algorithm</th><th scope="col" class="num">Weighted total pp</th><th scope="col" class="num">Δ vs ${esc(algoLabel(state.A))}</th><th scope="col" class="num">Δ %</th></tr>`;
  const base = totalFor(state.A).value;
  const rows = state.algoIds.map((id) => {
    const t = totalFor(id);
    const d = t.value != null && base != null ? t.value - base : null;
    return { id, label: algoLabel(id), total: t.value, derived: t.derived, d, rel: d != null && base ? d / base : null };
  });
  body.innerHTML = rows.map((r) => {
    const role = [r.id === state.A ? 'A' : null, r.id === state.B ? 'B' : null].filter(Boolean).join(' / ');
    return `<tr class="${r.id === state.A ? 'is-baseline' : ''}">`
      + `<td><span class="alg-name">${esc(r.label)}${role ? `<span class="badge badge-ab">${esc(role)}</span>` : ''}</span></td>`
      + `<td class="num">${fmtG(r.total)}</td>`
      + `<td class="num ${dirClass(r.d)}">${r.id === state.A ? '–' : signed(r.d)}</td>`
      + `<td class="num ${dirClass(r.d)}">${r.id === state.A ? '–' : pct(r.rel)}</td></tr>`;
  }).join('');
  const tA = base, tB = totalFor(state.B).value;
  const dAB = tA != null && tB != null ? tB - tA : null;
  el.abLine.innerHTML = dAB == null
    ? '<span class="role">A / B</span> — one of the two algorithms carries no total for this player.'
    : `<span class="role">A</span> ${esc(algoLabel(state.A))} ${fmtG(tA)} <span class="role">→ B</span> ${esc(algoLabel(state.B))} ${fmtG(tB)} <span class="role">· diff (B − A)</span> <span class="${dirClass(dAB)}">${signed(dAB)}</span> <span class="role">· relative (B / A − 1)</span> <span class="${dirClass(dAB)}">${pct(tA ? dAB / tA : null)}</span> <span class="role">· ratio</span> ${fmt(tA ? tB / tA : null, 4)}`;
  const notes = ['Each total is a 0.95-decay sum over that algorithm\'s own ordering of this player\'s scores.'];
  if (rows.some((r) => r.derived)) notes.push('This file carries no total_pp, so the totals are derived from the shard.');
  if (state.algoIds.length < 2) notes.push('Only one algorithm carries numbers in this dataset.');
  el.totalNote.textContent = notes.join(' ');
}

/** The shard error panel and the empty bp list. */
function renderShardState() {
  const u = player(), broken = state.shard === 'error';
  const blank = state.shard === 'ready' && !state.scores.length;
  el.panelError.hidden = !(broken || blank);
  if (el.panelError.hidden) return;
  el.errTitle.textContent = broken ? 'Player data unavailable' : 'This player has no scores';
  el.errText.textContent = broken
    ? `Could not read the scores of ${u?.username ?? 'this player'} — ${state.shardError}`
    : `${u?.username ?? 'This player'} has no scores in this dataset (the index lists ${u?.scoreCount ?? 0}), so there is nothing to rank, summarise or export.`;
  el.errHint.textContent = broken
    ? 'The weighted totals above come from data/index.json and stay valid; everything that needs the individual scores does not. Retrying refetches just this player.'
    : 'That is a normal state for a player the engine could not harvest, not an error.';
  el.retry.hidden = !broken;
}

function renderScores() {
  const layout = state.view.player?.layout === 'grouped' ? 'grouped' : 'compact';
  const columns = scoreColumns(layout);
  $('thead', el.table).innerHTML = headHtml(columns);
  const { rows, parsed } = selected();
  const w = pageWindow(state.view.player, rows.length);
  const slice = rows.slice(w.start, w.end);
  $('tbody', el.table).innerHTML = slice.length
    ? slice.map((s) => rowHtml(s, columns)).join('')
    : `<tr><td colspan="${columns.length}" class="empty">${state.scores.length ? 'No score matches the current search.' : 'This bp list has no scores in this dataset.'}</td></tr>`;
  patchSort(el.table, state.sort.player || defaultSort(), columns);

  el.pager.hidden = !rows.length;
  syncPager(el.pager, el.pageInfo, w);
  el.filter.hidden = true;   // the results the indicator was waiting for are on screen
  el.count.textContent = `${slice.length} of ${rows.length} score${rows.length === 1 ? '' : 's'} shown`;
  el.exportBtn.disabled = !rows.length;

  el.searchState.textContent = parsed.length ? `${rows.length} of ${state.scores.length} scores match · ${parsed.length} term${parsed.length === 1 ? '' : 's'}` : '';
  const bad = unsatisfiable(parsed);
  el.searchWarn.hidden = !bad.length;
  el.searchWarn.textContent = bad.length ? `${bad.join(', ')}: this dataset carries no map creator column, so this term matches nothing.` : '';
  for (const b of $$('button[data-layout]', el.layoutBox)) b.setAttribute('aria-pressed', String(b.dataset.layout === layout));
}

/** One pager button. The target is clamped to the pages the current filter actually has, and the page number goes into the hash with the rest of the view state. */
function goPage(kind) {
  const view = state.view.player;
  if (!view) return;
  const w = pageWindow(view, selected().rows.length);
  const target = pageTarget(kind, w);
  if (target === w.page || target < 1 || target > w.pages) return;
  view.page = target;
  writeHash(true);
  renderScores();
  pageScrollIntoView(el.table);
}

function rowHtml(s, columns) {
  const row = `<tr data-i="${s.i}">${columns.map((c) => c.cell(s)).join('')}</tr>`;
  if (!state.open.has(s.i)) return row;
  return row + `<tr class="detail"><td colspan="${columns.length}">${detailGrid(s)}</td></tr>`;
}

/** Layers aggregate the whole bp list, deliberately ignoring the search: filtering to 4K would empty the 7K row and the summary would stop describing the player. */
function renderLayers() {
  const list = state.scores;
  if (!list.length) {
    el.layerTable.innerHTML = '';
    el.layerNote.textContent = '';
    return;
  }
  const stat = (test) => {
    const inLayer = list.filter(test);
    const rels = inLayer.map(relOf).filter((v) => v != null);
    return { n: inLayer.length, nBoth: rels.length, medRel: median(rels), medPp: median(inLayer.map(ppA)) };
  };
  const cells = (name, grade, st) => `<td class="layer-name">${esc(name)}</td>`
    + `<td class="hint">${esc(grade)}</td>`
    + `<td class="num" title="${st.n} score${st.n === 1 ? '' : 's'}, ${st.nBoth} priced by both A and B">${st.n}</td>`
    + `<td class="num ${dirClass(st.medRel)}">${pct(st.medRel, 2)}</td>`
    + `<td class="num">${fmt(st.medPp, 2)}</td>`;
  const body = layerFamilies(list).map((fam) => `<tr class="layer-group"><th colspan="5" scope="colgroup">${esc(fam.title)}</th></tr>`
    + fam.rows.map((r) => `<tr>${cells(r.name, r.grade, stat(r.test))}</tr>`).join('')).join('');
  el.layerTable.innerHTML = '<table class="grid layers"><caption class="sr-only">Layer summary over the whole bp list</caption>'
    + '<thead><tr><th scope="col">Layer</th><th scope="col">Definition</th><th scope="col" class="num">n</th><th scope="col" class="num">Median Δ (B vs A)</th><th scope="col" class="num">Median pp (A)</th></tr></thead>'
    + `<tbody>${body}<tr class="layer-total">${cells('All scores', 'every score of this bp list', stat(() => true))}</tr></tbody></table>`;
  el.layerNote.textContent = 'Rows list the layers that actually occur in this bp list — no empty buckets — and cover every score of it. The search above deliberately does not apply here: filtering to one key mode would empty the others. Δ is B / A − 1 per score and the median of that column is shown; median pp is the median of the baseline algorithm\'s pp inside the layer. Only one category is assigned per score, so the rows inside a family add up to the list size. Rate-up is DT · NC and rate-down is HT · DC, matched as substrings of mods_parts.';
}

/* ------------------------ how the weighted total builds up --------------- */

/** The weighted total is a 0.95-decay sum over an algorithm's own order of the whole bp list, so the curve over its best N scores is that same sum truncated: its last point is the total the panel above prints, and where it flattens says how much of the total the top of the list already carries. */
function cumulativeCurve(id) {
  const vals = state.scores.map((s) => s.pp[id]).filter((v) => v != null).sort((a, b) => b - a);
  const pts = [0];
  let acc = 0;
  vals.forEach((v, i) => { acc += v * Math.pow(0.95, i); pts.push(acc); });
  return pts;
}

/** The smallest number of scores whose weighted sum already reaches that fraction of the total. */
function cumulativeReach(pts, frac) {
  const last = pts[pts.length - 1] ?? 0;
  const at = pts.findIndex((v) => v >= last * frac);
  return at < 0 ? pts.length - 1 : at;
}

function renderCumulative() {
  const curves = [];
  for (const id of [state.A, state.B]) {
    if (!id || curves.some((c) => c.id === id)) continue;
    const pts = cumulativeCurve(id);
    if (pts.length > 1) curves.push({ id, pts });
  }
  if (!curves.length) {
    el.cumulative.innerHTML = '<p class="empty">Not one score of this bp list carries a pp value, so there is no weighted total to build up.</p>';
    el.cumulativeNote.textContent = '';
    return;
  }
  const W = 640, H = 230, pad = { left: 70, right: 26, top: 18, bottom: 46 };
  const nMax = Math.max(...curves.map((c) => c.pts.length - 1));
  const yMax = Math.max(...curves.map((c) => c.pts[c.pts.length - 1]));
  const xAt = (n) => pad.left + (n / Math.max(1, nMax)) * (W - pad.left - pad.right);
  const yAt = (v) => H - pad.bottom - (v / (yMax || 1)) * (H - pad.top - pad.bottom);
  const series = curves.map((c) => {
    const isA = c.id === state.A;
    const end = c.pts[c.pts.length - 1];
    return `<polyline class="${isA ? 'line-a' : 'line-b'}" points="${c.pts.map((v, n) => `${xAt(n).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ')}"/>`
      + `<text class="series-label" x="${(xAt(c.pts.length - 1) - 6).toFixed(1)}" y="${(yAt(end) + (isA ? -8 : 15)).toFixed(1)}" text-anchor="end">${isA ? 'A' : 'B'} ${fmtG(end, 0)}</text>`;
  }).join('');
  const yTicks = [yMax, yMax / 2, 0].map((v) => `<line class="${v === 0 ? 'zero' : 'rule'}" x1="${pad.left}" x2="${W - pad.right}" y1="${yAt(v).toFixed(1)}" y2="${yAt(v).toFixed(1)}"/>`
    + `<text class="y-label" x="${pad.left - 6}" y="${(yAt(v) + 3.5).toFixed(1)}" text-anchor="end">${fmtG(v, 0)}</text>`).join('');
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => Math.round(t * nMax))
    .filter((n, i, arr) => arr.indexOf(n) === i)
    .map((n) => `<text x="${xAt(n).toFixed(1)}" y="${(H - pad.bottom + 15).toFixed(1)}" text-anchor="middle">${n}</text>`).join('');
  el.cumulative.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="the weighted total as a function of how many of the best scores are included, for ${esc(algoLabel(state.A))} and ${esc(algoLabel(state.B))}">`
    + yTicks + xTicks
    + `<line class="zero" x1="${pad.left}" x2="${pad.left}" y1="${pad.top}" y2="${(H - pad.bottom).toFixed(1)}"/>`
    + `<line class="zero" x1="${pad.left}" x2="${W - pad.right}" y1="${(H - pad.bottom).toFixed(1)}" y2="${(H - pad.bottom).toFixed(1)}"/>`
    + series
    + `<text class="axis-label" x="0" y="11">weighted total pp</text>`
    + `<text class="axis-label" x="${pad.left}" y="${H - 12}">scores included, best first — the whole bp list at the right edge</text></svg>`;
  const parts = curves.map((c) => `${c.id === state.A ? 'A' : 'B'} (${algoLabel(c.id)}): half of the total from the best ${cumulativeReach(c.pts, 0.5)} scores, ninety percent from the best ${cumulativeReach(c.pts, 0.9)}, out of ${c.pts.length - 1}`);
  el.cumulativeNote.textContent = `The curve is the same 0.95-decay sum the totals panel prints, cut off after each score, and it is computed over the whole bp list — the search above deliberately does not apply, because the weighted total does not either. ${parts.join('; ')}. A curve that flattens early means the total is carried by a handful of scores; a curve still climbing at the right edge means the bottom of the list is still paying.`;
}

/* ------------------------------ pp per star ------------------------------- */

/** Which `star_*` column the bare star rating of this shard reads, for the axis label. */
function primaryStarName() {
  const keys = Array.from(state.starKeys);
  const key = keys.includes('bancho') ? 'bancho' : keys[0];
  if (!key) return 'star rating';
  return state.algoIds.includes(key) ? `★ ${algoLabel(key)}` : `★ ${key}`;
}

/** What one star of rating actually pays on each score under A. The dot's radius grows with how far B and A disagree and a hollow dot means B pays more, which is the one thing a palette with a single accent can still encode. */
function renderEfficiency(rows) {
  const starName = primaryStarName();
  const pts = rows.map((s) => ({ s, x: primaryStar(s), pp: ppA(s), rel: relOf(s) }))
    .filter((p) => p.x != null && p.x > 0 && p.pp != null)
    .map((p) => ({ ...p, eff: p.pp / p.x }));
  const skipped = rows.length - pts.length;
  if (!pts.length) {
    el.efficiency.innerHTML = '<p class="empty">No score here is priced by A and carries a star rating.</p>';
    el.efficiencyNote.textContent = skipped ? `${skipped} score${skipped === 1 ? '' : 's'} skipped: no star rating, or no pp under ${algoLabel(state.A)}.` : '';
    return;
  }
  const W = 640, H = 300, pad = { left: 62, right: 20, top: 20, bottom: 54 };
  const xMin = Math.floor(Math.min(...pts.map((p) => p.x)) * 2) / 2;
  const xMax = Math.ceil(Math.max(...pts.map((p) => p.x)) * 2) / 2;
  const yMax = Math.max(...pts.map((p) => p.eff)) * 1.06;
  const xAt = (v) => pad.left + ((v - xMin) / Math.max(0.5, xMax - xMin)) * (W - pad.left - pad.right);
  const yAt = (v) => H - pad.bottom - (v / (yMax || 1)) * (H - pad.top - pad.bottom);
  const radius = (rel) => 3 + 5 * clamp(Math.abs(rel ?? 0) / 0.3, 0, 1);
  const med = median(pts.map((p) => p.eff));
  const yTicks = [yMax, yMax / 2, 0].map((v) => `<line class="${v === 0 ? 'zero' : 'rule'}" x1="${pad.left}" x2="${W - pad.right}" y1="${yAt(v).toFixed(1)}" y2="${yAt(v).toFixed(1)}"/>`
    + `<text class="y-label" x="${pad.left - 6}" y="${(yAt(v) + 3.5).toFixed(1)}" text-anchor="end">${fmt(v, v === 0 ? 0 : 1)}</text>`).join('');
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => xMin + t * (xMax - xMin))
    .map((v) => `<text x="${xAt(v).toFixed(1)}" y="${(H - pad.bottom + 15).toFixed(1)}" text-anchor="middle">${v.toFixed(1)}</text>`).join('');
  const dots = pts.map((p) => `<circle class="dot${p.rel != null && p.rel > 0 ? ' hollow' : ''}" cx="${xAt(p.x).toFixed(1)}" cy="${yAt(p.eff).toFixed(1)}" r="${radius(p.rel).toFixed(1)}">`
    + `<title>${esc(p.s.artist)} – ${esc(p.s.title)} [${esc(p.s.version || '?')}] · ★ ${fmt(p.x, 2)} · ${fmt(p.eff, 1)} pp per star under ${esc(algoLabel(state.A))} · ${esc(algoLabel(state.B))} vs ${esc(algoLabel(state.A))} ${pct(p.rel, 1)}</title></circle>`).join('');
  el.efficiency.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="pp per star under ${esc(algoLabel(state.A))} against the star rating, one dot per score">`
    + yTicks + xTicks
    + `<line class="median" x1="${pad.left}" x2="${W - pad.right}" y1="${yAt(med).toFixed(1)}" y2="${yAt(med).toFixed(1)}"/>`
    + `<text class="y-label" x="${W - pad.right}" y="${(yAt(med) - 5).toFixed(1)}" text-anchor="end">median ${fmt(med, 1)}</text>`
    + dots
    + `<text class="axis-label" x="0" y="11">pp per star under ${esc(algoLabel(state.A))}</text>`
    + `<text class="axis-label" x="${pad.left}" y="${H - 12}">${esc(starName)} of the map with this score's mods</text></svg>`;
  const better = pts.filter((p) => p.rel != null && p.rel > 0).length;
  const byEff = pts.slice().sort((a, b) => b.eff - a.eff);
  const hi = byEff[0], lo = byEff[byEff.length - 1];
  el.efficiencyNote.textContent = `${pts.length} of ${rows.length} score${rows.length === 1 ? '' : 's'} plotted — the search above applies here, unlike the layers panel. The y value is ${algoLabel(state.A)}'s pp divided by the map's ${starName} rating, so it answers what a unit of rating pays on this list; the horizontal rule is the median, ${fmt(med, 1)} pp per star. Dot radius grows with |B / A − 1| and a hollow dot is a score ${algoLabel(state.B)} pays more for (${better} of the plotted scores); the largest differences are the scores the two algorithms read most differently. The best-paying score is ${esc(hi.s.artist)} – ${esc(hi.s.title)} at ${fmt(hi.eff, 1)} pp per star and the worst is ${esc(lo.s.artist)} – ${esc(lo.s.title)} at ${fmt(lo.eff, 1)}.${skipped ? ` ${skipped} score${skipped === 1 ? '' : 's'} skipped: no star rating, or no pp under ${algoLabel(state.A)}.` : ''}`;
}

/* --------------------------- top ten per side ----------------------------- */

/** The scores holding the first ten ranks of one algorithm, in rank order. */
function topRows(id) {
  const ranks = state.scoreRanks[id];
  if (!ranks) return [];
  const out = [];
  for (let i = 0; i < state.scores.length; i += 1) if (ranks[i] != null && ranks[i] <= TOP_N) out.push({ s: state.scores[i], r: ranks[i] });
  return out.sort((a, b) => a.r - b.r);
}

/** The ten scores each side rates highest, with the rank those same scores hold under the other side — the rows a reader compares by hand when asking which algorithm is rewarding the top of a list. */
function renderTop() {
  const ids = [state.A, state.B].filter((id, i, arr) => id && arr.indexOf(id) === i);
  el.topTables.innerHTML = ids.map((id) => {
    const other = ids.find((x) => x !== id) ?? id;
    const role = id === state.A ? 'A' : 'B';
    const rows = topRows(id);
    const body = rows.length ? rows.map(({ s, r }, i) => {
      const ro = scoreRank(s, other);
      const shift = ro == null ? null : ro - r;
      const structure = [s.keys == null ? null : `${s.keys}K`, esc(s.modsLabel), s.ln == null ? null : `LN ${fmt(s.ln * 100, 0)}%`].filter(Boolean).join(' · ');
      return `<tr><td class="num hint">${i + 1}</td>`
        + `<td class="map-cell">${esc(s.artist)} – ${esc(s.title)} <span class="hint">[${esc(s.version || '?')}]</span></td>`
        + `<td class="hint">${structure}</td><td class="num">${fmt(s.pp[id], 1)}</td>`
        + `<td class="num rank-cell">${ro ?? '–'}</td>`
        + `<td class="num ${shift == null ? '' : dirClass(-shift)}">${shift == null ? '–' : shift === 0 ? '=' : signed(shift, 0)}</td></tr>`;
    }).join('') : `<tr><td colspan="6" class="empty">${esc(algoLabel(id))} priced none of these scores.</td></tr>`;
    return `<section><h4 class="eyebrow">${role} · ${esc(algoLabel(id))}</h4><div class="table-wrap">`
      + `<table class="grid top"><caption class="sr-only">The ten scores ${esc(algoLabel(id))} ranks highest, with the rank they hold under ${esc(algoLabel(other))}</caption>`
      + `<thead><tr><th scope="col" class="num">#</th><th scope="col">Beatmap</th><th scope="col">Structure</th><th scope="col" class="num">pp</th><th scope="col" class="num">${esc(other === id ? 'Rank' : `Rank ${algoLabel(other)}`)}</th><th scope="col" class="num">Shift</th></tr></thead>`
      + `<tbody>${body}</tbody></table></div></section>`;
  }).join('');
  el.topNote.textContent = `Each table lists the ten scores its own side ranks highest — the same ranking the Rank A and Rank B columns of the score table print — and the rank those scores hold under the other side. Shift is the other side's rank minus this side's, so a positive shift means a score drops as soon as the list is ordered by the other algorithm, and a negative one means it climbs. Both tables cover the whole bp list and ignore the search above, like the layer summary.`;
}

/* -------------------------- mod family breakdown -------------------------- */

/** One family's weighted contribution to one algorithm's total: the same 0.95-decay sum, restricted to the family, so the shares add up to the total the totals panel prints. */
function familyWeight(inFam, id) {
  return inFam.reduce((acc, s) => {
    const r = scoreRank(s, id), v = s.pp[id];
    return r == null || v == null ? acc : acc + v * Math.pow(0.95, r - 1);
  }, 0);
}

/** The mod families the layer table partitions by, with the share of the weighted total each of them carries — which is the number that says whether a list lives on its rate-up scores or on its no-mod ones. */
function renderModFamily() {
  const list = state.scores;
  const fams = modFamilies(list);
  if (!fams.length) {
    el.modTable.innerHTML = '<p class="empty">This bp list carries no scores to group by mod family.</p>';
    el.modNote.textContent = '';
    return;
  }
  const ids = [state.A, state.B].filter((id, i, arr) => id && arr.indexOf(id) === i);
  const totals = Object.fromEntries(ids.map((id) => [id, familyWeight(list, id)]));
  const rows = fams.map((f) => {
    const inFam = list.filter(f.test);
    const weights = Object.fromEntries(ids.map((id) => [id, familyWeight(inFam, id)]));
    return {
      f, inFam, weights,
      n: inFam.length,
      medStar: median(inFam.map(primaryStar)),
      medA: median(inFam.map((s) => s.pp[state.A])),
      medB: median(inFam.map((s) => s.pp[state.B])),
      medRel: median(inFam.map(relOf)),
    };
  });
  const share = (v, id) => (totals[id] > 0 && v != null ? pctPlain(v / totals[id], 1) : '–');
  el.modTable.innerHTML = '<table class="grid mods"><caption class="sr-only">Price and share of the weighted total per mod family</caption>'
    + `<thead><tr><th scope="col">Family</th><th scope="col">Definition</th><th scope="col" class="num">n</th><th scope="col" class="num">Share of list</th><th scope="col" class="num">Median ${esc(primaryStarName())}</th>`
    + `<th scope="col" class="num">Median pp ${esc(algoLabel(state.A))}</th><th scope="col" class="num">Median pp ${esc(algoLabel(state.B))}</th><th scope="col" class="num">Median Δ</th>`
    + ids.map((id) => `<th scope="col" class="num">${esc(algoLabel(id))} total</th>`).join('') + '</tr></thead><tbody>'
    + rows.map((r) => `<tr><td class="layer-name">${esc(r.f.name)}</td><td class="hint">${esc(r.f.grade)}</td>`
      + `<td class="num">${r.n}</td><td class="num">${pctPlain(r.n / list.length, 1)}</td><td class="num">${fmt(r.medStar, 2)}</td>`
      + `<td class="num">${fmt(r.medA, 1)}</td><td class="num">${fmt(r.medB, 1)}</td><td class="num ${dirClass(r.medRel)}">${pct(r.medRel, 1)}</td>`
      + ids.map((id) => `<td class="num">${share(r.weights[id], id)}</td>`).join('') + '</tr>').join('')
    + `<tr class="layer-total"><td class="layer-name">All scores</td><td class="hint">every score of this bp list</td><td class="num">${list.length}</td><td class="num">100.0%</td><td class="num">${fmt(median(list.map(primaryStar)), 2)}</td><td class="num">${fmt(median(list.map((s) => s.pp[state.A])), 1)}</td><td class="num">${fmt(median(list.map((s) => s.pp[state.B])), 1)}</td><td class="num ${dirClass(median(list.map(relOf)))}">${pct(median(list.map(relOf)), 1)}</td>`
    + ids.map((id) => `<td class="num">100.0%</td>`).join('') + '</tr></tbody></table>';
  el.modNote.textContent = `The families are the same ones the layer summary partitions by, so they add up: the n column sums to the list size and the two total columns sum to ${ids.map((id) => `the ${algoLabel(id)} weighted total the panel above prints`).join(' and ')}. A family's total is the 0.95-decay sum over the ranks that algorithm gives its scores, which is why the shares are comparable with each other and why a family with few scores can still carry a large share. Rate-up is DT · NC and rate-down is HT · DC, matched as substrings of mods_parts. The whole bp list is covered and the search above does not apply, as with the layer summary.`;
}

/* --------------------------- internal parameters -------------------------- */

/** The per-score parameters the Reimagined pricing derives, plus the two score inputs they derive from. A row whose min equals its max is a parameter this bp list simply does not vary. `share: true` prints a 0–1 share as a percentage; `suffix` appends a unit to a number that is already in it. */
const INTERNAL_ROWS = [
  { key: 'w', label: 'w', what: 'the LN weight the R + L channels are combined with', get: (s) => s.w, dec: 4 },
  { key: 'coordMod', label: 'coord_mod', what: 'the cross-column modulation applied to the L channel', get: (s) => s.coordMod, dec: 4 },
  { key: 'accFactor', label: 'acc_factor', what: 'the accuracy multiplier derived from the judgement window', get: (s) => s.accFactor, dec: 4 },
  { key: 'nfFactor', label: 'nf_factor', what: 'the No-Fail multiplier; 1.0000 on a list without NF', get: (s) => s.nfFactor, dec: 4 },
  { key: 'lShare', label: 'l_share', what: 'how much of the effective star rating is the L channel', get: (s) => s.lShare, dec: 2, share: true },
  { key: 'effStar', label: 'eff_star', what: 'the effective star rating the R + L channels produce', get: (s) => s.effStar, dec: 3 },
  { key: 'ln', label: 'ln_ratio', what: 'share of the map that is long notes', get: (s) => s.ln, dec: 2, share: true },
  { key: 'acc', label: 'accuracy', what: 'accuracy of the score, already a percentage', get: (s) => s.acc, dec: 2, suffix: '%' },
];

function renderInternals() {
  const rows = INTERNAL_ROWS.map((r) => {
    const vals = state.scores.map(r.get).filter((v) => v != null);
    if (!vals.length) return { r, n: 0 };
    const min = Math.min(...vals), max = Math.max(...vals);
    return { r, n: vals.length, min, max, p25: quantile(vals, 0.25), med: quantile(vals, 0.5), p75: quantile(vals, 0.75), constant: min === max };
  });
  const show = (r, v) => (v == null ? '–' : r.share ? pctPlain(v, r.dec) : `${fmt(v, r.dec)}${r.suffix ?? ''}`);
  el.internalsTable.innerHTML = '<table class="grid internals"><caption class="sr-only">Percentiles of the Reimagined internals over this whole bp list</caption>'
    + '<thead><tr><th scope="col">Parameter</th><th scope="col">Meaning</th><th scope="col" class="num">n</th><th scope="col" class="num">min</th><th scope="col" class="num">p25</th><th scope="col" class="num">median</th><th scope="col" class="num">p75</th><th scope="col" class="num">max</th></tr></thead><tbody>'
    + rows.map((x) => `<tr><td class="layer-name">${esc(x.r.label)}${x.constant ? ' <span class="hint">constant</span>' : ''}</td><td class="hint">${esc(x.r.what)}</td>`
      + `<td class="num">${x.n}</td><td class="num">${show(x.r, x.min)}</td><td class="num">${show(x.r, x.p25)}</td><td class="num">${show(x.r, x.med)}</td><td class="num">${show(x.r, x.p75)}</td><td class="num">${show(x.r, x.max)}</td></tr>`).join('')
    + '</tbody></table>';
  const varying = rows.filter((x) => x.n && !x.constant).length;
  el.internalsNote.textContent = `Percentiles run over every score of this bp list, with the search above deliberately not applied, and they use the nearest-rank rule — p25 is the value a quarter of the list sits at or below, not an interpolated one. The first five rows are the internals this repository's pricing derives per score (w, coord_mod, acc_factor, nf_factor, l_share); eff_star is the difficulty they produce and ln_ratio and accuracy are the two score inputs they derive from. ${varying} of the ${rows.length} parameters vary across this list; a row marked constant is one this list does not exercise at all, which is what nf_factor shows for a player with no NF score.`;
}

function renderDisagreement(rows) {
  const top = rows.map((s) => ({ s, sp: spreadOf(s.pp) }))
    .filter((x) => x.sp && x.sp.rel != null)
    .sort((a, b) => b.sp.rel - a.sp.rel || b.sp.abs - a.sp.abs || (a.s.i - b.s.i))
    .slice(0, 15);
  if (!top.length) {
    el.disagree.innerHTML = '<p class="empty">Not enough algorithms priced these scores to measure disagreement.</p>';
    return;
  }
  el.disagree.innerHTML = top.map((x, i) => {
    const s = x.s, sp = x.sp;
    const pps = state.algoIds.map((id) => `<span class="dis-pp" title="pp ${esc(algoLabel(id))}">${fmt(s.pp[id], 1)}</span>`).join('');
    const meta = [s.keys == null ? null : `${s.keys}K`, s.modsLabel, s.ln == null ? null : `LN ${fmt(s.ln * 100, 1)}%`].filter(Boolean).join(' · ');
    const open = state.open.has(s.i);
    return `<div class="dis-row" data-i="${s.i}">`
      + `<button type="button" class="dis-row-main" aria-expanded="${open}"><span class="dis-rank">${i + 1}</span>`
      + `<span class="dis-map">${esc(s.artist)} – ${esc(s.title)} <span class="ver">[${esc(s.version || '?')}]</span> <span class="meta">${esc(meta)}</span></span>`
      + `${pps}<span class="dis-spread">${pct(sp.rel, 1)}</span><span class="dis-pp dis-extra">${signed(sp.abs, 1)}</span></button>`
      + (open ? `<div class="dis-detail">${detailGrid(s)}</div>` : '') + '</div>';
  }).join('');
}

/** Scatter: x = ln_ratio over the fixed [0, 1] domain, y = the relative difference of B against A, one dot per score. The dashed rules are the RC / HB / LN cut-offs — the same numbers the layer table uses. */
function renderScatter(rows) {
  const pts = rows.filter((s) => s.ln != null && relOf(s) != null).map((s) => ({ s, x: s.ln, y: relOf(s) }));
  const skipped = rows.length - pts.length;
  if (!pts.length) {
    el.scatter.innerHTML = '<p class="empty">No score here is priced by both A and B and carries an ln_ratio.</p>';
    el.scatterNote.textContent = skipped ? `${skipped} score${skipped === 1 ? '' : 's'} skipped.` : '';
    return;
  }
  const W = 620, H = 310, L = 52, R = 16, T = 18, B = 46;
  const x0 = L, x1 = W - R, y0 = T, y1 = H - B, mid = (y0 + y1) / 2, half = (y1 - y0) / 2;
  const yMax = Math.max(0.02, ...pts.map((p) => Math.abs(p.y))) * 1.08;
  const xAt = (v) => x0 + clamp(v, 0, 1) * (x1 - x0);
  const yAt = (v) => mid - (v / yMax) * half;
  const med = median(pts.map((p) => p.y));
  const signedPct = (v) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
  const ticks = [yMax, yMax / 2, 0, -yMax / 2, -yMax].map((v) => `<line class="${v === 0 ? 'zero' : 'rule'}" x1="${x0}" x2="${x1}" y1="${yAt(v).toFixed(1)}" y2="${yAt(v).toFixed(1)}"/>`
    + `<text x="${x0 - 6}" y="${(yAt(v) + 3.5).toFixed(1)}" text-anchor="end">${pctPlain(v)}</text>`).join('');
  const rules = [LN_RC, LN_HB].map((v) => `<line class="bucket" x1="${xAt(v).toFixed(1)}" x2="${xAt(v).toFixed(1)}" y1="${y0}" y2="${y1}"/>`).join('');
  const ruleLabels = `<text class="bucket-label" x="${xAt(LN_RC) + 3}" y="${y1 - 4}">${LN_RC}</text><text class="bucket-label" x="${xAt(LN_HB) + 3}" y="${y1 - 4}">${LN_HB}</text>`;
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((v) => `<text x="${xAt(v).toFixed(1)}" y="${y1 + 14}" text-anchor="middle">${v}</text>`).join('');
  const dots = pts.map((p) => `<circle class="dot" cx="${xAt(p.x).toFixed(1)}" cy="${yAt(p.y).toFixed(1)}" r="3">`
    + `<title>${esc(p.s.artist)} – ${esc(p.s.title)} [${esc(p.s.version || '?')}] · ln_ratio ${fmt(p.x, 4)} · ${esc(algoLabel(state.B))} vs ${esc(algoLabel(state.A))} ${signedPct(p.y)}</title></circle>`).join('');
  const yMed = yAt(clamp(med, -yMax, yMax));
  el.scatter.innerHTML = `<svg class="scatter" viewBox="0 0 ${W} ${H}" role="img" aria-label="relative difference of ${esc(algoLabel(state.B))} against ${esc(algoLabel(state.A))} by ln_ratio, one dot per score">`
    + ticks + rules + ruleLabels
    + `<line class="rule" x1="${x0}" x2="${x1}" y1="${y1}" y2="${y1}"/><line class="rule" x1="${x0}" x2="${x0}" y1="${y0}" y2="${y1}"/>`
    + `<line class="median" x1="${x0}" x2="${x1}" y1="${yMed.toFixed(1)}" y2="${yMed.toFixed(1)}"/>`
    + `<text class="median-label" x="${x1 - 2}" y="${(yMed - 4).toFixed(1)}" text-anchor="end">median ${signedPct(med)}</text>`
    + dots + xTicks
    + `<text class="axis-label" x="${x0}" y="${H - 12}">ln_ratio — share of long notes (rules at ${LN_RC} and ${LN_HB}: RC / HB / LN)</text>`
    + `<text class="axis-label" x="0" y="12">${esc(algoLabel(state.B))} vs ${esc(algoLabel(state.A))}</text></svg>`;
  const bucketMed = LN_BUCKETS.map((b) => {
    const ys = pts.filter((p) => b.test(p.x)).map((p) => p.y);
    return { b, v: median(ys), n: ys.length };
  }).filter((x) => x.v != null);
  el.scatterNote.textContent = `${pts.length} score${pts.length === 1 ? '' : 's'} plotted, y axis ±${pctPlain(yMax)}; median ${signedPct(med)}`
    + bucketMed.map((x) => `, ${x.b.label} median ${signedPct(x.v)} (n=${x.n})`).join('')
    + '. A gap between the bucket medians is the systematic long-note preference.'
    + (skipped ? ` ${skipped} score${skipped === 1 ? '' : 's'} skipped (no ln_ratio or no pp on one side).` : '');
}

/** Panels driven by the search, the sort and the A/B pair. */
function renderList() {
  const ready = state.shard === 'ready' && state.scores.length > 0;
  const panels = [el.panelScores, el.panelCumulative, el.panelEfficiency, el.panelTop, el.panelMod, el.panelInternals, el.panelLayers, el.panelDisagree];
  for (const p of panels) p.hidden = !ready;
  if (!ready) {
    $('thead', el.table).innerHTML = '';
    $('tbody', el.table).innerHTML = '';
    el.count.textContent = '';
    el.searchState.textContent = '';
    el.searchWarn.hidden = true;
    el.filter.hidden = true;
    el.pager.hidden = true;
    el.layerTable.innerHTML = '';
    el.layerNote.textContent = '';
    el.cumulative.innerHTML = '';
    el.cumulativeNote.textContent = '';
    el.efficiency.innerHTML = '';
    el.efficiencyNote.textContent = '';
    el.topTables.innerHTML = '';
    el.topNote.textContent = '';
    el.modTable.innerHTML = '';
    el.modNote.textContent = '';
    el.internalsTable.innerHTML = '';
    el.internalsNote.textContent = '';
    el.disagree.innerHTML = '';
    el.scatter.innerHTML = '';
    el.scatterNote.textContent = '';
    return;
  }
  const { rows } = selected();
  renderScores();
  renderCumulative();
  renderEfficiency(rows);
  renderTop();
  renderModFamily();
  renderInternals();
  renderLayers();
  renderDisagreement(rows);
  renderScatter(rows);
}

function render() {
  renderHead();
  renderTotals();
  renderShardState();
  renderList();
}

/* ---------------------------------- csv ---------------------------------- */

/** The current search and sort, not just the visible page. The header carries both algorithm ids, so a file kept next to another comparison stays clear. */
function exportScoresCsv() {
  const { rows } = selected();
  if (!rows.length) return;
  const A = state.A, B = state.B;
  const head = [
    ...CSV_ORDER.map((c) => c.toUpperCase()),
    ...state.algoIds.map((id) => `PP_${id.toUpperCase()}`),
    'DIFF_PP', 'REL_PCT', `RANK_${A.toUpperCase()}`, `RANK_${B.toUpperCase()}`, 'RANK_SHIFT', 'SPREAD_REL_PCT', 'OSU_LINKS',
  ];
  const lines = rows.map((s) => {
    const sp = spreadOf(s.pp);
    const first = CSV_ORDER.map((c) => csvCell({
      score_id: s.scid, beatmap_id: s.bid, beatmap_set_id: s.sid, artist: s.artist, title: s.title,
      version: s.version, mapper: s.mapper, keys: s.keys, od: s.od, mods: s.mods, accuracy: s.acc,
      n320: s.counts[0], n300: s.counts[1], n200: s.counts[2], n100: s.counts[3], n50: s.counts[4], miss: s.counts[5],
      star_bancho: s.stars.bancho, star_sunny: s.stars.sunny, star_rice: s.stars.rice, ln_ratio: s.ln,
      l_share: s.lShare, w: s.w, coord_mod: s.coordMod, eff_star: s.effStar, acc_factor: s.accFactor, nf_factor: s.nfFactor,
    }[c])).join(',');
    return [first,
      state.algoIds.map((id) => csvNum(s.pp[id])).join(','),
      csvNum(diffOf(s)),
      relOf(s) == null ? '' : csvNum(relOf(s) * 100, 4),
      scoreRank(s, A) ?? '', scoreRank(s, B) ?? '', shiftOf(s) ?? '',
      sp?.rel == null ? '' : csvNum(sp.rel * 100, 4),
      csvCell([s.bid != null && s.sid != null ? `https://osu.ppy.sh/beatmapsets/${s.sid}#mania/${s.bid}` : null, s.scid == null ? null : `https://osu.ppy.sh/scores/${s.scid}`, state.uid == null ? null : `https://osu.ppy.sh/users/${state.uid}`].filter(Boolean).join(' ')),
    ].join(',');
  });
  downloadCsv(`scores_${state.uid ?? 'player'}_${A}_vs_${B}.csv`, [head.join(','), ...lines].join('\r\n') + '\r\n');
  flash(el.exportBtn, `Exported ${rows.length} rows`, 'Export CSV');
}

/* --------------------------------- events -------------------------------- */

/** A filtering pass that a newer keystroke has already superseded is dropped rather than rendered, and the indicator clears only once a pass has actually drawn its results. */
let filterToken = 0;
function scheduleFilter() {
  const token = ++filterToken;
  el.filter.hidden = false;
  idle(() => {
    if (token !== filterToken) return;
    renderList();
  });
}

const onInput = debounce(() => {
  const view = state.view.player;
  if (!view) return;
  view.q = el.q.value;
  view.page = 1;   // a new filter makes the old page number meaningless
  writeHash(true);
  scheduleFilter();
}, FILTER_DELAY);

/** Reset clears this view's search and sort; the A/B pair is global and has its own control. */
function resetView() {
  const view = state.view.player;
  if (!view) return;
  view.q = '';
  view.page = 1;
  el.q.value = '';
  resetPaging('player');
  const d = defaultSort();
  setSort('player', d.key, d.dir);
  renderList();
}

/** Switch between the compact and the grouped layout. The layout belongs in the hash with the rest of the view state. */
function setLayout(layout) {
  const view = state.view.player;
  if (!view || view.layout === layout) return;
  view.layout = layout;
  view.page = 1;
  writeHash(true);
  renderList();
}

export function initPlayerView() {
  el.table.addEventListener('click', (ev) => {
    const th = ev.target.closest('th[data-key]');
    if (th) {
      const sort = state.sort.player || defaultSort();
      const next = nextSort(sort, th.dataset.key);
      setSort('player', next.key, next.dir);
      renderScores();
      return;
    }
    if (ev.target.closest('a')) return;
    const tr = ev.target.closest('tr[data-i]');
    if (!tr) return;
    const i = Number(tr.dataset.i);
    if (state.open.has(i)) state.open.delete(i); else state.open.add(i);
    renderScores();
  });
  el.disagree.addEventListener('click', (ev) => {
    const row = ev.target.closest('.dis-row');
    if (!row) return;
    const i = Number(row.dataset.i);
    if (state.open.has(i)) state.open.delete(i); else state.open.add(i);
    renderDisagreement(selected().rows);
  });
  el.q.addEventListener('input', onInput);
  el.reset.addEventListener('click', resetView);
  el.exportBtn.addEventListener('click', exportScoresCsv);
  el.pager.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-page]');
    if (b) goPage(b.dataset.page);
  });
  el.layoutBox.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-layout]');
    if (b) setLayout(b.dataset.layout);
  });
  el.retry.addEventListener('click', () => loadShard());

  registerView({
    id: 'player',
    label: null,
    needsShard: true,
    reSortOnPair: true,
    defaultSort,
    parse(q, arg) {
      const wanted = arg == null ? '' : String(arg).trim();
      if (!wanted) return null;
      const u = state.users.find((x) => String(x.uid) === wanted || x.username === wanted);
      if (!u) return null;
      return {
        uid: u.uid,
        q: q.q ?? '',
        sort: q.sort || defaultSort().key,
        dir: q.dir ? (q.dir === 'asc' ? 1 : -1) : 1,
        layout: q.layout === 'grouped' ? 'grouped' : 'compact',
        page: pageArg(q.page),
      };
    },
    path: (view) => `#/player/${encodeURIComponent(String(view?.uid ?? state.uid ?? ''))}`,
    title: (view) => {
      const u = state.users.find((x) => x.uid === view?.uid);
      return u ? `${u.username} — mania-sr-pp-reimagined` : 'Player — mania-sr-pp-reimagined';
    },
    sync(view) {
      el.q.value = view.q;
      for (const b of $$('button[data-layout]', el.layoutBox)) b.setAttribute('aria-pressed', String(b.dataset.layout === view.layout));
    },
    render,
  });

  return {
    invalidate() { cache = { key: '', rows: [], parsed: [] }; },
    focusSearch() { el.q.focus(); el.q.select(); },
    /** Esc clears the box at once rather than after the debounce, because the reader asked for it and is waiting. */
    clearSearch() {
      const view = state.view.player;
      el.q.value = '';
      if (!view) return;
      view.q = '';
      view.page = 1;
      writeHash(true);
      scheduleFilter();
    },
    isSearchFocused: () => document.activeElement === el.q,
    searchInput: el.q,
  };
}
