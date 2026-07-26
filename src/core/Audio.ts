import { AUDIO, MUSIC_TRACKS, type MusicTrack } from './Config';
import { clamp, clamp01, lerp } from './MathUtil';

/**
 * All game audio, synthesised at runtime through WebAudio.
 *
 * Nothing here is a file. That was a licensing decision first — there is no
 * attribution to get wrong and no rights to track — but it earns its keep
 * musically: every sound is a function of game state. The bounce pitch climbs
 * with your combo, the scoring blip's note is chosen by the tile's value, and
 * the music adds layers as you descend and tightens as the clock runs out.
 * Sampled audio cannot do that without a hundred variants.
 */

type Bus = GainNode;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: Bus | null = null;
  private musicBus: Bus | null = null;
  private musicFilter: BiquadFilterNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  private schedulerId: number | null = null;
  private nextNoteTime = 0;
  private step = 0;

  private depth = 0;
  private intensity = 0;
  private musicEnabled = true;
  private track: MusicTrack = 'game';
  /**
   * Music has been asked for but the AudioContext may not exist yet.
   *
   * The title screen wants music before anyone has touched anything, and no
   * browser will start an AudioContext without a gesture. Remembering the
   * request lets `unlock()` start the track at the first legal moment rather
   * than leaving the menu silent until the player happens to press play.
   */
  private wantMusic = false;

  muted = false;

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /** Which piece is playing. Read by the headless music test. */
  get currentTrack(): MusicTrack | null {
    return this.schedulerId === null ? null : this.track;
  }

  /**
   * Must be called from a user gesture. Browsers will not start an AudioContext
   * any other way, so every input path funnels here.
   */
  async unlock(): Promise<void> {
    if (!this.ctx) this.build();
    if (this.ctx && this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        /* Autoplay still blocked; the next gesture will try again. */
      }
    }
    if (this.wantMusic && this.schedulerId === null) this.startMusic(this.track);
  }

  private build(): void {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    const ctx = new Ctor({ latencyHint: 'interactive' });
    this.ctx = ctx;

    // A compressor on the master bus is not for polish — it is what stops a
    // descend, a perfect chime and eight burnouts landing on the same frame
    // from clipping into a crackle.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.18;
    limiter.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.gain.value = AUDIO.masterGain;
    this.master.connect(limiter);

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = AUDIO.sfxGain;
    this.sfxBus.connect(this.master);

    this.musicFilter = ctx.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = 1400;
    this.musicFilter.Q.value = 0.7;
    this.musicFilter.connect(this.master);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0;
    this.musicBus.connect(this.musicFilter);

    this.noiseBuffer = makeNoiseBuffer(ctx);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : AUDIO.masterGain, this.ctx.currentTime, 0.05);
    }
  }

  setMusicEnabled(enabled: boolean): void {
    this.musicEnabled = enabled;
    if (!enabled) this.stopMusic();
  }

  suspend(): void {
    void this.ctx?.suspend();
  }

  resume(): void {
    void this.ctx?.resume();
  }

  // -- one-shot sound effects ---------------------------------------------

  /** @param quality 0 normal, 1 charged, 2 perfect. @param streak combo length. */
  bounce(strength: number, quality: number, streak: number): void {
    const ctx = this.ctx;
    const bus = this.sfxBus;
    if (!ctx || !bus) return;
    const t = ctx.currentTime;
    const s = clamp(strength, 0.2, 1.6);

    // Body: a sine dropping fast in pitch. The whole character of a "thump".
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    const base = 150 + streak * 14 + quality * 30;
    osc.frequency.setValueAtTime(base * 1.9, t);
    osc.frequency.exponentialRampToValueAtTime(base * 0.42, t + 0.13);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.5 * s, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    osc.connect(gain).connect(bus);
    osc.start(t);
    osc.stop(t + 0.24);

    // Transient: a bandpassed noise tick so the hit reads on phone speakers,
    // which reproduce almost nothing below 200Hz.
    this.noiseHit(t, 0.05, 0.28 * s, 1800 + quality * 900, 1.2);

    if (quality >= 1) {
      const spring = ctx.createOscillator();
      const sg = ctx.createGain();
      spring.type = 'triangle';
      spring.frequency.setValueAtTime(base * 3.2, t);
      spring.frequency.exponentialRampToValueAtTime(base * 7.5, t + 0.16);
      sg.gain.setValueAtTime(0.0001, t);
      sg.gain.exponentialRampToValueAtTime(0.1 * s, t + 0.01);
      sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      spring.connect(sg).connect(bus);
      spring.start(t);
      spring.stop(t + 0.22);
    }
  }

  perfect(streak: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    // Climbing the scale with the streak turns the combo counter into a melody.
    const degree = Math.min(streak, 10);
    const midi = AUDIO.rootMidi + 12 + scaleStep(degree);
    this.blip(midi, t, 0.32, 0.22, 'triangle');
    this.blip(midi + 12, t + 0.012, 0.16, 0.16, 'sine');
  }

  score(value: number, comboStreak: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    // Higher-value tiles ring higher, so you can hear a good grab.
    const degree = Math.round(clamp(value, 1, 9) * 0.7) + comboStreak;
    const midi = AUDIO.rootMidi + scaleStep(degree);
    this.blip(midi, t, 0.24, 0.18, 'square', 0.35);
  }

  descend(depth: number): void {
    const ctx = this.ctx;
    const bus = this.sfxBus;
    if (!ctx || !bus) return;
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2600, t);
    filter.frequency.exponentialRampToValueAtTime(220, t + 0.7);
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(340, t);
    osc.frequency.exponentialRampToValueAtTime(46, t + 0.75);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.38, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
    osc.connect(filter).connect(gain).connect(bus);
    osc.start(t);
    osc.stop(t + 0.82);

    this.noiseHit(t, 0.5, 0.22, 700, 0.6);

    // A rising arpeggio under the falling sweep: you are dropping, but this is
    // the good outcome, and the harmony has to say so.
    for (let i = 0; i < 4; i++) {
      this.blip(AUDIO.rootMidi + scaleStep(i + depth), t + i * 0.055, 0.3, 0.13, 'triangle', 0.28);
    }
  }

  /**
   * Multiplier fanfare. The number of notes tracks the multiplier itself, so a
   * x5 is audibly a bigger event than a x2 without any extra samples.
   */
  multiplierUp(multiplier: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const notes = Math.min(8, Math.max(2, multiplier));
    for (let i = 0; i < notes; i++) {
      this.blip(AUDIO.rootMidi + 12 + scaleStep(i), t + 0.24 + i * 0.05, 0.34, 0.16, 'triangle', 0.3);
    }
    this.blip(AUDIO.rootMidi + 24 + scaleStep(notes), t + 0.24 + notes * 0.05, 0.7, 0.2, 'sine', 0.4);
  }

  ascend(): void {
    const ctx = this.ctx;
    const bus = this.sfxBus;
    if (!ctx || !bus) return;
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(90, t);
    osc.frequency.exponentialRampToValueAtTime(500, t + 0.42);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.26, t + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);

    // Detuned partner an augmented fourth away — the interval that has meant
    // "something went wrong" since before any of us were writing games.
    const osc2 = ctx.createOscillator();
    osc2.type = 'square';
    osc2.frequency.setValueAtTime(90 * 1.414, t);
    osc2.frequency.exponentialRampToValueAtTime(500 * 1.414, t + 0.42);
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.0001, t);
    g2.gain.exponentialRampToValueAtTime(0.1, t + 0.03);
    g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);

    osc.connect(gain).connect(bus);
    osc2.connect(g2).connect(bus);
    osc.start(t);
    osc2.start(t);
    osc.stop(t + 0.52);
    osc2.stop(t + 0.5);
  }

  burnout(count: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const n = Math.min(count, 4);
    for (let i = 0; i < n; i++) {
      this.noiseHit(t + i * 0.035, 0.09, 0.1, 2400 + Math.random() * 2200, 4);
    }
  }

  gainTime(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    for (let i = 0; i < 5; i++) {
      this.blip(AUDIO.rootMidi + 12 + scaleStep(i), t + i * 0.045, 0.26, 0.14, 'sine', 0.3);
    }
  }

  boost(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const interval of [0, 7, 12, 19]) {
      this.blip(AUDIO.rootMidi + interval, t, 0.45, 0.16, 'sawtooth', 0.22);
    }
  }

  freeze(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    for (let i = 0; i < 6; i++) {
      this.blip(AUDIO.rootMidi + 24 + scaleStep(i * 2), t + i * 0.03, 0.5, 0.09, 'sine', 0.24);
    }
    this.noiseHit(t, 0.6, 0.07, 6000, 8);
  }

  /** Clock tick. Gets higher and harder as the countdown closes in. */
  tick(secondsLeft: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const urgent = secondsLeft <= 10;
    const pitch = urgent ? 1400 + (10 - secondsLeft) * 130 : 900;
    this.noiseHit(t, urgent ? 0.07 : 0.04, urgent ? 0.2 : 0.07, pitch, urgent ? 3 : 6);
    if (urgent) this.blip(AUDIO.rootMidi + 24 + (10 - secondsLeft), t, 0.12, 0.12, 'square', 0.2);
  }

  gameOver(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    this.stopMusic();
    for (let i = 0; i < 4; i++) {
      this.blip(AUDIO.rootMidi + 12 - scaleStep(i), t + i * 0.13, 0.7, 0.2, 'triangle', 0.3);
    }
    this.noiseHit(t, 0.9, 0.16, 300, 0.5);
  }

  /**
   * Targeting tick when the reticle acquires a new tile. Deliberately tiny —
   * it fires several times per bounce while steering, so it has to sit under
   * the mix as texture rather than register as an event.
   */
  lockTick(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.noiseHit(ctx.currentTime, 0.02, 0.035, 5200, 6);
  }

  uiClick(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.blip(AUDIO.rootMidi + 12, ctx.currentTime, 0.1, 0.1, 'square', 0.18);
  }

  // -- synthesis primitives ------------------------------------------------

  private blip(
    midi: number,
    when: number,
    duration: number,
    gainPeak: number,
    type: OscillatorType,
    detuneMix = 0,
  ): void {
    const ctx = this.ctx;
    const bus = this.sfxBus;
    if (!ctx || !bus) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = midiToFreq(midi);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, gainPeak), when + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    osc.connect(gain).connect(bus);
    osc.start(when);
    osc.stop(when + duration + 0.02);

    if (detuneMix > 0) {
      const osc2 = ctx.createOscillator();
      const g2 = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.value = midiToFreq(midi);
      osc2.detune.value = 9;
      g2.gain.setValueAtTime(0.0001, when);
      g2.gain.exponentialRampToValueAtTime(Math.max(0.0002, gainPeak * detuneMix), when + 0.01);
      g2.gain.exponentialRampToValueAtTime(0.0001, when + duration * 0.9);
      osc2.connect(g2).connect(bus);
      osc2.start(when);
      osc2.stop(when + duration + 0.02);
    }
  }

  private noiseHit(
    when: number,
    duration: number,
    gainPeak: number,
    filterFreq: number,
    q: number,
  ): void {
    const ctx = this.ctx;
    const bus = this.sfxBus;
    if (!ctx || !bus || !this.noiseBuffer) return;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = filterFreq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(Math.max(0.0002, gainPeak), when);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);

    src.connect(filter).connect(gain).connect(bus);
    src.start(when, Math.random() * 1.5);
    src.stop(when + duration + 0.02);
  }

  // -- generative music ----------------------------------------------------

  startMusic(track: MusicTrack = 'game'): void {
    this.wantMusic = true;
    const changed = track !== this.track;
    this.track = track;

    const ctx = this.ctx;
    if (!ctx || !this.musicBus || !this.musicEnabled) return;

    // Gain and tone are per track, and always ramped: switching from the title
    // groove to the match should feel like a crossfade, not an edit.
    const cfg = MUSIC_TRACKS[track];
    this.musicBus.gain.setTargetAtTime(cfg.gain, ctx.currentTime, 0.6);
    this.musicFilter?.frequency.setTargetAtTime(cfg.cutoff, ctx.currentTime, 0.4);

    if (this.schedulerId !== null) {
      // Already running. Restart the pattern from the top of the loop, but let
      // the note clock run on — rewinding it would double-trigger whatever is
      // already queued on the audio thread.
      if (changed) this.step = 0;
      return;
    }

    this.nextNoteTime = ctx.currentTime + 0.1;
    this.step = 0;
    this.schedulerId = window.setInterval(() => this.scheduleAhead(), 25);
  }

  stopMusic(): void {
    this.wantMusic = false;
    if (this.schedulerId !== null) {
      clearInterval(this.schedulerId);
      this.schedulerId = null;
    }
    if (this.musicBus && this.ctx) {
      this.musicBus.gain.setTargetAtTime(0, this.ctx.currentTime, 0.25);
    }
  }

  /**
   * @param depth current floor depth — unlocks layers
   * @param intensity 0..1 endgame pressure — raises tempo and opens the filter
   */
  setMusicState(depth: number, intensity: number, timeScale = 1): void {
    this.depth = depth;
    this.intensity = clamp01(intensity);
    // Only the match track reacts to game state; the menu tracks hold their
    // own tone so they do not inherit whatever the last run ended on.
    if (this.track !== 'game') return;
    if (this.musicFilter && this.ctx) {
      const open = lerp(1400, 5200, this.intensity) + Math.min(depth, 6) * 180;
      // Dipping the filter as time dilates is the classic slow-motion cue, and
      // it costs nothing here because the filter already exists for the endgame.
      const target = open * lerp(0.35, 1, clamp01(timeScale));
      this.musicFilter.frequency.setTargetAtTime(target, this.ctx.currentTime, 0.25);
    }
  }

  private get secondsPerStep(): number {
    const bpm =
      this.track === 'game'
        ? lerp(AUDIO.bpmStart, AUDIO.bpmEnd, this.intensity)
        : MUSIC_TRACKS[this.track].bpm;
    return 60 / bpm / 4; // sixteenth notes
  }

  /**
   * Standard WebAudio lookahead scheduler: a coarse JS timer queues notes onto
   * the sample-accurate audio clock a little ahead of time. Scheduling notes
   * directly from a timer would jitter audibly.
   */
  private scheduleAhead(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const horizon = ctx.currentTime + 0.12;

    while (this.nextNoteTime < horizon) {
      this.scheduleStep(this.step, this.nextNoteTime);
      this.nextNoteTime += this.secondsPerStep;
      this.step = (this.step + 1) % 64;
    }
  }

  private scheduleStep(step: number, when: number): void {
    if (this.track === 'title') return this.stepTitle(step, when);
    if (this.track === 'over') return this.stepChill(step, when);
    return this.stepMatch(step, when);
  }

  private stepMatch(step: number, when: number): void {
    const bar = Math.floor(step / 16);
    const beat = step % 16;
    const root = CHORD_ROOTS[bar % CHORD_ROOTS.length]!;
    const depth = this.depth;

    // Kick — always present. This is the pulse the bouncing syncs to.
    if (beat === 0 || beat === 6 || beat === 10) {
      this.musicKick(when, beat === 0 ? 0.6 : 0.38);
    }

    // Bass, from the surface.
    if (beat % 4 === 0) {
      this.musicBass(AUDIO.rootMidi - 24 + root, when, this.secondsPerStep * 3.2);
    }

    // Hats arrive on the first descent, so going down audibly adds a layer.
    if (depth >= 1 && beat % 2 === 1) {
      this.musicHat(when, depth >= 3 ? 0.09 : 0.06);
    }

    // Arpeggio from depth 2.
    if (depth >= 2 && beat % 2 === 0) {
      const idx = (step * 3) % 5;
      this.musicArp(AUDIO.rootMidi + root + scaleStep(idx) + (beat % 8 === 0 ? 12 : 0), when);
    }

    // Pad from depth 4.
    if (depth >= 4 && beat === 0) {
      this.musicPad(AUDIO.rootMidi - 12 + root, when, this.secondsPerStep * 15);
    }

    // Endgame: every off-beat gets a driving stab.
    if (this.intensity > 0.5 && beat % 4 === 2) {
      this.musicHat(when, 0.12 * this.intensity);
    }
  }

  /**
   * Title music: upbeat and groovy.
   *
   * Groove is a pattern property, not a sound property — the voices here are
   * the same ones the match uses. What makes it move is the four-on-the-floor
   * kick, the backbeat clap, and a bass that plays *between* the beats rather
   * than on them.
   */
  private stepTitle(step: number, when: number): void {
    const bar = Math.floor(step / 16);
    const beat = step % 16;
    const root = TITLE_ROOTS[bar % TITLE_ROOTS.length]!;

    if (beat % 4 === 0) this.musicKick(when, beat === 0 ? 0.62 : 0.46);

    // The backbeat is the single thing that makes a loop read as groovy.
    if (beat === 4 || beat === 12) this.musicClap(when, 0.19);

    // Offbeat hats, accented every other one so the eighths swing.
    if (beat % 2 === 1) this.musicHat(when, beat % 4 === 3 ? 0.085 : 0.05);

    if (TITLE_BASS.includes(beat)) {
      // Octave jumps on the syncopated notes — the walking part of the walk.
      const octave = beat === 6 || beat === 14 ? 12 : 0;
      this.musicBass(AUDIO.rootMidi - 24 + root + octave, when, this.secondsPerStep * 1.7);
    }

    if (beat === 2 || beat === 10) {
      this.musicStab(AUDIO.rootMidi - 12 + root, when, this.secondsPerStep * 2.4);
    }

    if (beat % 2 === 0) {
      const idx = TITLE_ARP[(step / 2) % TITLE_ARP.length]!;
      this.musicArp(AUDIO.rootMidi + 12 + root + scaleStep(idx), when);
    }
  }

  /**
   * Post-run music: chill.
   *
   * Almost the inverse of the title track — no backbeat, one soft kick a bar
   * as a pulse rather than a beat, and a melody sparse enough to leave room.
   * It plays under a screen people are reading, so nothing here competes.
   */
  private stepChill(step: number, when: number): void {
    const bar = Math.floor(step / 16);
    const beat = step % 16;
    const root = CHILL_ROOTS[bar % CHILL_ROOTS.length]!;

    if (beat === 0) {
      this.musicPad(AUDIO.rootMidi - 12 + root, when, this.secondsPerStep * 16);
      this.musicBass(AUDIO.rootMidi - 24 + root, when, this.secondsPerStep * 7);
      this.musicKick(when, 0.2);
    }

    if (beat === 8) {
      this.musicBass(AUDIO.rootMidi - 24 + root + 7, when, this.secondsPerStep * 6);
      this.musicHat(when, 0.026);
    }

    // Three notes a bar, walking through the melody rather than repeating on
    // the bar — a four-bar loop that never plays the same bar twice.
    const slot = CHILL_NOTE_BEATS.indexOf(beat);
    if (slot >= 0) {
      const n = bar * CHILL_NOTE_BEATS.length + slot;
      const idx = CHILL_MELODY[n % CHILL_MELODY.length]!;
      this.musicPluck(
        AUDIO.rootMidi + 12 + root + scaleStep(idx),
        when,
        this.secondsPerStep * 6,
      );
    }
  }

  private musicKick(when: number, gainPeak: number): void {
    const ctx = this.ctx;
    const bus = this.musicBus;
    if (!ctx || !bus) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, when);
    osc.frequency.exponentialRampToValueAtTime(44, when + 0.11);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(gainPeak, when + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.26);
    osc.connect(gain).connect(bus);
    osc.start(when);
    osc.stop(when + 0.28);
  }

  private musicHat(when: number, gainPeak: number): void {
    const ctx = this.ctx;
    const bus = this.musicBus;
    if (!ctx || !bus || !this.noiseBuffer) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 7000;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(gainPeak, when);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    src.connect(filter).connect(gain).connect(bus);
    src.start(when, Math.random());
    src.stop(when + 0.07);
  }

  private musicBass(midi: number, when: number, duration: number): void {
    const ctx = this.ctx;
    const bus = this.musicBus;
    if (!ctx || !bus) return;
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.value = midiToFreq(midi);
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(240 + this.intensity * 500, when);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(0.3, when + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    osc.connect(filter).connect(gain).connect(bus);
    osc.start(when);
    osc.stop(when + duration + 0.05);
  }

  private musicArp(midi: number, when: number): void {
    const ctx = this.ctx;
    const bus = this.musicBus;
    if (!ctx || !bus) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = midiToFreq(midi);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(0.075, when + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + this.secondsPerStep * 1.4);
    osc.connect(gain).connect(bus);
    osc.start(when);
    osc.stop(when + this.secondsPerStep * 1.5);
  }

  private musicPad(midi: number, when: number, duration: number): void {
    const ctx = this.ctx;
    const bus = this.musicBus;
    if (!ctx || !bus) return;
    for (const interval of [0, 7, 15]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = midiToFreq(midi + interval);
      osc.detune.value = (Math.random() - 0.5) * 12;
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.linearRampToValueAtTime(0.05, when + duration * 0.35);
      gain.gain.linearRampToValueAtTime(0.0001, when + duration);
      osc.connect(gain).connect(bus);
      osc.start(when);
      osc.stop(when + duration + 0.05);
    }
  }

  /**
   * A clap, not a snare. Three tightly spaced noise bursts through a bandpass:
   * one burst reads as a snare hit, the flam is what makes it a clap.
   */
  private musicClap(when: number, gainPeak: number): void {
    const ctx = this.ctx;
    const bus = this.musicBus;
    if (!ctx || !bus || !this.noiseBuffer) return;

    for (const [offset, level, decay] of [
      [0, 0.55, 0.04],
      [0.011, 0.8, 0.04],
      [0.023, 1, 0.17],
    ] as const) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 1650;
      filter.Q.value = 1.1;
      const gain = ctx.createGain();
      const t = when + offset;
      gain.gain.setValueAtTime(gainPeak * level, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      src.connect(filter).connect(gain).connect(bus);
      src.start(t, Math.random());
      src.stop(t + decay + 0.03);
    }
  }

  /**
   * Chord stab: root, fifth, octave.
   *
   * Deliberately no third. The title progression mixes major and minor chords,
   * and a stab without a third sits correctly on both — so the pattern never
   * has to know which chord it is on, and the arp supplies the colour.
   */
  private musicStab(midi: number, when: number, duration: number): void {
    const ctx = this.ctx;
    const bus = this.musicBus;
    if (!ctx || !bus) return;
    for (const interval of [0, 7, 12]) {
      const osc = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.value = midiToFreq(midi + interval);
      osc.detune.value = (Math.random() - 0.5) * 9;
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(2800, when);
      filter.frequency.exponentialRampToValueAtTime(700, when + duration);
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(0.05, when + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
      osc.connect(filter).connect(gain).connect(bus);
      osc.start(when);
      osc.stop(when + duration + 0.05);
    }
  }

  /** Soft, long-decaying melody note for the chill track. */
  private musicPluck(midi: number, when: number, duration: number): void {
    const ctx = this.ctx;
    const bus = this.musicBus;
    if (!ctx || !bus) return;
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = midiToFreq(midi);
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2400, when);
    filter.frequency.exponentialRampToValueAtTime(600, when + duration);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(0.09, when + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    osc.connect(filter).connect(gain).connect(bus);
    osc.start(when);
    osc.stop(when + duration + 0.05);
  }

  dispose(): void {
    this.stopMusic();
    void this.ctx?.close();
    this.ctx = null;
  }
}

/** i · VI · VII · i in A minor — four chords, no surprises, always works. */
const CHORD_ROOTS = [0, 8, 10, 0];

/** Title: i · VI · III · VII (Am · F · C · G). Minor key, but it lifts. */
const TITLE_ROOTS = [0, 8, 3, 10];

/**
 * Sixteenths the title bass plays on. Six notes across sixteen, and only two of
 * them on a beat — playing between the beats is what a groove *is*.
 */
const TITLE_BASS = [0, 3, 6, 8, 11, 14];

/** Pentatonic degrees for the title arp, as a phrase rather than a run. */
const TITLE_ARP = [0, 2, 4, 2, 3, 1, 4, 2];

/** Post-run: i · iv · VI · III (Am · Dm · F · C). Resolves rather than drives. */
const CHILL_ROOTS = [0, 5, 8, 3];

/** Sixteenths the chill melody lands on — off the bar line, never crowded. */
const CHILL_NOTE_BEATS = [4, 7, 13];

/**
 * Twelve degrees over three notes a bar: coprime with the four-bar chord loop,
 * so the melody takes four full loops to repeat itself against the harmony.
 */
const CHILL_MELODY = [0, 2, 4, 3, 5, 2, 6, 4, 1, 3, 5, 2];

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Semitone offset for the nth step of the pentatonic scale, wrapping octaves. */
function scaleStep(n: number): number {
  const scale = AUDIO.scale;
  const octave = Math.floor(n / scale.length);
  const idx = ((n % scale.length) + scale.length) % scale.length;
  return scale[idx]! + octave * 12;
}

function makeNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * 2);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}
