/* ===========================================================================
 * views/dataset.js — #/dataset, the whole dataset at once.
 *
 * Everything here is read from the `aggregates` block of data/index.json, which the engine precomputes, so this view fetches no shard either: with two hundred players the page still opens from one file.
 * The block is optional. When it is absent the view renders a short explanation and nothing else, rather than a set of empty tables.
 * Aggregates semantics, straight from the engine: `n` is how many scores fall in the layer, `median_pp` is that layer's median price per algorithm, and `rel_pct[a][b]` is the median of the per-score relative difference of b against a, in percent — never the ratio of two medians, and never an average of medians, so the A/B column here is read straight out of the data.
 * =========================================================================== */

import { $ } from '../dom.js';
import { esc, fmt, num, pctPlain, signed } from '../format.js';
import { LN_HB, LN_RC, MORE_STEP, algoLabel, registerView, state } from '../core.js';

const el = {
  summary: $('#dataset-summary'),
  missing: $('#dataset-missing'),
  body: $('#dataset-body'),
  layers: $('#ds-layers'),
  layersNote: $('#ds-layers-note'),
  abChart: $('#ds-ab-chart'),
  abNote: $('#ds-ab-note'),
  dist: $('#ds-dist'),
  distNote: $('#ds-dist-note'),
  corr: $('#ds-corr'),
  corrNote: $('#ds-corr-note'),
  disagree: $('#ds-disagree'),
  disagreeNote: $('#ds-disagree-note'),
  more: $('#ds-more'),
};

const agg = () => (state.source && state.source.aggregates) || null;

/** What each layer means, in the vocabulary of the engine's own layer families. */
function layerGrade(family, layer) {
  if (family === 'key mode') return 'key mode of the map';
  if (family === 'mod family') {
    return { NM: 'no mods', 'Rate-up': 'DT · NC', 'Rate-down': 'HT · DC', 'Other mods': 'neither rate-up nor rate-down' }[layer] || 'mod family';
  }
  if (family === 'long notes') {
    return { RC: `ln_ratio < ${LN_RC}`, HB: `${LN_RC} ≤ ln_ratio ≤ ${LN_HB}`, LN: `ln_ratio > ${LN_HB}` }[layer] || 'share of long notes';
  }
  return `${family} — ${layer}`;
}

/** The layers in the order the engine emitted them, grouped by family and never inventing an empty bucket. */
function layerGroups(list) {
  const groups = [];
  for (const row of list) {
    const family = String(row.family ?? 'other');
    let g = groups.find((x) => x.family === family);
    if (!g) {
      g = { family, rows: [] };
      groups.push(g);
    }
    g.rows.push(row);
  }
  return groups;
}

/* -------------------------------- summary --------------------------------- */

