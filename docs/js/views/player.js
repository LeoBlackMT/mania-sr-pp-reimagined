/* ===========================================================================
 * views/player.js — #/player/{uid}, one bp list in full.
 *
 * The totals come from the index and stay valid even when the shard does not load; everything else comes from that one shard, which this view fetches when it is entered and never for any other player.
 * The score table has two layouts. COMPACT, the default, is the owner's column order and nothing else: Rank A, Rank B, Shift, Beatmap, one star column per star the shard publishes, Keys, OD, LN %, PP A, PP B, Δ (B−A), Δ %, Acc %, the six judgement counts, Mods. GROUPED puts every algorithm's pp side by side and appends the detail columns, which is the wider table the compact layout exists to replace.
 * The layers panel is computed over the whole bp list and deliberately ignores the search box; the score table, the disagreement list and the scatter all follow it.
 * =========================================================================== */

import { $, $$ } from '../dom.js';
import { cellNum, cellSigned, clamp, csvCell, csvNum, debounce, dirClass, downloadCsv, esc, EXTERNAL, flash, fmt, fmtG, link, median, pct, pctPlain, signed } from '../format.js';
import {
  CSV_ORDER, LN_BUCKETS, LN_HB, LN_RC, PAGE_SIZE, SHIFT_BIG, SHIFT_MID, algoLabel, compareRows, detailGrid, diffOf, expandButton,
  headHtml, layerFamilies, loadShard, nextSort, patchSort, ppA, ppB, player, registerView, relOf, resetPaging, scoreRank, setSort,
  shiftClass, shiftOf, shownFor, spreadOf, starColumns, starValue, state, totalFor, writeHash,
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
  panelLayers: $('#panel-layers'),
  panelDisagree: $('#panel-disagree'),
  q: $('#scores-q'),
  reset: $('#scores-reset'),
  exportBtn: $('#export-csv'),
  layoutBox: $('#layout-toggle'),
  count: $('#score-count'),
  searchState: $('#search-state'),
  searchWarn: $('#search-warn'),
  table: $('#score-table'),
  more: $('#show-more'),
  layerTable: $('#layer-table'),
  layerNote: $('#layer-note'),
  disagree: $('#disagree'),
  scatter: $('#scatter'),
  scatterNote: $('#scatter-note'),
};

const COUNT_LABELS = ['320', '300', '200', '100', '50', 'miss'];
const COUNT_TITLE = 'judgement counts 320 / 300 / 200 / 100 / 50 / miss';

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
  const slice = rows.slice(0, shownFor('player'));
  $('tbody', el.table).innerHTML = slice.length
    ? slice.map((s) => rowHtml(s, columns)).join('')
    : `<tr><td colspan="${columns.length}" class="empty">${state.scores.length ? 'No score matches the current search.' : 'This bp list has no scores in this dataset.'}</td></tr>`;
  patchSort(el.table, state.sort.player || defaultSort(), columns);

  const left = rows.length - slice.length;
  el.more.hidden = left <= 0;
  el.more.textContent = `Show more (${Math.min(PAGE_SIZE, left)} of ${left} remaining)`;
  el.count.textContent = `${slice.length} of ${rows.length} score${rows.length === 1 ? '' : 's'} shown`;
  el.exportBtn.disabled = !rows.length;

  el.searchState.textContent = parsed.length ? `${rows.length} of ${state.scores.length} scores match · ${parsed.length} term${parsed.length === 1 ? '' : 's'}` : '';
  const bad = unsatisfiable(parsed);
  el.searchWarn.hidden = !bad.length;
  el.searchWarn.textContent = bad.length ? `${bad.join(', ')}: this dataset carries no map creator column, so this term matches nothing.` : '';
  for (const b of $$('button[data-layout]', el.layoutBox)) b.setAttribute('aria-pressed', String(b.dataset.layout === layout));
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
  el.panelScores.hidden = !ready;
  el.panelLayers.hidden = !ready;
  el.panelDisagree.hidden = !ready;
  if (!ready) {
    $('thead', el.table).innerHTML = '';
    $('tbody', el.table).innerHTML = '';
    el.count.textContent = '';
    el.searchState.textContent = '';
    el.searchWarn.hidden = true;
    el.more.hidden = true;
    el.layerTable.innerHTML = '';
    el.layerNote.textContent = '';
    el.disagree.innerHTML = '';
    el.scatter.innerHTML = '';
    el.scatterNote.textContent = '';
    return;
  }
  const { rows } = selected();
  renderScores();
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

const onInput = debounce(() => {
  const view = state.view.player;
  if (!view) return;
  view.q = el.q.value;
  resetPaging('player');
  writeHash(true);
  renderList();
}, 120);

/** Reset clears this view's search and sort; the A/B pair is global and has its own control. */
function resetView() {
  const view = state.view.player;
  if (!view) return;
  view.q = '';
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
  resetPaging('player');
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
  el.more.addEventListener('click', () => {
    state.shown.player = shownFor('player') + PAGE_SIZE;
    renderScores();
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
    clearSearch() { el.q.value = ''; onInput(); },
    isSearchFocused: () => document.activeElement === el.q,
    searchInput: el.q,
  };
}
