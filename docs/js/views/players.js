/* ===========================================================================
 * views/players.js — #/players, the rankings.
 *
 * One row per player in data/index.json, so this view fetches no shard at all: totals, ranks, deltas and moves are all in the index.
 * The anchor every delta and every ▲/▼ is measured against is A, because A is the baseline by definition; the totals themselves come from each algorithm's own ordering of that player's scores.
 * Sorting re-renders only the tbody and patches the header in place, the rows are paged fifty at a time with the page number in the hash, and the CSV button exports the whole current sort and filter rather than the visible page.
 * Typing never filters in its own keystroke: the box waits for a pause, then filters in an idle slice with a "filtering…" indicator beside the row count.
 * =========================================================================== */

import { $ } from '../dom.js';
import { csvCell, csvNum, debounce, dirClass, downloadCsv, esc, flash, fmtG, idle, num, pct, signed } from '../format.js';
import {
  algoLabel, compareRows, headHtml, nextSort, openPlayer, pageArg, pageScrollIntoView, pageTarget, pageWindow, patchSort,
  playerDelta, playerMove, playerRank, playerRel, registerView, resetPaging, setSort, state, syncPager, uidKey, writeHash,
} from '../core.js';
import { matchesPlayer, parseQuery, playerFields } from '../search.js';

const el = {
  q: $('#players-q'),
  reset: $('#players-reset'),
  exportBtn: $('#players-export'),
  count: $('#players-q-count'),
  filter: $('#players-filter'),
  table: $('#players-table'),
  note: $('#players-note'),
  pager: $('#players-pager'),
  pageInfo: $('#players-page-info'),
};

/** How long the box waits for the typing to stop before it filters. A little longer than a keyboard repeat, so a burst of characters costs one filter pass. */
const FILTER_DELAY = 220;

/** Default sort: the baseline algorithm's weighted total, highest first. */
const defaultSort = () => ({ key: state.A ? `pp:${state.A}` : 'username', dir: state.A ? -1 : 1 });