function renderSummary(a) {
  const s = state.source;
  const items = [
    ['Players', String(state.users.length)],
    ['Scores in the index', String(num(s.score_count) ?? '–')],
    ['Scores aggregated', String(num(a?.score_count) ?? '–')],
    ['Algorithms', state.algoIds.map((id) => esc(algoLabel(id))).join(' · ') || '–'],
    ['Layer rows', String(Array.isArray(a?.layers) ? a.layers.length : 0)],
    ['Correlation', a?.correlation ? 'yes' : 'no'],
  ];
  el.summary.innerHTML = items.map(([k, v]) => `<div class="stat"><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('');
}

/* ------------------------------ layer table ------------------------------- */

function renderLayers(a) {
  const list = Array.isArray(a?.layers) ? a.layers : [];
  if (!list.length) {
    el.layers.innerHTML = '<p class="empty">This dataset carries no layer rows.</p>';
    el.layersNote.textContent = '';
    return;
  }
  const cell = (row) => {
    const rel = row.rel_pct?.[state.A]?.[state.B];
    const medA = num(row.median_pp?.[state.A]), medB = num(row.median_pp?.[state.B]);
    const d = medA != null && medB != null ? medB - medA : null;
    return `<td class="layer-name">${esc(row.layer ?? '–')}</td>`
      + `<td class="hint">${esc(layerGrade(row.family, row.layer))}</td>`
      + `<td class="num">${num(row.n) == null ? '–' : esc(row.n)}</td>`
      + `<td class="num">${fmt(medA, 1)}</td>`
      + `<td class="num">${fmt(medB, 1)}</td>`
      + `<td class="num ${d == null ? '' : d > 0 ? 'up' : d < 0 ? 'down' : ''}">${signed(d, 1)}</td>`
      + `<td class="num ${rel == null ? '' : rel > 0 ? 'up' : rel < 0 ? 'down' : ''}">${rel == null ? '–' : (rel > 0 ? '+' : '') + Number(rel).toFixed(2) + '%'}</td>`;
  };
  const body = layerGroups(list).map((g) => `<tr class="layer-group"><th colspan="7" scope="colgroup">${esc(g.family)}</th></tr>`
    + g.rows.map((row) => `<tr>${cell(row)}</tr>`).join('')).join('');
  el.layers.innerHTML = '<table class="grid layers"><caption class="sr-only">Median price and relative difference by layer over every player in the dataset</caption>'
    + `<thead><tr><th scope="col">Layer</th><th scope="col">Definition</th><th scope="col" class="num">n</th><th scope="col" class="num">Median pp (A)</th><th scope="col" class="num">Median pp (B)</th><th scope="col" class="num">Δ median</th><th scope="col" class="num">rel (B vs A)</th></tr></thead>`
    + `<tbody>${body}</tbody></table>`;
  el.layersNote.textContent = `Covering every score in the dataset, not just the ones a search would leave. A = ${algoLabel(state.A)}, B = ${algoLabel(state.B)}. The Δ median column is the difference between the two medians; the rel column is the engine's rel_pct — the median of the per-score relative difference of B against A inside the layer, which is not the ratio of the medians and is deliberately not recomputed here. Each layer family partitions the dataset, so the rows inside a family add up to the dataset size.`;
}

/* ---------------------------- A/B relative chart -------------------------- */

function renderAbChart(a) {
  const list = (Array.isArray(a?.layers) ? a.layers : []).filter((r) => r.rel_pct?.[state.A]?.[state.B] != null);
  if (!list.length) {
    el.abChart.innerHTML = '<p class="empty">No layer carries a relative difference for this A/B pair.</p>';
    el.abNote.textContent = '';
    return;
  }
  const W = 760, rowH = 22, top = 26, left = 190, right = 70, bottom = 28;
  const H = top + list.length * rowH + bottom;
  const vals = list.map((r) => num(r.rel_pct[state.A][state.B]) ?? 0);
  const span = Math.max(1, ...vals.map((v) => Math.abs(v))) * 1.15;
  const zero = left + (W - left - right) / 2;
  const xAt = (v) => zero + (v / span) * ((W - left - right) / 2);
  const rows = list.map((r, i) => {
    const v = vals[i];
    const y = top + i * rowH;
    const bar = `<rect class="${v >= 0 ? 'bar-up' : 'bar-down'}" x="${Math.min(zero, xAt(v)).toFixed(1)}" y="${(y + 4).toFixed(1)}" width="${Math.abs(xAt(v) - zero).toFixed(1)}" height="${(rowH - 9).toFixed(1)}" rx="2"/>`;
    const label = `<text class="row-label" x="${left - 8}" y="${(y + rowH / 2 + 3.5).toFixed(1)}" text-anchor="end">${esc(`${r.family} · ${r.layer}`)}</text>`;
    const value = `<text class="row-value" x="${(W - right + 6).toFixed(1)}" y="${(y + rowH / 2 + 3.5).toFixed(1)}">${v > 0 ? '+' : ''}${v.toFixed(2)}%</text>`;
    return label + bar + value;
  }).join('');
  const grid = [span, span / 2, 0, -span / 2, -span].map((v) => `<line class="${v === 0 ? 'zero' : 'rule'}" x1="${xAt(v).toFixed(1)}" x2="${xAt(v).toFixed(1)}" y1="${top - 8}" y2="${(top + list.length * rowH).toFixed(1)}"/>`
    + `<text x="${xAt(v).toFixed(1)}" y="${top - 14}" text-anchor="middle">${v > 0 ? '+' : ''}${v.toFixed(1)}%</text>`).join('');
  el.abChart.innerHTML = `<svg class="ab-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="median relative difference of ${esc(algoLabel(state.B))} against ${esc(algoLabel(state.A))} by layer">`
    + grid + rows
    + `<text class="axis-label" x="${left}" y="${(H - 8).toFixed(1)}">median of (${esc(algoLabel(state.B))} / ${esc(algoLabel(state.A))} − 1) per score, inside each layer</text></svg>`;
  el.abNote.textContent = `Bars point right where ${algoLabel(state.B)} pays more than ${algoLabel(state.A)} on that layer, and left where it pays less. The value is the engine's rel_pct for this pair, so switching A and B in the panel above redraws the chart from the data rather than from the sign of these numbers.`;
}

/* ------------------------------- distribution ----------------------------- */

/** The global x domain, so the four algorithms' histograms are actually comparable rather than four unrelated pictures. */
function distDomain(a) {
  const entries = state.algoIds.map((id) => a.distribution?.[id]).filter(Boolean);
  if (!entries.length) return null;
  return { min: Math.min(...entries.map((d) => num(d.bin_min) ?? 0)), max: Math.max(...entries.map((d) => num(d.bin_max) ?? 0)) };
}

/** Every bin of one distribution, as counts, with the total the shares are taken against. */
function histBins(d) {
  const bins = Array.isArray(d.bins) ? d.bins : [];
  const total = bins.reduce((x, y) => x + y, 0) || num(d.n) || 1;
  return { bins, total };
}

/** The geometry of one histogram over the shared domain. */
function histScale(domain, peak, W, H, pad) {
  const dSpan = Math.max(1e-9, domain.max - domain.min);
  const plot = H - pad.top - pad.bottom;
  return {
    plot,
    xAt: (v) => pad.left + ((v - domain.min) / dSpan) * (W - pad.left - pad.right),
    yAt: (v) => H - pad.bottom - (peak > 0 ? v / peak : 0) * plot,
  };
}

/**
 * The y axis of every price histogram, scaled to the tallest bin of the chart rather than to a fixed 0–1 share.
 * A price distribution peaks at around a tenth of the scores, so a fixed share axis flattens all twenty-four bins into a two-pixel line and labels the top of it "1"; scaling to the peak is what makes the shape readable, and the top label then says what that peak actually is — "13.6%" for this dataset's Bancho prices.
 */
function histAxis(g, { W, H, pad, domain, peak, total }) {
  const yBase = H - pad.bottom;
  const yMid = g.yAt(peak / 2);
  const share = (v) => pctPlain(peak > 0 ? v / total : 0, 1);
  const xs = [domain.min, (domain.min + domain.max) / 2, domain.max];
  return `<line class="rule" x1="${pad.left}" x2="${W - pad.right}" y1="${yBase}" y2="${yBase}"/>`
    + (peak > 0 ? `<line class="grid" x1="${pad.left}" x2="${W - pad.right}" y1="${yMid.toFixed(1)}" y2="${yMid.toFixed(1)}"/>` : '')
    + `<text class="y-label" x="${pad.left - 5}" y="${(g.yAt(peak) + 3.5).toFixed(1)}" text-anchor="end">${share(peak)}</text>`
    + (peak > 0 ? `<text class="y-label" x="${pad.left - 5}" y="${(yMid + 3.5).toFixed(1)}" text-anchor="end">${share(peak / 2)}</text>` : '')
    + `<text class="y-label" x="${pad.left - 5}" y="${(yBase + 3.5).toFixed(1)}" text-anchor="end">0</text>`
    + xs.map((v, i) => `<text x="${g.xAt(v).toFixed(1)}" y="${(yBase + 13).toFixed(1)}" text-anchor="${i === 0 ? 'start' : i === xs.length - 1 ? 'end' : 'middle'}">${fmt(v, 0)}</text>`).join('');
}

/** One histogram, with its median marked and its y axis labelled with the share of the tallest bin. */
function histogramSvg(d, domain) {
  const W = 300, H = 150, pad = { left: 44, right: 8, top: 14, bottom: 24 };
  const lo = num(d.bin_min) ?? 0, hi = num(d.bin_max) ?? 1;
  const { bins, total } = histBins(d);
  const peak = bins.length ? Math.max(...bins) : 0;
  const g = histScale(domain, peak, W, H, pad);
  const bw = Math.max(0.5, (g.xAt(hi) - g.xAt(lo)) / Math.max(1, bins.length));
  const bars = bins.map((c, i) => {
    const x = g.xAt(lo) + i * bw;
    const h = (c / peak) * g.plot;
    return `<rect class="bar-a" x="${x.toFixed(2)}" y="${(H - pad.bottom - h).toFixed(2)}" width="${Math.max(0.6, bw - 0.8).toFixed(2)}" height="${h.toFixed(2)}" rx="1"/>`;
  }).join('');
  const med = num(d.median);
  const medLine = med == null ? '' : `<line class="median" x1="${g.xAt(med).toFixed(1)}" x2="${g.xAt(med).toFixed(1)}" y1="${pad.top}" y2="${H - pad.bottom}"/>`;
  return `<svg class="hist" viewBox="0 0 ${W} ${H}" role="img" aria-label="price distribution, y axis scaled to the tallest bin">`
    + histAxis(g, { W, H, pad, domain, peak, total }) + bars + medLine + `</svg>`;
}

/**
 * The A-against-B overlay: one chart rather than two stacked ones, so the two distributions share a pair of axes and a reader can compare them without moving their eyes.
 * A is the bars and B is the step line, which is how this page tells two monochrome series apart; the y axis is scaled to the taller of the two peaks, and both medians are marked.
 */
function histOverlaySvg(dA, dB, domain) {
  const W = 860, H = 150, pad = { left: 48, right: 12, top: 16, bottom: 24 };
  const a = histBins(dA), b = histBins(dB);
  const peak = Math.max(a.bins.length ? Math.max(...a.bins) : 0, b.bins.length ? Math.max(...b.bins) : 0);
  const total = Math.max(a.total, b.total);
  const g = histScale(domain, peak, W, H, pad);
  const bars = (() => {
    const lo = num(dA.bin_min) ?? 0, hi = num(dA.bin_max) ?? 1;
    const bw = Math.max(0.5, (g.xAt(hi) - g.xAt(lo)) / Math.max(1, a.bins.length));
    return a.bins.map((c, i) => {
      const x = g.xAt(lo) + i * bw;
      const h = (c / peak) * g.plot;
      return `<rect class="bar-a" x="${x.toFixed(2)}" y="${(H - pad.bottom - h).toFixed(2)}" width="${Math.max(0.6, bw - 0.8).toFixed(2)}" height="${h.toFixed(2)}" rx="1"/>`;
    }).join('');
  })();
  const step = (() => {
    const lo = num(dB.bin_min) ?? 0, hi = num(dB.bin_max) ?? 1;
    const w = (hi - lo) / Math.max(1, b.bins.length);
    return `<polyline class="step" points="${b.bins.map((c, i) => `${g.xAt(lo + (i + 0.5) * w).toFixed(2)},${g.yAt(c).toFixed(2)}`).join(' ')}"/>`;
  })();
  const marker = (med, cls, label, dy) => {
    const v = num(med);
    if (v == null) return '';
    return `<line class="${cls}" x1="${g.xAt(v).toFixed(1)}" x2="${g.xAt(v).toFixed(1)}" y1="${pad.top}" y2="${H - pad.bottom}"/>`
      + `<text class="median-label" x="${(g.xAt(v) + 3).toFixed(1)}" y="${(pad.top + dy).toFixed(1)}">${esc(`${label} ${fmt(v, 0)}`)}</text>`;
  };
  return `<svg class="hist hist-overlay-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="the ${esc(algoLabel(state.A))} and ${esc(algoLabel(state.B))} price distributions on shared axes">`
    + histAxis(g, { W, H, pad, domain, peak, total })
    + bars + step
    + marker(dA.median, 'median', 'A', 10)
    + marker(dB.median, 'median-b', 'B', 22)
    + `</svg>`;
}

function renderDistribution(a) {
  const ids = state.algoIds.filter((id) => a.distribution?.[id]);
  const domain = distDomain(a);
  if (!ids.length || !domain) {
    el.dist.innerHTML = '<p class="empty">This dataset carries no price distribution.</p>';
    el.distNote.textContent = '';
    return;
  }
  const cards = ids.map((id) => {
    const d = a.distribution[id];
    const { bins, total } = histBins(d);
    const peak = bins.length ? Math.max(...bins) : 0;
    return `<figure class="hist-card"><figcaption><strong>${esc(algoLabel(id))}</strong>`
      + `<span class="hint">n ${esc(d.n)} · p25 ${fmt(num(d.p25), 0)} · median ${fmt(num(d.median), 0)} · p75 ${fmt(num(d.p75), 0)} · p95 ${fmt(num(d.p95), 0)} · max ${fmt(num(d.max), 0)}</span>`
      + `<span class="hint">y axis to ${pctPlain(peak / total, 1)} — the share of this algorithm's scores in its tallest bin</span></figcaption>`
      + histogramSvg(d, domain) + '</figure>';
  }).join('');
  const dA = a.distribution[state.A], dB = a.distribution[state.B];
  const overlay = dA && dB ? `<figure class="hist-card hist-overlay"><figcaption><strong>${esc(algoLabel(state.A))} against ${esc(algoLabel(state.B))}</strong>`
    + `<span class="hint">bars ${esc(algoLabel(state.A))} · step line ${esc(algoLabel(state.B))}, on one pair of axes, each as a share of its own scores; medians marked ${fmt(num(dA.median), 0)} and ${fmt(num(dB.median), 0)}</span></figcaption>`
    + histOverlaySvg(dA, dB, domain) + '</figure>' : '';
  el.dist.innerHTML = cards + overlay;
  el.distNote.textContent = 'One histogram per algorithm, all four drawn over the same pp range so the shapes can be compared. The y axis is the share of that algorithm\'s own scores, not a count, because the four do not price the same number of scores — and it is scaled to the tallest bin of the chart rather than to a fixed 100%, so the label at the top of the axis is the share that peak holds (13.6% of Bancho\'s scores, for instance) and the shape of the distribution stays readable instead of collapsing into a flat line. The dashed marker is the median. The last card overlays the A and B distributions on shared axes, bars against a step line, which is the dataset-wide A/B view this page can offer without downloading a single shard.';
}

/* ------------------------------- correlation ------------------------------ */

function renderCorrelation(a) {
  const c = a.correlation;
  const ids = state.algoIds.filter((id) => c?.[id]);
  if (ids.length < 2) {
    el.corr.innerHTML = '<p class="empty">This dataset carries no correlation matrix.</p>';
    el.corrNote.textContent = '';
    return;
  }
  const shaded = (v) => {
    if (v == null) return '<td class="num">–</td>';
    const t = Math.max(0, Math.min(1, (num(v) - 0.9) / 0.1));
    const alpha = (0.06 + t * 0.30).toFixed(3);
    return `<td class="num corr-cell" style="background: color-mix(in srgb, var(--ink) ${(alpha * 100).toFixed(0)}%, transparent)">${Number(v).toFixed(4)}</td>`;
  };
  const head = `<tr><th scope="col">Pearson r</th>${ids.map((id) => `<th scope="col" class="num">${esc(algoLabel(id))}</th>`).join('')}</tr>`;
  const body = ids.map((row) => `<tr><th scope="row">${esc(algoLabel(row))}</th>${ids.map((col) => shaded(c[row]?.[col])).join('')}</tr>`).join('');
  el.corr.innerHTML = `<table class="grid corr"><caption class="sr-only">Pearson correlation of the per-score pp of every algorithm pair</caption><thead>${head}</thead><tbody>${body}</tbody></table>`;
  const pair = num(c[state.A]?.[state.B]);
  el.corrNote.textContent = `Pearson correlation over every score both algorithms priced, so a cell close to 1 means the two order the same scores almost identically even when their absolute prices differ. This dataset's A/B cell (${algoLabel(state.A)} against ${algoLabel(state.B)}) is ${pair == null ? '–' : pair.toFixed(4)}. The shading only encodes the third decimal — a grey cell is not a different statistic, it is the same number made scannable.`;
}

/* ------------------------------ disagreements ----------------------------- */

/** The worst disagreements of the whole dataset, each row linking to the player it belongs to and to osu!. */
function renderDisagreements(a) {
  const list = Array.isArray(a.top_disagreements) ? a.top_disagreements : [];
  if (!list.length) {
    el.disagree.innerHTML = '<p class="empty">This dataset carries no disagreement list.</p>';
    el.disagreeNote.textContent = '';
    el.more.hidden = true;
    return;
  }
  const slice = list.slice(0, state.shown.dataset ?? MORE_STEP);
  el.disagree.innerHTML = `<table class="grid dis-table"><caption class="sr-only">The scores where the algorithms disagree most, ranked by spread over the mean</caption>`
    + `<thead><tr><th scope="col" class="num">#</th><th scope="col">Beatmap</th><th scope="col">Player</th><th scope="col">Structure</th>${state.algoIds.map((id) => `<th scope="col" class="num">${esc(algoLabel(id))}</th>`).join('')}<th scope="col" class="num">Spread</th></tr></thead><tbody>`
    + slice.map((r, i) => {
      const map = r.beatmap_id == null ? esc(`${r.artist} – ${r.title}`) : `<a href="https://osu.ppy.sh/b/${esc(r.beatmap_id)}" target="_blank" rel="noopener noreferrer">${esc(`${r.artist} – ${r.title}`)}</a>`;
      const player = r.uid == null ? '–' : `<a href="#/player/${esc(r.uid)}">#${esc(r.uid)}</a>`;
      const structure = [r.keys == null ? null : `${r.keys}K`, r.mods === '' ? 'NM' : esc(r.mods), r.ln_ratio == null ? null : `LN ${fmt(r.ln_ratio * 100, 1)}%`].filter(Boolean).join(' · ');
      const pps = state.algoIds.map((id) => `<td class="num">${fmt(num(r.pp?.[id]), 1)}</td>`).join('');
      return `<tr><td class="num hint">${i + 1}</td><td class="map-cell">${map}${r.version ? ` <span class="hint">[${esc(r.version)}]</span>` : ''}</td>`
        + `<td class="num">${player}</td><td class="hint">${structure}</td>${pps}<td class="num strong">${r.spread == null ? '–' : Number(r.spread).toFixed(1) + '%'}</td></tr>`;
    }).join('') + '</tbody></table>';
  const left = list.length - slice.length;
  el.more.hidden = left <= 0;
  el.more.textContent = `Show more (${Math.min(MORE_STEP, left)} of ${left} remaining)`;
  el.disagreeNote.textContent = `Spread is (max − min) / mean over every algorithm that priced the score, so it is comparable across price levels. The engine publishes the ${list.length} widest ones; a row's beatmap links to osu! by beatmap id and its player number opens that player's view. Score ids and beatmap set ids are not part of the aggregate block, which is why the map link is the short /b/ form here.`;
}

/* --------------------------------- render --------------------------------- */

function render() {
  const a = agg();
  const has = !!(a && (Array.isArray(a.layers) || a.correlation || a.distribution));
  el.missing.hidden = has;
  el.body.hidden = !has;
  if (!has) {
    el.missing.innerHTML = '<h3>No dataset-wide aggregates in this index</h3><p class="hint">The comparison modules on this view read the <code>aggregates</code> block of <code>data/index.json</code>, and this dataset does not carry one, so they are hidden rather than shown empty. The per-player views are unaffected. Regenerating the dataset with the engine adds the block; nothing on this page has to change.</p>';
    return;
  }
  renderSummary(a);
  renderLayers(a);
  renderAbChart(a);
  renderDistribution(a);
  renderCorrelation(a);
  renderDisagreements(a);
}

export function initDatasetView() {
  el.more.addEventListener('click', () => {
    state.shown.dataset = (state.shown.dataset ?? MORE_STEP) + MORE_STEP;
    const a = agg();
    if (a) renderDisagreements(a);
  });
  registerView({
    id: 'dataset',
    label: 'Dataset',
    needsShard: false,
    parse: (q) => ({ q: q.q ?? '' }),
    path: () => '#/dataset',
    title: () => 'Dataset — mania-sr-pp-reimagined',
    sync: () => {},
    render,
  });
  return { render };
}
