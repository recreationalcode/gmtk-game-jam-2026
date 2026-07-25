import type * as THREE from 'three';

/**
 * Frame-budget readout, toggled with F3.
 *
 * Exists because the only performance numbers that matter for a web game are
 * the ones measured on the phone someone is actually holding — a desktop
 * profile says nothing useful about a mid-range Android. Hidden by default, so
 * players never see it.
 */
export class Stats {
  private readonly el: HTMLElement;
  private visible = false;

  private frames = 0;
  private elapsed = 0;
  private fps = 0;
  private worstFrame = 0;

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.id = 'stats';
    this.el.className = 'hidden';
    root.appendChild(this.el);

    window.addEventListener('keydown', (e) => {
      if (e.code === 'F3') {
        e.preventDefault();
        this.toggle();
      }
    });
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.classList.toggle('hidden', !this.visible);
  }

  update(dt: number, renderer: THREE.WebGLRenderer, extra: Record<string, string | number>): void {
    this.frames++;
    this.elapsed += dt;
    this.worstFrame = Math.max(this.worstFrame, dt);

    if (this.elapsed < 0.5) return;
    this.fps = this.frames / this.elapsed;

    if (this.visible) {
      const info = renderer.info;
      const lines = [
        `${this.fps.toFixed(0)} fps   worst ${(this.worstFrame * 1000).toFixed(1)} ms`,
        `draws ${info.render.calls}   tris ${info.render.triangles}`,
        `geom ${info.memory.geometries}   tex ${info.memory.textures}`,
        ...Object.entries(extra).map(([k, v]) => `${k} ${v}`),
      ];
      this.el.textContent = lines.join('\n');
    }

    this.frames = 0;
    this.elapsed = 0;
    this.worstFrame = 0;
  }

  /** Exposed so the headless smoke test can assert on real numbers. */
  get currentFps(): number {
    return this.fps;
  }
}