/** Identity, then per algorithm: the weighted total, the rank with its move against A, and Δ against A as an absolute figure plus a percentage. */
function rankingColumns() {
  const columns = [
    { key: 'username', label: 'Player', type: 'str', cls: 'c-player', title: 'Click a row to open that player',
      cell: (u) => `<td class="pname">${esc(u.username)}${u.uid == null ? '' : `<span class="uid"> #${esc(u.uid)}</span>`}</td>` },
    { key: 'scores', label: 'Scores', type: 'num', cls: 'c-scores', title: 'scores in this dataset',
      cell: (u) => `<td class="num">${esc(u.scoreCount)}</td>` },
  ];
  for (const id of state.algoIds) {
    const label = algoLabel(id);
    const isBaseline = id === state.A;
    columns.push({
      key: `pp:${id}`, label, type: 'num', cls: 'c-pp blk', title: `${label}: weighted total pp, a 0.95-decay sum over this player's scores ordered by ${label}`,
      cell: (u) => `<td class="num">${fmtG(num(u.totalPp[id]), 1)}</td>`,
    });
    columns.push({
      key: `rank:${id}`, label: `${label} rank`, type: 'num', cls: 'c-rank', title: `${label}: rank over the players in this dataset (1 = the highest total)`,
      cell: (u) => `<td class="num rank">${playerRank(u, id) ?? '–'}${moveBadge(u, id)}</td>`,
    });
    columns.push({
      key: `delta:${id}`, label: `Δ ${label}`, type: 'num', cls: 'c-delta',
      title: isBaseline ? `${label} is the A column every delta is measured against` : `${label} minus ${algoLabel(state.A)}, absolute and in percent`,
      cell: (u) => {
        if (isBaseline) return '<td class="num">–</td>';
        const d = playerDelta(u, id), r = playerRel(u, id);
        return `<td class="num ${dirClass(d)}">${signed(d, 1)}<span class="hint"> ${r == null ? '–' : pct(r / 100, 1)}</span></td>`;
      },
    });
  }
  return columns;
}

/** ▲/▼ against the same player's rank under A, which is what "who gains when the algorithm changes" means. */
function moveBadge(u, id) {
  if (id === state.A) return '';
  const move = playerMove(u, id);
  if (move == null) return '';
  if (move === 0) return '<span class="rank-move hint">=</span>';
  return `<span class="rank-move ${dirClass(move)}" title="${move > 0 ? 'up' : 'down'} ${Math.abs(move)} against ${esc(algoLabel(state.A))}">${move > 0 ? '▲' : '▼'}${Math.abs(move)}</span>`;
}

function sortValue(u, key) {
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

/** Search, then sort. Both run off the render path, and the result is memoised on the inputs that define it. */
let cache = { key: '', rows: [], parsed: [] };
function selected() {
  const view = state.view.players || {};
  const sort = state.sort.players || defaultSort();
  const key = [view.q ?? '', sort.key, sort.dir, state.A, state.B, state.dataVersion].join('\u0001');
  if (cache.key === key) return cache;
  const parsed = parseQuery(view.q ?? '', playerFields());
  const rows = parsed.length ? state.users.filter((u) => matchesPlayer(parsed, u)) : state.users.slice();
  rows.sort((a, b) => compareRows(a, b, sort.key, sort.dir, sortValue, (u) => u.username.toLowerCase(), (u) => state.users.indexOf(u)));
  cache = { key, rows, parsed };
  return cache;
}

function render() {
  const columns = rankingColumns();
  $('thead', el.table).innerHTML = headHtml(columns);
  const { rows, parsed } = selected();
  const w = pageWindow(state.view.players, rows.length);
  const slice = rows.slice(w.start, w.end);
  $('tbody', el.table).innerHTML = slice.length
    ? slice.map((u) => {
      const active = state.uid != null && u.uid === state.uid;
      return `<tr data-ukey="${esc(uidKey(u))}"${active ? ' class="row-active"' : ''} tabindex="0" role="link" aria-label="Open ${esc(u.username)}">${columns.map((c) => c.cell(u)).join('')}</tr>`;
    }).join('')
    : `<tr><td colspan="${columns.length}" class="empty">${state.users.length ? 'No player matches the current search.' : 'This dataset contains no players.'}</td></tr>`;
  patchSort(el.table, state.sort.players || defaultSort(), columns);

  el.pager.hidden = !rows.length;
  syncPager(el.pager, el.pageInfo, w);
  el.filter.hidden = true;   // the results the indicator was waiting for are on screen

  const bad = parsed.filter((t) => t.kind === 'field' && t.spec.available === false).map((t) => t.raw);
  el.count.textContent = (parsed.length ? `${rows.length} of ${state.users.length} players match · ${parsed.length} term${parsed.length === 1 ? '' : 's'}` : `${rows.length} player${rows.length === 1 ? '' : 's'}`)
    + (bad.length ? ` · ${bad.join(', ')} always matches nothing (no map creator in the dataset)` : '');
  el.exportBtn.disabled = !rows.length;
  el.note.textContent = `Ranks cover the ${state.users.length} player${state.users.length === 1 ? '' : 's'} in this dataset (1 = the highest weighted total) and come from data/index.json alone — no player shard is fetched for this view. ▲/▼ is the move against the same player's ${algoLabel(state.A)} rank, so it shows who gains or loses when the algorithm is switched. The table is paged fifty rows at a time and the page number lives in the hash, so a link reproduces the page it was copied from.`;
}

/** One pager button. The target is clamped to the pages the current filter actually has, and the page number goes into the hash like the rest of the view state. */
function goPage(kind) {
  const view = state.view.players;
  if (!view) return;
  const w = pageWindow(view, selected().rows.length);
  const target = pageTarget(kind, w);
  if (target === w.page || target < 1 || target > w.pages) return;
  view.page = target;
  writeHash(true);
  render();
  pageScrollIntoView(el.table);
}

/** Export the current sort and filter, one row per player, all of them rather than the visible page. */
function exportCsv() {
  const { rows } = selected();
  if (!rows.length) return;
  const head = ['UID', 'USERNAME', 'SCORES',
    ...state.algoIds.map((id) => `PP_${id.toUpperCase()}`),
    ...state.algoIds.map((id) => `RANK_${id.toUpperCase()}`),
    ...state.algoIds.map((id) => `DELTA_${id.toUpperCase()}`),
    ...state.algoIds.map((id) => `REL_PCT_${id.toUpperCase()}`),
    ...state.algoIds.map((id) => `MOVE_${id.toUpperCase()}_VS_${state.A.toUpperCase()}`)];
  const lines = rows.map((u) => [u.uid, u.username, u.scoreCount,
    ...state.algoIds.map((id) => csvNum(num(u.totalPp[id]))),
    ...state.algoIds.map((id) => playerRank(u, id) ?? ''),
    ...state.algoIds.map((id) => csvNum(playerDelta(u, id))),
    ...state.algoIds.map((id) => csvNum(playerRel(u, id), 4)),
    ...state.algoIds.map((id) => playerMove(u, id) ?? ''),
  ].map(csvCell).join(','));
  downloadCsv(`players_${state.A}_vs_${state.B}.csv`, [head.join(','), ...lines].join('\r\n') + '\r\n');
  flash(el.exportBtn, `Exported ${rows.length} players`, 'Export CSV');
}

/** A filtering pass that a newer keystroke has already superseded is dropped rather than rendered, and the indicator clears only once a pass has actually drawn its results. */
let filterToken = 0;
function scheduleFilter() {
  const token = ++filterToken;
  el.filter.hidden = false;
  idle(() => {
    if (token !== filterToken) return;
    render();
  });
}

const onInput = debounce(() => {
  const view = state.view.players;
  if (!view) return;
  view.q = el.q.value;
  view.page = 1;   // a new filter makes the old page number meaningless
  writeHash(true);
  scheduleFilter();
}, FILTER_DELAY);

/** Reset clears this view's search and sort; the A/B pair is global and has its own control. */
function resetView() {
  const view = state.view.players;
  if (!view) return;
  view.q = '';
  view.page = 1;
  el.q.value = '';
  resetPaging('players');
  const d = defaultSort();
  setSort('players', d.key, d.dir);
  render();
}

export function initPlayersView() {
  el.table.addEventListener('click', (ev) => {
    const th = ev.target.closest('th[data-key]');
    if (th) {
      const sort = state.sort.players || defaultSort();
      const next = nextSort(sort, th.dataset.key);
      setSort('players', next.key, next.dir);
      render();
      return;
    }
    const tr = ev.target.closest('tr[data-ukey]');
    if (!tr) return;
    const u = state.users.find((x) => uidKey(x) === tr.dataset.ukey);
    if (u) openPlayer(u.uid);
  });
  el.table.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const tr = ev.target.closest('tr[data-ukey]');
    if (!tr) return;
    ev.preventDefault();
    const u = state.users.find((x) => uidKey(x) === tr.dataset.ukey);
    if (u) openPlayer(u.uid);
  });
  el.q.addEventListener('input', onInput);
  el.reset.addEventListener('click', resetView);
  el.exportBtn.addEventListener('click', exportCsv);
  el.pager.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-page]');
    if (b) goPage(b.dataset.page);
  });

  registerView({
    id: 'players',
    label: 'Rankings',
    needsShard: false,
    reSortOnPair: true,
    defaultSort,
    parse(q, arg) {
      const sort = q.sort ? q.sort : defaultSort().key;
      return {
        q: q.q ?? '',
        sort,
        dir: q.dir ? (q.dir === 'asc' ? 1 : -1) : defaultSort().dir,
        page: pageArg(q.page),
      };
    },
    path: () => '#/players',
    title: () => 'Rankings — mania-sr-pp-reimagined',
    sync(view) { el.q.value = view.q; },
    render,
  });

  return {
    /** Keyboard and help-panel access, so the entry point does not have to reach into this view's DOM. */
    openFirstMatch() {
      const { rows } = selected();
      if (rows.length) openPlayer(rows[0].uid);
    },
    focusSearch() { el.q.focus(); el.q.select(); },
    /** Esc clears the box at once rather than after the debounce, because the reader asked for it and is waiting. */
    clearSearch() {
      const view = state.view.players;
      el.q.value = '';
      if (!view) return;
      view.q = '';
      view.page = 1;
      writeHash(true);
      scheduleFilter();
    },
    isSearchFocused: () => document.activeElement === el.q,
    invalidate() { cache = { key: '', rows: [], parsed: [] }; },
    searchInput: el.q,
  };
}
