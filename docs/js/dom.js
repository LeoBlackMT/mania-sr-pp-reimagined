/* ===========================================================================
 * dom.js — element lookup for the page shell.
 *
 * Every module is an ES module, so all of them run after the document has been parsed: querying the DOM at module scope is safe and there is no `DOMContentLoaded` dance anywhere in this site.
 * This module owns the two query helpers and the references to the shell elements that more than one module needs (the header, the nav slot, the loader, the algorithm legend and its A/B pair, the provenance footer).
 * View-specific elements are queried by the view that owns them, so a view can be deleted without leaving dead lookups behind.
 * It imports nothing, which is what keeps the module graph acyclic: dom.js ← format.js ← core.js ← search.js ← views ← main.js.
 * =========================================================================== */

/** First match, or null. */
export const $ = (sel, root = document) => root.querySelector(sel);

/** Every match, as a real array so it can be mapped and filtered. */
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** The `<section class="view">` element of a registered view, by its route id. */
export const viewSection = (id) => document.getElementById(`view-${id}`);

/** The element map for the shell. Ids are declared once in index.html and read once here. */
export const els = {
  html: document.documentElement,
  meta: $('#meta'),
  note: $('#source-note'),
  legend: $('#legend'),
  legendCards: $('#legend-cards'),
  navLinks: $('#nav-links'),
  prov: $('#prov'),
  main: $('#main'),
  help: $('#help'),
  helpFields: $('#help-fields'),
  helpPlayerFields: $('#help-player-fields'),
  helpFieldsNote: $('#help-fields-note'),
  helpExamples: $('#help-examples'),
  themeBtn: $('#theme-toggle'),
  themeLabel: $('#theme-label'),
  themeIcon: $('#theme-icon'),
  loadOpen: $('#load-open'),
  fileInput: $('#file-input'),
  loader: $('#loader'),
  loaderWhy: $('#loader-why'),
  loaderHint: $('#loader-hint'),
  loaderCmd: $('#loader-cmd'),
  loaderErr: $('#loader-err'),
  loaderBrowse: $('#loader-browse'),
  drop: $('#drop'),
  dragHint: $('#drag-hint'),
  algoA: $('#algo-a'),
  algoB: $('#algo-b'),
  swapAB: $('#swap-ab'),
  pairNote: $('#pair-note'),
};
