/* ===========================================================================
 * search.js — the query language, the field maps it is checked against, and the panel that documents it.
 *
 * The shape is osu!'s beatmap search: free text plus `field<operator>value`, all case-insensitive, several terms ANDed. The operators mean:
 *   =   and :   fuzzy — a case-insensitive substring for a text field, and for `mod`/`mods` "this score carries that mod", so mod=DT also finds "DT+MR".
 *   ==          exact — for a text field the whole value must be equal (case-insensitively), and for `mod`/`mods` only a score whose mods are exactly that set matches, so mod==DT excludes "DT+MR".
 *   !=  <  >  <=  >=   unchanged: not-equal, and the four orderings.
 * On a numeric field = and == are both numeric equality, because a substring of a number is not a thing anybody means.
 *
 * Two more rules keep the box honest: a name that is not a field of this dataset falls back to free text, so a typo narrows nothing rather than silently matching nothing; and a null value fails every operator, != included, so "has no value" can never masquerade as a match.
 * A field this dataset cannot satisfy (a map creator column that is not there) is reported under the box instead of quietly matching nothing.
 * =========================================================================== */

import { els } from './dom.js';
import { esc, median, num } from './format.js';
import {
  algoLabel, diffOf, modHay, modKey, ppB, playerDelta, playerMove, playerRank, playerRel, primaryStar, relOf, scoreRank, starValue, state,
} from './core.js';

/** Longest operators first, so `==` is never read as two `=`. */
const SEARCH_OPS = ['!=', '==', '<=', '>=', '=', ':', '<', '>'];

