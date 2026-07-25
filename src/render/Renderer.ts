import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { BLOOM, QUALITY, type QualitySettings } from '../core/Config';
import { clamp01 } from '../core/MathUtil';

/**
 * Renderer, post chain and device tiering.
 *
 * The post chain is deliberately short: bloom (which is what makes line art
 * read as *neon* line art) and one combined grade pass doing vignette, tint and
 * chromatic separation. Three passes is a budget a mid-range phone can hold at
 * 60fps; a fashionable stack of eight is not.
 */
export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly quality: QualitySettings;

  private composer: EffectComposer;
  private renderPass: RenderPass;
  private bloomPass: UnrealBloomPass | null = null;
  private gradePass: ShaderPass;

  private width = 1;
  private height = 1;

  constructor(canvas: HTMLCanvasElement, camera: THREE.Camera, forcedTier?: QualitySettings['name']) {
    this.quality = QUALITY[forcedTier ?? detectTier()];

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: this.quality.antialias,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // No tone mapping: neon line art wants its accent hues to stay saturated
    // right up to clipping, and ACES turns every bright colour toward white.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.setClearColor(0x05060a, 1);

    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, camera);
    this.composer.addPass(this.renderPass);

    if (this.quality.bloom) {
      this.bloomPass = new UnrealBloomPass(
        new THREE.Vector2(1, 1),
        this.quality.bloomStrength,
        BLOOM.radius,
        BLOOM.threshold,
      );
      this.composer.addPass(this.bloomPass);
    }

    this.gradePass = new ShaderPass(GradeShader);
    this.composer.addPass(this.gradePass);

    this.composer.addPass(new OutputPass());

    this.resize();
  }

  private pixelRatio(): number {
    return Math.min(window.devicePixelRatio || 1, this.quality.maxPixelRatio);
  }

  get devicePixelRatioUsed(): number {
    return this.pixelRatio();
  }

  setCamera(camera: THREE.Camera): void {
    this.renderPass.camera = camera;
  }

  resize(): void {
    this.width = Math.max(1, window.innerWidth);
    this.height = Math.max(1, window.innerHeight);
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.setSize(this.width, this.height, false);
    this.composer.setPixelRatio(this.pixelRatio());
    this.composer.setSize(this.width, this.height);
    this.bloomPass?.setSize(this.width, this.height);
    this.gradePass.uniforms.uAspect!.value = this.width / this.height;
  }

  /**
   * @param vignette 0..1 extra darkening at the edges
   * @param aberration 0..1 chromatic separation, saved for the endgame
   * @param tint multiplied over the final image
   * @param flash 0..1 additive white, for the big moments
   */
  setGrade(vignette: number, aberration: number, tint: THREE.Color, flash: number): void {
    const u = this.gradePass.uniforms;
    u.uVignette!.value = clamp01(vignette);
    u.uAberration!.value = clamp01(aberration);
    (u.uTint!.value as THREE.Color).copy(tint);
    u.uFlash!.value = clamp01(flash);
  }

  setBloomStrength(v: number): void {
    if (this.bloomPass) this.bloomPass.strength = v;
  }

  setClearColor(color: THREE.Color): void {
    this.renderer.setClearColor(color, 1);
  }

  render(): void {
    this.composer.render();
  }

  dispose(): void {
    this.composer.dispose();
    this.renderer.dispose();
  }
}

/**
 * Tier detection from what browsers actually expose. It is a guess, so the
 * options menu can override it — but a bad guess must fail toward *playable*,
 * hence treating unknown mobile hardware as low.
 */
export function detectTier(): QualitySettings['name'] {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const cores = nav.hardwareConcurrency ?? 4;
  const memory = nav.deviceMemory ?? 4;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const pixels = window.innerWidth * window.innerHeight * (window.devicePixelRatio || 1) ** 2;

  if (coarse) {
    if (cores >= 8 && memory >= 6 && pixels < 4.2e6) return 'medium';
    return 'low';
  }
  if (cores <= 4 || memory <= 4) return 'medium';
  return 'high';
}

const GradeShader = {
  name: 'PogoGrade',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uVignette: { value: 0.35 },
    uAberration: { value: 0.0 },
    uTint: { value: new THREE.Color(1, 1, 1) },
    uFlash: { value: 0.0 },
    uAspect: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;

    uniform sampler2D tDiffuse;
    uniform float uVignette;
    uniform float uAberration;
    uniform vec3 uTint;
    uniform float uFlash;
    uniform float uAspect;

    varying vec2 vUv;

    void main() {
      vec2 centred = vUv - 0.5;
      float r2 = dot(centred, centred);

      vec3 col;
      if (uAberration > 0.001) {
        // Separation grows with distance from centre, so the edges of the
        // screen fray while the tile you are aiming at stays readable.
        vec2 dir = centred * uAberration * 0.02 * (0.3 + r2 * 2.0);
        col.r = texture2D(tDiffuse, vUv + dir).r;
        col.g = texture2D(tDiffuse, vUv).g;
        col.b = texture2D(tDiffuse, vUv - dir).b;
      } else {
        col = texture2D(tDiffuse, vUv).rgb;
      }

      vec2 v = centred * vec2(uAspect, 1.0);
      float vig = 1.0 - uVignette * smoothstep(0.16, 0.78, dot(v, v));
      col *= vig;
      col *= uTint;
      col += uFlash;

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};
