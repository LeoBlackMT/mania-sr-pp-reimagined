/* ===========================================================================
 * views/calc.js — #/calc, the in-browser calculator.
 *
 * The engine of this repository ships as a WebAssembly module, so a visitor can price a score the page is unable to fetch: osu!'s score pages and `.osu` endpoints send no `Access-Control-Allow-Origin` header, so no static page can pull a score or a beatmap by id (see the FAQ in docs/usage.md). What the page *can* do is compute, and this view does exactly that with the same crate that produced `data/players/*.json`.
 *
 * Three decisions worth keeping:
 *   1. THE MODULE IS LOADED LAZILY. `docs/wasm/mania_pp_wasm_bg.wasm` is ~660 KB; a visitor who never opens this view never downloads it, and the import only happens on the first keystroke or file drop here.
 *   2. ONE Calculator PER (map, mods). Preparation — parsing the map and running both difficulty passes — costs tens of milliseconds, while pricing is microseconds, so counts can be edited freely without reparsing. `preparedFor` tracks which inputs the cached instance belongs to.
 *   3. ERRORS ARE SHOWN, NOT SWALLOWED. A malformed `.osu`, an unknown mod acronym or a failed module load all land in the panel above the results, because a silent "no number" is the one outcome that would be worse than a red message.
 * =========================================================================== */

import { $, $$ } from '../dom.js';
import { esc, fmt, fmtInt, num } from '../format.js';
import { registerView, state } from '../core.js';

const el = {
  status: $('#calc-engine-status'),
  pick: $('#calc-pick'),
  file: $('#calc-file'),
  drop: $('#calc-drop'),
  dropText: $('#calc-drop-text'),
  osu: $('#calc-osu'),
  mods: $('#calc-mods'),
  chips: $('#calc-mod-chips'),
  generation: $('#calc-generation'),
  counts: $('#calc-counts'),
  countNote: $('#calc-count-note'),
  error: $('#calc-error'),
  errorText: $('#calc-error-text'),
  body: $('#calc-body'),
  cards: $('#calc-cards'),
  resultNote: $('#calc-result-note'),
  detail: $('#calc-detail'),
};

/** The judgement kinds, in the order every other view lists them. */
const COUNT_FIELDS = [
  { key: 'n320', label: '320', hint: 'perfect' },
  { key: 'n300', label: '300', hint: 'great' },
  { key: 'n200', label: '200', hint: 'good' },
  { key: 'n100', label: '100', hint: 'ok' },
  { key: 'n50', label: '50', hint: 'meh' },
  { key: 'miss', label: 'miss', hint: 'miss' },
];

/** Chips that cover the mods a mania score realistically carries. */
const MOD_CHIPS = ['NM', 'DT', 'HT', 'NC', 'MR', 'HD', 'EZ', 'NF', 'DT+MR'];

const view = { osu: '', mods: '', counts: {}, lazer: true };

let modulePromise = null;   // the wasm module, once
let instance = null;        // Calculator for the current (osu, mods)
let instanceKey = '';       // what `instance` was built from
let timer = null;           // debounce for the recompute

/* --------------------------- 1 loading the engine ------------------------- */

async function loadEngine() {
  if (!modulePromise) {
    el.status.textContent = 'loading the engine…';
    modulePromise = import('../../wasm/mania_pp_wasm.js')
      .then(async (wasm) => {
        await wasm.default();
        el.status.innerHTML = `engine ready · <code>${esc(wasm.version())}</code> · rosu-pp <code>${esc(wasm.rosu_pp_rev())}</code>`;
        return wasm;
      })
      .catch((err) => {
        modulePromise = null;
        throw new Error(`the WebAssembly engine did not load (${err && err.message ? err.message : err}). It is served from docs/wasm/; opening this page straight from the filesystem blocks ES module imports, so serve it over HTTP instead.`);
      });
  }
  return modulePromise;
}

function calculatorFor(wasm, osuText, mods) {
  const key = `${mods}\u0000${osuText.length}\u0000${osuText.slice(0, 200)}`;
  if (instance && key === instanceKey) return instance;
  instance = new wasm.Calculator(osuText, mods);
  instanceKey = key;
  return instance;
}

