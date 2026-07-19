import './styles.css';
import { isSessionCode } from '../shared/protocol.js';
import { initToastRegion } from './lib/dom.js';
import { renderGuest } from './views/guest.js';
import { renderHome } from './views/home.js';
import { renderHost } from './views/host.js';

function mustGetRoot(): HTMLElement {
  const root = document.getElementById('app');
  if (!root) throw new Error('missing #app root');
  return root;
}

const app = mustGetRoot();
initToastRegion();

let cleanup: (() => void) | null = null;
let navigated = false;

function route(): void {
  cleanup?.();
  app.replaceChildren();

  const hash = location.hash.replace(/^#\/?/, '');
  const [page, param] = hash.split('/');

  if (page === 'host') {
    document.title = 'Hosting — Simple Remote Pair';
    cleanup = renderHost(app);
  } else if (page === 'join' && param && isSessionCode(param.toUpperCase())) {
    document.title = 'Session — Simple Remote Pair';
    cleanup = renderGuest(app, param.toUpperCase());
  } else {
    document.title = 'Simple Remote Pair';
    cleanup = renderHome(app);
    if (hash !== '') history.replaceState(null, '', '#/');
  }

  // Move focus to the new view so keyboard and screen-reader users don't get
  // silently dropped to <body> on navigation. Skip the initial page load.
  if (navigated) {
    const main = app.querySelector('main');
    if (main) {
      main.setAttribute('tabindex', '-1');
      main.focus();
    }
  }
  navigated = true;
}

window.addEventListener('hashchange', route);
route();
