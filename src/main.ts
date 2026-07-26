import './ui/style.css';
import { App } from './App';
import { applyDevOverrides } from './core/Config';

/**
 * Bootstrap. Kept deliberately thin: find the canvas, check WebGL, hand off.
 * The only real work here is failing gracefully — a jam player who sees a blank
 * black page assumes the game is broken, so an unsupported browser gets told.
 */

function fail(message: string, detail = ''): void {
  const ui = document.getElementById('ui');
  if (!ui) return;
  ui.innerHTML = '';
  const screen = document.createElement('div');
  screen.className = 'screen visible';
  const panel = document.createElement('div');
  panel.className = 'panel';

  const h = document.createElement('h1');
  h.className = 'title';
  h.style.fontSize = 'clamp(1.6rem,7vw,2.2rem)';
  h.textContent = 'Cannot start';

  const p = document.createElement('p');
  p.textContent = message;

  panel.append(h, p);
  if (detail) {
    const d = document.createElement('p');
    d.className = 'notice';
    d.textContent = detail;
    panel.appendChild(d);
  }
  screen.appendChild(panel);
  ui.appendChild(screen);
}

/**
 * Probe on a throwaway canvas, never the real one. `getContext` returns any
 * context the canvas already has and silently ignores the attributes of later
 * calls — probing the play canvas would hand three.js a context created without
 * its antialias and power-preference settings.
 */
function hasWebGL2(): boolean {
  try {
    return document.createElement('canvas').getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

function boot(): void {
  const canvas = document.getElementById('gl') as HTMLCanvasElement | null;
  const ui = document.getElementById('ui');
  if (!canvas || !ui) {
    fail('The page did not load correctly. Try a refresh.');
    return;
  }

  if (!hasWebGL2()) {
    fail(
      "This browser can't do WebGL 2, which Pogo Drop needs to draw anything at all.",
      'A recent Chrome, Firefox, Edge or Safari should sort it. On a desktop, check hardware acceleration is switched on.',
    );
    return;
  }

  try {
    applyDevOverrides(window.location.search);
    document.getElementById('boot')?.remove();
    const app = new App(canvas, ui);
    app.start();
    // Dev-only inspection handle for the headless test scripts. Stripped from
    // production bundles, where `import.meta.env.DEV` is substituted as false.
    if (import.meta.env.DEV) {
      (window as unknown as { pogo: App }).pogo = app;
    }
  } catch (err) {
    console.error(err);
    fail(
      'Something went wrong while starting the game.',
      err instanceof Error ? err.message : String(err),
    );
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
