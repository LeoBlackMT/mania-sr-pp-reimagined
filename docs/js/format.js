/* ===========================================================================
 * format.js — numbers, strings, links and file output.
 *
 * Everything here is a pure function of its arguments (the download helper is the single exception, and it touches the DOM only to click a synthetic anchor), so this module can be imported from anywhere without creating a cycle.
 * Two conventions run through the whole page and are implemented here: an absent value prints "–" and never "NaN"/"undefined", and a value can never reach innerHTML without going through esc().
 * =========================================================================== */

/** Escape anything taken from JSON before it reaches innerHTML. */
const escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => escapeMap[c]);

/** Finite number, or null when absent or unparsable. Nulls print "–" and sort last. */
export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Fixed decimals, or "–". */
export const fmt = (v, d = 2) => (v == null ? '–' : Number(v).toFixed(d));
/** Rounded integer, or "–". */
export const fmtInt = (v) => (v == null ? '–' : String(Math.round(v)));
/** Grouped fixed decimals, for pp totals big enough to need separators. */
export const fmtG = (v, d = 1) => (v == null ? '–' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
/** A value that carries its own sign, so a positive difference is never read as a magnitude. */
export const signed = (v, d = 1) => (v == null ? '–' : (v > 0 ? '+' : '') + Number(v).toFixed(d));
/** A share as a signed percentage ("0.042" -> "+4.2%"). */
export const pct = (v, d = 1) => (v == null ? '–' : (v > 0 ? '+' : '') + (v * 100).toFixed(d) + '%');
/** A share as a plain percentage, for axes and captions. */
export const pctPlain = (v, d = 1) => (v == null ? '–' : (v * 100).toFixed(d) + '%');
/** "up" for a positive value, "down" for a negative one, "" otherwise — the CSS class that colours a delta. */
export const dirClass = (v) => (v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Trailing-edge debounce, used by the two search boxes so a keystroke does not re-sort a 20 000-row list. */
export function debounce(fn, ms) {
  let t = 0;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** "2026-09-13T10:40:33Z" -> "2026-09-13 10:40 UTC"; an unparsable input passes through unchanged. */
export function fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? String(iso) : d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

/** Median of the finite values; null when there is nothing to take a median of. */
export function median(values) {
  const clean = values.filter((v) => v != null && Number.isFinite(v));
  if (!clean.length) return null;
  const a = clean.slice().sort((x, y) => x - y), mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/** Quantile of a sorted copy, using the same nearest-rank rule the engine uses for its distribution block. */
export function quantile(values, p) {
  const clean = values.filter((v) => v != null && Number.isFinite(v)).sort((x, y) => x - y);
  if (!clean.length) return null;
  return clean[clamp(Math.round(p * (clean.length - 1)), 0, clean.length - 1)];
}

/* osu! links. A wrong or guessed link is worse than none, so each helper returns null unless every id it needs is present. */
export const mapUrl = (s) => (s.bid != null && s.sid != null ? `https://osu.ppy.sh/beatmapsets/${s.sid}#mania/${s.bid}` : null);
/** The short form needs one id only, and is what the dataset-level disagreement rows can afford. */
export const beatmapUrl = (bid) => (bid == null ? null : `https://osu.ppy.sh/b/${bid}`);
export const scoreUrl = (scid) => (scid == null ? null : `https://osu.ppy.sh/scores/${scid}`);
export const userUrl = (uid) => (uid == null ? null : `https://osu.ppy.sh/users/${uid}`);
/** A link when the URL exists, plain text otherwise — never a broken href. */
export const link = (url, text, extra = '') => (url ? `<a href="${esc(url)}"${extra}>${text}</a>` : `<span${extra}>${text}</span>`);
export const EXTERNAL = ' target="_blank" rel="noopener noreferrer"';

/* Score table cells. Declared here so the score table, the disagreement lists and the dataset view all render a figure the same way. */
export const cellNum = (v, d = 0) => `<td class="num">${v == null ? '–' : (d ? fmt(v, d) : fmtInt(v))}</td>`;
export const cellSigned = (v, d = 1) => `<td class="num ${dirClass(v)}">${signed(v, d)}</td>`;
export const cellPct = (v, d = 1) => `<td class="num ${dirClass(v)}">${pct(v, d)}</td>`;

/* ------------------------------------------------------------------- CSV -- */

/** One CSV cell: quoted only when it has to be. */
export const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const csvNum = (v, d = 3) => (v == null ? '' : Number(v).toFixed(d));

/** Hand a generated file to the browser. The BOM is what makes Excel read artist names correctly. */
export function downloadCsv(name, text) {
  const blob = new Blob([`\uFEFF${text}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Confirm an export on the button itself, then put the label back. */
export function flash(btn, text, restore) {
  btn.textContent = text;
  setTimeout(() => { btn.textContent = restore; }, 2200);
}
