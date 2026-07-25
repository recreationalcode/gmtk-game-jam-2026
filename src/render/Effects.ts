import * as THREE from 'three';
import type { QualitySettings } from '../core/Config';

/**
 * Additive impact effects: expanding ground rings and particle bursts.
 *
 * Both are fixed-capacity ring buffers with GPU-side animation — nothing is
 * allocated during play, and the CPU only touches a particle when it spawns.
 * At jam scale that is the difference between a phone holding 60fps and not.
 */

const RING_CAPACITY = 24;

export class Shockwaves {
  readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly aStart: THREE.InstancedBufferAttribute;
  private readonly aColor: THREE.InstancedBufferAttribute;
  private readonly aParams: THREE.InstancedBufferAttribute;
  private readonly matrix = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private cursor = 0;
  private capacity: number;

  constructor(quality: QualitySettings) {
    this.capacity = Math.min(RING_CAPACITY, Math.max(3, quality.shockwaves * 3));

    const plane = new THREE.PlaneGeometry(1, 1);
    plane.rotateX(-Math.PI / 2);

    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.mesh = new THREE.InstancedMesh(plane, this.material, this.capacity);
    this.mesh.frustumCulled = false;
    this.mesh.count = this.capacity;

    this.aStart = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity), 1);
    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
    this.aParams = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 2), 2);
    for (let i = 0; i < this.capacity; i++) this.aStart.array[i] = -999;

    plane.setAttribute('aStart', this.aStart);
    plane.setAttribute('aColor', this.aColor);
    plane.setAttribute('aParams', this.aParams);

    this.quat.identity();
  }

  spawn(
    x: number,
    y: number,
    z: number,
    radius: number,
    duration: number,
    color: THREE.Color,
    time: number,
    thickness = 0.12,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;

    this.pos.set(x, y + 0.02, z);
    this.scale.set(radius * 2, 1, radius * 2);
    this.matrix.compose(this.pos, this.quat, this.scale);
    this.mesh.setMatrixAt(i, this.matrix);

    (this.aStart.array as Float32Array)[i] = time;
    const c = this.aColor.array as Float32Array;
    c[i * 3] = color.r;
    c[i * 3 + 1] = color.g;
    c[i * 3 + 2] = color.b;
    const p = this.aParams.array as Float32Array;
    p[i * 2] = duration;
    p[i * 2 + 1] = thickness;

    this.mesh.instanceMatrix.needsUpdate = true;
    this.aStart.needsUpdate = true;
    this.aColor.needsUpdate = true;
    this.aParams.needsUpdate = true;
  }

  update(time: number): void {
    this.material.uniforms.uTime!.value = time;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}

const RING_VERT = /* glsl */ `
attribute float aStart;
attribute vec3 aColor;
attribute vec2 aParams;  // x duration, y thickness

uniform float uTime;

varying vec2 vUv;
varying vec3 vColor;
varying float vAge;
varying float vThickness;

void main() {
  vUv = uv;
  vColor = aColor;
  vThickness = aParams.y;
  vAge = clamp((uTime - aStart) / max(0.0001, aParams.x), 0.0, 1.0);

  // Retire finished and never-fired rings by collapsing them to a point, which
  // costs nothing and avoids per-frame instance count bookkeeping.
  float live = step(aStart, uTime) * step(vAge, 0.999);
  vec3 p = position * live;

  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
}
`;

const RING_FRAG = /* glsl */ `
precision mediump float;

varying vec2 vUv;
varying vec3 vColor;
varying float vAge;
varying float vThickness;

void main() {
  float r = length(vUv * 2.0 - 1.0);
  // Ring races outward and thins as it goes, like a real pressure wave.
  float radius = vAge;
  float w = vThickness * (1.0 - vAge * 0.7);
  float band = 1.0 - smoothstep(0.0, w, abs(r - radius));
  float fade = pow(1.0 - vAge, 1.6);
  float alpha = band * fade;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(vColor * alpha * 1.15, alpha);
}
`;

// ---------------------------------------------------------------------------

export class Particles {
  readonly points: THREE.Points;
  private readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.BufferGeometry;

  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly sizes: Float32Array;
  private readonly alphas: Float32Array;

  private readonly velocities: Float32Array;
  private readonly lives: Float32Array;
  private readonly maxLives: Float32Array;

  private readonly capacity: number;
  private cursor = 0;