/* ------------------------------ 2 the controls ---------------------------- */

function buildControls() {
  el.counts.innerHTML = COUNT_FIELDS.map((f) => `<label class="count-field"><span>${esc(f.label)}</span><input type="number" min="0" step="1" value="0" id="calc-${f.key}" aria-label="${esc(f.hint)} count"><span class="count-hint">${esc(f.hint)}</span></label>`).join('');
  el.chips.innerHTML = MOD_CHIPS.map((m) => `<button type="button" data-mod="${esc(m)}">${esc(m)}</button>`).join('');
  for (const f of COUNT_FIELDS) view.counts[f.key] = 0;

  el.generation.addEventListener('change', () => {
    view.lazer = el.generation.checked;
    instance = null;   // the generation changes the price, not the preparation, but the cache key has to follow
    schedule();
  });

  el.mods.addEventListener('input', () => {
    view.mods = el.mods.value.trim();
    schedule();
  });
  el.chips.addEventListener('click', (ev) => {
    const button = ev.target.closest('button[data-mod]');
    if (!button) return;
    const mod = button.dataset.mod;
    el.mods.value = mod === 'NM' ? '' : mod;
    view.mods = el.mods.value.trim();
    schedule();
  });
  for (const f of COUNT_FIELDS) {
    const input = $(`#calc-${f.key}`);
    input.addEventListener('input', () => {
      view.counts[f.key] = Math.max(0, Math.trunc(num(input.value) ?? 0));
      schedule();
    });
  }
  el.osu.addEventListener('input', () => {
    view.osu = el.osu.value;
    schedule();
  });

  const takeFile = async (file) => {
    if (!file) return;
    view.osu = await file.text();
    el.osu.value = view.osu;
    el.dropText.innerHTML = `<code>${esc(file.name)}</code> loaded — ${fmt(view.osu.length)} characters`;
    schedule();
  };
  el.pick.addEventListener('click', () => el.file.click());
  el.file.addEventListener('change', (ev) => {
    takeFile(ev.target.files && ev.target.files[0]);
    ev.target.value = '';
  });
  el.drop.addEventListener('click', () => el.file.click());
  el.drop.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      el.file.click();
    }
  });
  // The page-wide drop handler treats a dropped file as a dataset, so this view stops the event before it escapes.
  for (const type of ['dragenter', 'dragover', 'drop']) {
    el.drop.addEventListener(type, (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      el.drop.classList.toggle('over', type !== 'drop');
      if (type === 'drop' && ev.dataTransfer) takeFile(ev.dataTransfer.files && ev.dataTransfer.files[0]);
    });
  }
  for (const type of ['dragleave', 'dragend']) {
    el.drop.addEventListener(type, () => el.drop.classList.remove('over'));
  }
}

/* ------------------------------ 3 the compute ----------------------------- */

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(compute, 250);
}

async function compute() {
  if (!view.osu.trim()) {
    el.body.hidden = true;
    el.error.hidden = true;
    return;
  }
  try {
    const wasm = await loadEngine();
    const calc = calculatorFor(wasm, view.osu, view.mods);
    calc.set_lazer(view.lazer);
    const counts = COUNT_FIELDS.map((f) => view.counts[f.key]);
    const result = JSON.parse(calc.price(...counts));
    el.error.hidden = true;
    el.body.hidden = false;
    renderResult(result, counts, calc.objects);
  } catch (err) {
    el.body.hidden = true;
    el.error.hidden = false;
    el.errorText.textContent = err && err.message ? err.message : String(err);
  }
}

/* ------------------------------ 4 the render ------------------------------ */

