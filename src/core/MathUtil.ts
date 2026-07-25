export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function inverseLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}

/**
 * Frame-rate independent exponential smoothing.
 *
 * `lerp(a, b, 0.1)` per frame is the classic bug: it moves twice as fast at
 * 120fps as at 60fps. This is the correct form.
 */
export function damp(a: number, b: number, lambda: number, dt: number): number {
  return lerp(a, b, 1 - Math.exp(-lambda * dt));
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Ease-out cubic — the workhorse for UI and effect decay. */
export function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

/** Ease-out back, overshoots slightly. Good for pops. */
export function easeOutBack(t: number, overshoot = 1.7): number {
  const c = overshoot + 1;
  const u = t - 1;
  return 1 + c * u * u * u + overshoot * u * u;
}

export function easeInQuad(t: number): number {
  return t * t;
}

export function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

/** Ease-out elastic. Reserved for the big moments. */
export function easeOutElastic(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const p = (2 * Math.PI) / 3;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * p) + 1;
}

export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Wrap into [0, 360). */
export function wrapHue(h: number): number {
  return ((h % 360) + 360) % 360;
}

/** Shortest-path interpolation between two hues on the colour wheel. */
export function lerpHue(a: number, b: number, t: number): number {
  let delta = wrapHue(b) - wrapHue(a);
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return wrapHue(a + delta * t);
}

/** Chebyshev (chessboard) distance — the right metric on a square grid. */
export function chebyshev(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

export function formatScore(n: number): string {
  return Math.floor(n).toLocaleString('en-US');
}

/** Renders seconds as `M:SS.d` while running, and `SS.d` under ten seconds. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, seconds);
  const whole = Math.floor(s);
  const tenths = Math.floor((s - whole) * 10);
  if (whole >= 60) {
    const m = Math.floor(whole / 60);
    const rem = whole % 60;
    return `${m}:${rem.toString().padStart(2, '0')}.${tenths}`;
  }
  return `${whole}.${tenths}`;
}