  constructor(quality: QualitySettings, pixelRatio: number) {
    this.capacity = quality.particleBudget;
    this.positions = new Float32Array(this.capacity * 3);
    this.colors = new Float32Array(this.capacity * 3);
    this.sizes = new Float32Array(this.capacity);
    this.alphas = new Float32Array(this.capacity);
    this.velocities = new Float32Array(this.capacity * 3);
    this.lives = new Float32Array(this.capacity);
    this.maxLives = new Float32Array(this.capacity);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
    this.geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      uniforms: { uPixelRatio: { value: pixelRatio } },
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
  }

  setPixelRatio(r: number): void {
    this.material.uniforms.uPixelRatio!.value = r;
  }

  burst(
    x: number,
    y: number,
    z: number,
    count: number,
    speed: number,
    color: THREE.Color,
    life: number,
    size: number,
    upBias = 0.6,
  ): void {
    for (let i = 0; i < count; i++) {
      const idx = this.cursor;
      this.cursor = (this.cursor + 1) % this.capacity;

      // Cosine-weighted-ish hemisphere: mostly outward along the ground with a
      // vertical kick, which is how debris actually leaves an impact.
      const a = Math.random() * Math.PI * 2;
      const up = Math.random() * upBias + 0.08;
      const flat = Math.sqrt(Math.max(0, 1 - up * up));
      const s = speed * (0.45 + Math.random() * 0.75);

      this.positions[idx * 3] = x;
      this.positions[idx * 3 + 1] = y + 0.05;
      this.positions[idx * 3 + 2] = z;

      this.velocities[idx * 3] = Math.cos(a) * flat * s;
      this.velocities[idx * 3 + 1] = up * s;
      this.velocities[idx * 3 + 2] = Math.sin(a) * flat * s;

      this.colors[idx * 3] = color.r;
      this.colors[idx * 3 + 1] = color.g;
      this.colors[idx * 3 + 2] = color.b;

      const l = life * (0.6 + Math.random() * 0.7);
      this.lives[idx] = l;
      this.maxLives[idx] = l;
      this.sizes[idx] = size * (0.6 + Math.random() * 0.8);
      this.alphas[idx] = 1;
    }
  }

  update(dt: number, gravity: number): void {
    let anyAlive = false;
    for (let i = 0; i < this.capacity; i++) {
      if (this.lives[i]! <= 0) {
        if (this.alphas[i]! !== 0) this.alphas[i] = 0;
        continue;
      }
      anyAlive = true;
      this.lives[i]! -= dt;

      this.velocities[i * 3 + 1]! -= gravity * dt;
      const drag = Math.exp(-1.6 * dt);
      this.velocities[i * 3]! *= drag;
      this.velocities[i * 3 + 2]! *= drag;

      this.positions[i * 3]! += this.velocities[i * 3]! * dt;
      this.positions[i * 3 + 1]! += this.velocities[i * 3 + 1]! * dt;
      this.positions[i * 3 + 2]! += this.velocities[i * 3 + 2]! * dt;

      const t = Math.max(0, this.lives[i]!) / this.maxLives[i]!;
      this.alphas[i] = t * t;
    }

    if (anyAlive) {
      this.geometry.attributes.position!.needsUpdate = true;
      this.geometry.attributes.aAlpha!.needsUpdate = true;
      this.geometry.attributes.aColor!.needsUpdate = true;
      this.geometry.attributes.aSize!.needsUpdate = true;
    }
  }

  clear(): void {
    this.lives.fill(0);
    this.alphas.fill(0);
    this.geometry.attributes.aAlpha!.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

const PARTICLE_VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
attribute float aAlpha;

uniform float uPixelRatio;

varying vec3 vColor;
varying float vAlpha;

void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uPixelRatio * (18.0 / max(0.2, -mv.z));
  gl_Position = projectionMatrix * mv;
}
`;

const PARTICLE_FRAG = /* glsl */ `
precision mediump float;

varying vec3 vColor;
varying float vAlpha;

void main() {
  if (vAlpha <= 0.002) discard;
  vec2 d = gl_PointCoord - 0.5;
  float r = dot(d, d) * 4.0;
  float mask = 1.0 - smoothstep(0.35, 1.0, r);
  gl_FragColor = vec4(vColor * mask * vAlpha * 1.1, mask * vAlpha);
}
`;