function renderResult(result, counts, objects) {
  const byId = new Map(result.algorithms.map((a) => [a.id, a.pp]));
  const known = state.algoIds.filter((id) => byId.has(id));
  const baseline = known.includes(state.B) ? byId.get(state.B) : null;

  el.cards.innerHTML = known.map((id) => {
    const pp = byId.get(id);
    const meta = state.algoMeta.get(id) || { label: id, description: '' };
    const rel = baseline && pp != null && baseline > 0 ? (pp / baseline - 1) * 100 : null;
    return `<article class="card"><div class="card-name">${esc(meta.label)}${rel == null || id === state.B ? '' : ` <span class="badge">${rel >= 0 ? '+' : ''}${rel.toFixed(2)}%</span>`}</div><p class="card-desc">${pp == null ? '–' : `<strong>${fmt(pp)}</strong> pp`}</p></article>`;
  }).join('');

  const map = result.map;
  const detail = result.detail;
  const rows = [
    ['Map', `${esc(map.artist)} – ${esc(map.title)} <span class="ver">[${esc(map.version)}]</span>`],
    ['Mapper', esc(map.mapper || '–')],
    ['Key mode', `${fmtInt(map.keys)}K`],
    ['OD / HP', `${fmt(map.od, 1)} / ${fmt(map.hp, 1)}`],
    ['Mods', esc(map.mods || 'NM')],
    ['Objects', `${fmtInt(objects)} objects · ${fmtInt(map.holds)} holds (${(map.ln_ratio * 100).toFixed(1)}% of the map)`],
    ['★ Bancho', fmt(map.star_bancho)],
    ['★ Sunny (full)', fmt(map.star_sunny)],
    ['★ Sunny (rice)', fmt(map.star_rice)],
  ];
  const internals = [
    ['Effective star', fmt(detail.eff_star)],
    ['Coordination weight w', fmt(detail.w)],
    ['Cross-column modulation', fmt(detail.coord_mod)],
    ['L share of the star', `${(detail.l_share * 100).toFixed(2)}%`],
    ['Accuracy factor', fmt(detail.acc_factor)],
    ['No-Fail factor', fmt(detail.nf_factor)],
  ];
  el.detail.innerHTML = `<section><h4 class="eyebrow">The map</h4><dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl></section><section><h4 class="eyebrow">Score</h4><dl>${COUNT_FIELDS.map((f, i) => `<dt>${esc(f.label)}</dt><dd>${fmtInt(counts[i])}</dd>`).join('')}</dl></section><section><h4 class="eyebrow">Reimagined internals</h4><dl>${internals.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl></section>`;

  const sum = counts.reduce((a, b) => a + b, 0);
  const withTails = objects + map.holds;
  // A mania play judges each note once and each hold twice — its head and its tail — so a score's counts add up to the object count or to the object count plus the holds, depending on how the score's statistics were recorded; osu!'s own accuracy uses that larger denominator.
  const note = sum === objects
    ? `${fmtInt(sum)} judgements, matching the map's ${fmtInt(objects)} objects.`
    : sum === withTails
      ? `${fmtInt(sum)} judgements: the map's ${fmtInt(objects)} objects plus its ${fmtInt(map.holds)} holds, both ends of a hold being judged separately — the same denominator osu! uses for such a score.`
      : `${fmtInt(sum)} judgements against ${fmtInt(objects)} objects (or ${fmtInt(withTails)} for a score that judges both ends of every hold) — ${sum > withTails ? `${fmtInt(sum - withTails)} too many` : `${fmtInt(objects - sum)} short of the plain object count`}. Every algorithm still prices the counts as given, exactly as the dataset does for a score whose counts do not add up.`;
  el.resultNote.textContent = note;
  el.countNote.textContent = note;
}

/* ------------------------------- 5 the view ------------------------------- */

export function initCalcView() {
  buildControls();
  registerView({
    id: 'calc',
    label: 'Calculator',
    needsData: false,
    parse: (query) => ({ mods: typeof query.mods === 'string' ? query.mods : '' }),
    path: () => '#/calc',
    title: () => 'Calculator — mania-sr-pp-reimagined',
    sync: (v) => {
      if (!v || typeof v.mods !== 'string') return;
      if (v.mods !== el.mods.value) el.mods.value = v.mods;
      view.mods = el.mods.value.trim();
    },
    render: () => {
      if (view.osu.trim() && !el.body.hidden) return;   // already priced; a re-render must not wipe a result
      if (view.osu.trim()) compute();
    },
  });
  return { id: 'calc' };
}

/** Exposed for the smoke test in web.md: price one map and hand back the JSON. */
export async function priceOnce(osuText, mods, counts) {
  const wasm = await loadEngine();
  const calc = new wasm.Calculator(osuText, mods);
  return JSON.parse(calc.price(...counts));
}