/** Split on whitespace, keeping "quoted values" in one piece. */
function tokenize(q) {
  const out = [];
  let buf = '', quote = null;
  for (const ch of String(q)) {
    if (quote) {
      if (ch === quote) quote = null; else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (/\s/.test(ch)) {
      if (buf) out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

/** One query -> terms against one field map: {kind, field, spec, op, value}. */
export function parseQuery(q, fields) {
  return tokenize(q).map((raw) => {
    for (const op of SEARCH_OPS) {
      const at = raw.indexOf(op);
      if (at <= 0) continue;
      const name = raw.slice(0, at).toLowerCase();
      const spec = fields[name];
      if (!spec) continue;   // not a field we have -> free text, exactly like osu!'s search
      const value = raw.slice(at + op.length);
      return {
        kind: 'field', field: name, spec, raw,
        op: op === ':' ? '=' : op,
        valueNum: num(value),
        valueText: value.toLowerCase(),
        valueKey: modKey(value),
      };
    }
    return { kind: 'text', value: raw.toLowerCase(), raw };
  });
}

const cmp = (x, y, op) => (op === '=' ? x === y : op === '!=' ? x !== y
  : op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : x >= y);

/** One field term against one value. A null value fails every operator, `!=` included. */
export function matchTerm(term, item) {
  const v = term.spec.get(item);
  if (v == null) return false;
  if (term.spec.kind === 'mods') return matchMods(term, String(v));
  if (term.spec.numeric) {
    const n = num(v);
    return n == null || term.valueNum == null ? false : cmp(n, term.valueNum, term.op);
  }
  const text = String(v).toLowerCase();
  if (term.op === '=') return text.includes(term.valueText);
  if (term.op === '==') return text === term.valueText;
  return cmp(text, term.valueText, term.op);
}

/** `mod=DT` asks whether the score carries DT; `mod==DT` asks whether DT is all it carries; both ignore the separators an engine string may use. */
function matchMods(term, hay) {
  const have = modKey(hay);
  const want = term.valueKey;
  const carries = (flag) => {
    if (flag === '' || flag === 'NM') return hay.toUpperCase() === '' || hay.toUpperCase() === 'NM';
    return hay.toUpperCase().includes(flag);
  };
  if (term.op === '=') return want === '' ? hay.trim() === '' : carries(want);
  if (term.op === '==') return have === want;
  if (term.op === '!=') return have !== want;
  return cmp(hay.toLowerCase(), term.valueText, term.op);
}

export const matchesScore = (parsed, s) => parsed.every((t) => (t.kind === 'text' ? s.text.includes(t.value) : matchTerm(t, s)));
export const matchesPlayer = (parsed, u) => parsed.every((t) => (t.kind === 'text' ? u.text.includes(t.value) : matchTerm(t, u)));

/** Field names the current dataset cannot satisfy, for the amber note under the box. */
export const unsatisfiable = (parsed) => parsed.filter((t) => t.kind === 'field' && t.spec.available === false).map((t) => t.raw);

/* ----------------------------- score field map ---------------------------- */

let scoreFieldMap = null;

/** Rebuild after every shard, because the star columns and the mapper column are properties of the shard, not of the page. */
export function rebuildScoreFields() {
  scoreFieldMap = buildScoreFields();
  return scoreFieldMap;
}
export const scoreFields = () => scoreFieldMap || rebuildScoreFields();

function buildScoreFields() {
  const hasMapper = state.shardColumns.includes('mapper') || state.shardColumns.includes('creator');
  const t = (get, extra = {}) => ({ get, kind: 'text', numeric: false, available: true, ...extra });
  const n = (get, extra = {}) => ({ get, kind: 'num', numeric: true, available: true, ...extra });
  const lnPct = (s) => (s.ln == null ? null : s.ln * 100);
  const relPct = (s) => { const r = relOf(s); return r == null ? null : r * 100; };
  const fields = {
    artist: t((s) => s.artist),
    title: t((s) => s.title),
    diff: t((s) => s.version),
    version: t((s) => s.version),
    creator: t((s) => s.mapper, { available: hasMapper }),
    mapper: t((s) => s.mapper, { available: hasMapper }),
    key: n((s) => s.keys),
    keys: n((s) => s.keys),
    od: n((s) => s.od),
    ln: n(lnPct),
    lns: n(lnPct),
    ln_ratio: n((s) => s.ln),
    mod: { get: modHay, kind: 'mods', numeric: false, available: true },
    mods: { get: modHay, kind: 'mods', numeric: false, available: true },
    acc: n((s) => s.acc),
    accuracy: n((s) => s.acc),
    n320: n((s) => s.counts[0]),
    n300: n((s) => s.counts[1]),
    n200: n((s) => s.counts[2]),
    n100: n((s) => s.counts[3]),
    n50: n((s) => s.counts[4]),
    miss: n((s) => s.counts[5]),
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
    // The A/B pair drives the unsuffixed names; `pp_<algo>` and `rank_<algo>` are added for every algorithm below.
    pp: n((s) => ppB(s)),
    delta: n((s) => diffOf(s)),
    rel: n(relPct),
    rank: n((s) => scoreRank(s, state.B)),
    spread: n((s) => { const vals = state.algoIds.map((id) => s.pp[id]).filter((v) => v != null); return vals.length < 2 ? null : Math.max(...vals) - Math.min(...vals); }),
  };
  // The bare star name means the official one, and falls back to whatever star column the shard does carry.
  fields.star = n(primaryStar);
  fields.stars = n(primaryStar);
  fields.sr = n(primaryStar);
  for (const id of state.algoIds) {
    fields[`pp_${id}`] = n((s) => s.pp[id]);
    fields[`total_pp_${id}`] = fields[`pp_${id}`];
    fields[`rank_${id}`] = n((s) => scoreRank(s, id));
  }
  for (const x of state.starKeys) {
    fields[`star_${x}`] = n((s) => starValue(s, x));
    fields[`sr_${x}`] = n((s) => starValue(s, x));
  }
  return fields;
}

/* ---------------------------- player field map ---------------------------- */

let playerFieldMap = null;

/** `pp_<algo>`, `rank_<algo>`, `delta_<algo>`, `rel_<algo>` and `move_<algo>` for every algorithm in the dataset, so an added algorithm is searchable without a page change. */
export function rebuildPlayerFields() {
  const fields = {
    uid: { get: (u) => u.uid, numeric: true, available: true },
    username: { get: (u) => u.username, numeric: false, available: true },
    user: { get: (u) => u.username, numeric: false, available: true },
    name: { get: (u) => u.username, numeric: false, available: true },
    scores: { get: (u) => u.scoreCount, numeric: true, available: true },
    score_count: { get: (u) => u.scoreCount, numeric: true, available: true },
    fixture: { get: (u) => u.fixture, numeric: false, available: true },
    pp: { get: (u) => u.totalPp[state.B], numeric: true, available: true },
    rank: { get: (u) => playerRank(u, state.B), numeric: true, available: true },
    delta: { get: (u) => playerDelta(u, state.B), numeric: true, available: true },
    rel: { get: (u) => playerRel(u, state.B), numeric: true, available: true },
    move: { get: (u) => playerMove(u, state.B), numeric: true, available: true },
  };
  for (const id of state.algoIds) {
    const key = id.toLowerCase();
    fields[`pp_${key}`] = { get: (u) => u.totalPp[id], numeric: true, available: true };
    fields[`total_${key}`] = fields[`pp_${key}`];
    fields[`total_pp_${key}`] = fields[`pp_${key}`];
    fields[`rank_${key}`] = { get: (u) => playerRank(u, id), numeric: true, available: true };
    fields[`delta_${key}`] = { get: (u) => playerDelta(u, id), numeric: true, available: true };
    fields[`rel_${key}`] = { get: (u) => playerRel(u, id), numeric: true, available: true };
    fields[`move_${key}`] = { get: (u) => playerMove(u, id), numeric: true, available: true };
  }
  playerFieldMap = fields;
  return fields;
}
export const playerFields = () => playerFieldMap || rebuildPlayerFields();

/* ------------------------------- help panel ------------------------------- */

/** The roster the syntax panel prints. Every name is checked against the live field map, so the panel can never claim a field the code does not have, and a row whose names are all absent simply disappears. */
const SCORE_HELP = [
  { names: ['artist', 'title'], what: 'artist or title of the map', example: 'title:"blossom of ashes"' },
  { names: ['diff', 'version'], what: 'difficulty name', example: 'diff:extra' },
  { names: ['creator', 'mapper'], what: 'difficulty author', example: 'mapper:gzdongsheng' },
  { names: ['key', 'keys'], what: 'key mode', example: 'key=4' },
  { names: ['od'], what: 'overall difficulty', example: 'od>=9' },
  { names: ['ln', 'lns'], what: 'share of holds in percent (0–100)', example: 'lns>90' },
  { names: ['ln_ratio'], what: 'the same share as a 0–1 fraction', example: 'ln_ratio<0.1' },
  { names: ['mod', 'mods'], what: 'mods the score carries; <code>mod=DT</code> matches “DT+MR”, <code>mod==DT</code> matches only DT', example: 'mod=DT' },
  { names: ['acc', 'accuracy'], what: 'accuracy in percent', example: 'acc>=99' },
  { names: ['n320', 'n300', 'n200', 'n100', 'n50', 'miss'], what: 'one judgement count', example: 'miss>0' },
  { names: ['pp'], what: 'pp of B under this algorithm', example: 'pp>500' },
  { names: ['rank'], what: 'rank of the score under B (1 = best)', example: 'rank<=10' },
  { names: ['delta'], what: 'B − A in pp', example: 'delta<-20' },
  { names: ['rel'], what: 'B against A in percent', example: 'rel>10' },
  { names: ['spread'], what: 'max − min pp over every algorithm', example: 'spread>100' },
  { names: ['star', 'stars', 'sr'], what: 'star rating (official osu! when the shard carries it)', example: 'star<7' },
  { names: ['score_id', 'map_id', 'set_id'], what: 'identifiers, compared as numbers', example: 'map_id=3525702' },
  { names: ['eff_star', 'l_share', 'w', 'coord_mod', 'acc_factor', 'nf_factor'], what: 'Reimagined internals', example: 'eff_star>7' },
];

const PLAYER_HELP = [
  { names: ['uid'], what: 'osu! user id', example: 'uid=21207706' },
  { names: ['username', 'user', 'name'], what: 'free text over usernames', example: 'username=shirasu-azusa' },
  { names: ['scores', 'score_count'], what: 'scores the dataset holds for that player', example: 'scores>=100' },
  { names: ['fixture'], what: 'the fixture the list came from', example: 'fixture=bp-lists' },
  { names: ['pp'], what: 'weighted total of B', example: 'pp>10000' },
  { names: ['rank'], what: 'rank under B (1 = the highest total)', example: 'rank<5' },
  { names: ['delta'], what: 'total minus A', example: 'delta<-500' },
  { names: ['rel'], what: 'total against A in percent', example: 'rel>5' },
  { names: ['move'], what: 'rank movement against A (positive = climbs)', example: 'move>3' },
];

/** One `<tr>` per roster row, keeping only the alias names this dataset actually has. */
function helpRows(rows, fields) {
  return rows.map((r) => {
    const names = r.names.filter((n) => fields[n]);
    return names.length ? rowCell(names, r.what, r.example) : '';
  }).join('');
}

/** One help row, with the aliases as separate <code> chips. */
export function rowCell(names, what, example) {
  return `<tr><td>${names.map((n) => `<code>${esc(n)}</code>`).join(', ')}</td><td>${what}</td><td><code>${esc(example)}</code></td></tr>`;
}

/** The syntax panel, rebuilt whenever the field maps or the A/B pair change. */
export function renderHelp() {
  const sf = scoreFields(), pf = playerFields();
  const algoNames = state.algoIds.map((id) => `pp_${id}`).filter((n) => sf[n]);
  const rankNames = state.algoIds.map((id) => `rank_${id}`).filter((n) => sf[n]);
  const starNames = Array.from(state.starKeys).map((x) => `star_${x}`).filter((n) => sf[n]);
  els.helpFields.innerHTML = helpRows(SCORE_HELP, sf)
    + (algoNames.length ? rowCell(algoNames, 'pp of a named algorithm', `pp_${state.algoIds[0]}>400`) : '')
    + (rankNames.length ? rowCell(rankNames, 'rank of the score under a named algorithm', 'rank_sunny<=10') : '')
    + (starNames.length ? rowCell(starNames, 'star rating of a named source', 'sr_rice<6') : '');
  const pr = state.algoIds.map((id) => `pp_${id}`).filter((n) => pf[n]);
  els.helpPlayerFields.innerHTML = helpRows(PLAYER_HELP, pf)
    + (pr.length ? rowCell(pr, 'weighted total of a named algorithm', `pp_${state.algoIds[0]}>10000`) : '');
  els.helpFieldsNote.innerHTML = `Free text matches artist, title, difficulty, mapper and the mods, and several terms are ANDed. <code>=</code> and <code>:</code> are fuzzy — a substring for text, “carries that mod” for <code>mod</code> — while <code>==</code> is exact, and <code>!=</code> <code>&lt;</code> <code>&gt;</code> <code>&lt;=</code> <code>&gt;=</code> are unchanged. A name that is not a field falls back to free text, so nothing is ever matched silently. The pair in play right now is A = ${esc(algoLabel(state.A))}, B = ${esc(algoLabel(state.B))}.`;
}

/** Example chips. The two quoted in the repository instructions are fixed; the rest are computed from the loaded shard so they always return rows. */
export function renderHelpExamples() {
  const examples = [
    { q: 'mod=DT key=4 star<7', why: 'rate-up 4K below 7 stars' },
    { q: 'mod==DT', why: 'DT and nothing else' },
    { q: 'lns>90', why: 'LN-heavy maps' },
  ];
  if (state.scores.length) {
    const mid = (vals, step) => {
      const m = median(vals);
      return m == null ? null : Math.round(m / step) * step;
    };
    const ln = mid(state.scores.map((s) => (s.ln == null ? null : s.ln * 100)), 10);
    const pp = mid(state.scores.map(ppB), 50);
    const sr = mid(state.scores.map(primaryStar), 0.5);
    const d = mid(state.scores.map(diffOf), 10);
    if (d != null) examples.push({ q: `delta<${d}`, why: `B costs more than ${-d} pp against A` });
    if (pp != null) examples.push({ q: `pp>${pp}`, why: 'the upper half of this list' });
    if (ln != null) examples.push({ q: `lns<${ln}`, why: 'the rice side of this list' });
    if (sr != null) examples.push({ q: `star<${sr.toFixed(1)}`, why: 'below the median star rating' });
  } else {
    examples.push({ q: 'delta<-20', why: 'B prices at least 20 pp below A' }, { q: 'pp>500', why: 'scores worth more than 500 pp' });
  }
  examples.push({ q: 'acc>=99 mod=NM', why: 'accurate no-mod scores' });
  els.helpExamples.innerHTML = examples.map((e) => `<li><button type="button" class="example" data-q="${esc(e.q)}" title="${esc(e.why)}">${esc(e.q)}</button> <span class="why">${esc(e.why)}</span></li>`).join('');
}

/** Chips write into whichever search box the current view owns. */
export function initHelpExamples(getInput) {
  els.helpExamples.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-q]');
    if (!btn) return;
    const input = getInput();
    if (!input) return;
    input.value = btn.dataset.q;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  });
}
