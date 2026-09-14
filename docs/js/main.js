/* ===========================================================================
 * main.js — the entry point: build the views, wire the events that belong to the whole page, then load the index.
 *
 * This is the only module index.html loads directly; everything else hangs off it. It does four things and nothing else.
 *   1. Registers the views. The rankings, the player and the dataset view each register a descriptor with core.registerView(), which is what fills the nav slot and what the router resolves a hash against; a fourth view is one more init call here.
 *   2. Keeps the search field maps in step with the data. Fields depend on the dataset (which algorithms, which star columns, whether the shard carries a mapper), so they are rebuilt whenever core reports a data change.
 *   3. Wires the page-wide events: the hash, the keyboard, drag & drop, the file picker and the A/B pair. Table clicks, paging and exports belong to the views that own those tables.
 *   4. Loads data/index.json and lets the router decide what to draw.
 * =========================================================================== */

import { els } from './dom.js';
import { applyRoute, boot, buildNav, initPairControls, onDataChanged, readFile, state } from './core.js';
import { initHelpExamples, rebuildPlayerFields, rebuildScoreFields, renderHelp, renderHelpExamples } from './search.js';
import { initTheme } from './theme.js';
import { initPlayersView } from './views/players.js';
import { initPlayerView } from './views/player.js';
import { initCalcView } from './views/calc.js';
import { initDatasetView } from './views/dataset.js';

/* ------------------------------ 1 the views ------------------------------- */

const players = initPlayersView();
const playerView = initPlayerView();
initDatasetView();
initCalcView();
buildNav();

/** The view the hash resolved to, when it owns a search box. */
const activeView = () => (state.spec?.id === 'players' ? players : state.spec?.id === 'player' ? playerView : null);

/* --------------------------- 2 fields and help ---------------------------- */

onDataChanged(() => {
  rebuildPlayerFields();
  rebuildScoreFields();
  renderHelp();
  renderHelpExamples();
  players.invalidate();
  playerView.invalidate();
});

/* ------------------------------- 3 events --------------------------------- */

initTheme();
initPairControls();
initHelpExamples(() => activeView()?.searchInput ?? null);

/** A dropped or picked file: an index document, or a single player shard. */
els.loadOpen.addEventListener('click', () => els.fileInput.click());
els.loaderBrowse.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', (ev) => {
  readFile(ev.target.files && ev.target.files[0]);
  ev.target.value = '';
});
for (const type of ['dragenter', 'dragover']) {
  window.addEventListener(type, (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault();   // stop the browser from navigating to the file
    els.dragHint.hidden = false;
    els.drop.classList.add('over');
  });
}
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget !== null) return;
  els.dragHint.hidden = true;
  els.drop.classList.remove('over');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  els.dragHint.hidden = true;
  els.drop.classList.remove('over');
  readFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
});

const isTyping = (node) => !!node && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.isContentEditable);

window.addEventListener('keydown', (ev) => {
  const view = activeView();
  const input = view ? view.searchInput : null;
  if (ev.key === '/' && !isTyping(document.activeElement) && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
    if (!input || !input.offsetParent) return;
    ev.preventDefault();
    els.help.open = true;   // the syntax is what the shortcut exists to make discoverable
    view.focusSearch();
    return;
  }
  if (ev.key === 'Escape') {
    if (isTyping(document.activeElement) && input) {
      view.clearSearch();
      input.blur();
    } else if (els.help.open) {
      els.help.open = false;
    }
    return;
  }
  if (ev.key === 'Enter' && input && document.activeElement === input && view === players) {
    ev.preventDefault();
    players.openFirstMatch();
  }
});

window.addEventListener('hashchange', applyRoute);

/* --------------------------------- 4 go ----------------------------------- */

renderHelp();
boot();
