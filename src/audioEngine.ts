// ============================================================================
// POLYPHONIC CHORD PROGRESSION AUDIO PLAYBACK ENGINE
// - Smart Voicing & Range Rules (Frequency safety floor E2-G3 bass, Drop-2 / Open upper voicings C3-G5)
// - Smooth Voice Leading & Automatic Inversions (Common-tone retention & minimal pitch distance)
// - Sample-Accurate Web Audio Lookahead Transport Scheduler (BPM, Meter, Loop, Live Hot-Swap)
// - Humanization & Dynamics (Downstroke/Upstroke micro-strumming, velocity variance, LFO pitch drift)
// - Studio Master Signal Chain (Sub highpass, low-shelf mud cut, warm E-Piano/Acoustic hybrid synth,
//   procedural room convolution reverb, dynamic range compression, and voice-count gain normalization)
// ============================================================================

export interface ScheduledChordMeasureItem {
  chord: string;
  beats: number;
}

export interface TransportStep {
  chord: string;
  beats: number;
  measureIdx: number;
  chordIdxInMeasure: number;
  beatInMeasure: number;
}

interface ActiveVoiceNodes {
  stopTime: number;
  forceRelease: (now: number) => void;
}

const NOTE_TO_SEMITONE: Record<string, number> = {
  'C': 0, 'B#': 0,
  'C#': 1, 'Db': 1,
  'D': 2,
  'D#': 3, 'Eb': 3,
  'E': 4, 'Fb': 4,
  'F': 5, 'E#': 5,
  'F#': 6, 'Gb': 6,
  'G': 7,
  'G#': 8, 'Ab': 8,
  'A': 9,
  'A#': 10, 'Bb': 10,
  'B': 11, 'Cb': 11
};

// Pitch range constants (MIDI note numbers)
const BASS_MIN_MIDI = 40; // E2 (~82.4 Hz) - strict lower floor to prevent sub-bass mud
const BASS_MAX_MIDI = 55; // G3 (~196.0 Hz)
const HARMONY_MIN_MIDI = 48; // C3 (~130.8 Hz) - no close intervals below C3
const HARMONY_MAX_MIDI = 79; // G5 (~784.0 Hz)
const HARMONY_TARGET_CENTROID = 62; // D4 (~293.7 Hz) warm keyboard/guitar center

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function clampBassMidi(pitchClass: number): number {
  // Place in Octave 2 first (C2 = 36)
  let midi = 36 + ((pitchClass % 12) + 12) % 12;
  while (midi < BASS_MIN_MIDI) midi += 12;
  while (midi > BASS_MAX_MIDI) midi -= 12;
  return midi;
}

export interface ParsedChordIntervals {
  rootPc: number;
  bassPc: number;
  hasExplicitBass: boolean;
  guideAndColorIntervals: number[]; // Intervals relative to rootPc for upper structure
}

export function parseChordForVoicing(chordSymbol: string): ParsedChordIntervals {
  if (!chordSymbol || !chordSymbol.trim()) {
    return { rootPc: 0, bassPc: 0, hasExplicitBass: false, guideAndColorIntervals: [4, 7, 11] };
  }

  const cleanSym = chordSymbol.split('→')[0].trim();
  const slashParts = cleanSym.split('/');
  const mainPart = slashParts[0].trim();
  const rawBass = slashParts.length > 1 ? slashParts[1].trim() : null;

  const rootMatch = mainPart.match(/^([a-gA-G][#b]?)(.*)$/);
  if (!rootMatch) {
    return { rootPc: 0, bassPc: 0, hasExplicitBass: false, guideAndColorIntervals: [4, 7, 11] };
  }

  const rootName = rootMatch[1].charAt(0).toUpperCase() + rootMatch[1].slice(1);
  const qual = rootMatch[2].trim();
  const qualLower = qual.toLowerCase();

  const rootPc = NOTE_TO_SEMITONE[rootName] ?? 0;
  let bassPc = rootPc;
  let hasExplicitBass = false;

  if (rawBass) {
    const bassMatch = rawBass.match(/^([a-gA-G][#b]?)/);
    if (bassMatch) {
      const bassName = bassMatch[1].charAt(0).toUpperCase() + bassMatch[1].slice(1);
      if (NOTE_TO_SEMITONE[bassName] !== undefined) {
        bassPc = NOTE_TO_SEMITONE[bassName];
        hasExplicitBass = true;
      }
    }
  }

  // Classify chord quality & extensions
  const isFullDim = qual.includes('°') || qualLower.includes('dim7');
  const isHalfDim = qual.includes('ø') || qualLower.includes('m7b5') || qualLower.includes('m7(b5)');
  const isDimTriad = !isFullDim && !isHalfDim && qualLower.includes('dim');
  const isMinorMaj7 = qual.includes('m(maj7)') || qual.includes('mΔ') || qualLower.includes('mmaj7');
  const isMaj7 = !isMinorMaj7 && (qual.includes('Δ') || qualLower.includes('maj7') || qual.includes('M7'));
  const isMinor =
    isMinorMaj7 ||
    isHalfDim ||
    isFullDim ||
    isDimTriad ||
    (qualLower.startsWith('m') && !qualLower.startsWith('maj'));
  const isAug = qual.includes('+') || qualLower.includes('aug') || qualLower.includes('#5');
  const isAlt = qualLower.includes('alt');
  const isSus4 = qualLower.includes('sus4') || (qualLower.includes('sus') && !qualLower.includes('sus2'));
  const isSus2 = qualLower.includes('sus2');

  // 1. Third / Suspended degree
  let thirdInterval = 4;
  if (isSus4) thirdInterval = 5;
  else if (isSus2) thirdInterval = 2;
  else if (isMinor) thirdInterval = 3;

  // 2. Fifth degree
  let fifthInterval = 7;
  if (isFullDim || isHalfDim || isDimTriad || qualLower.includes('b5')) {
    fifthInterval = 6;
  } else if (isAug || isAlt) {
    fifthInterval = 8; // #5 / b13
  }

  // 3. Seventh or Sixth degree
  let seventhInterval: number | null = null;
  if (isFullDim) {
    seventhInterval = 9; // bb7
  } else if (isMinorMaj7 || isMaj7) {
    seventhInterval = 11; // maj7
  } else if (
    isHalfDim ||
    isAlt ||
    qualLower.includes('7') ||
    qualLower.includes('9') ||
    qualLower.includes('11') ||
    qualLower.includes('13')
  ) {
    if (!qualLower.includes('add9') && !qualLower.includes('add2')) {
      seventhInterval = 10; // b7
    }
  } else if (qualLower === '6' || qualLower === 'm6' || qualLower.includes('6')) {
    seventhInterval = 9; // 6th
  }

  // 4. Extensions (9th, b9, #9, 13th)
  let extensionInterval: number | null = null;
  if (qualLower.includes('b9') || qual.includes('♭9')) {
    extensionInterval = 13; // b9
  } else if (qualLower.includes('#9') || isAlt) {
    extensionInterval = 15; // #9
  } else if (qualLower.includes('9') || qualLower.includes('add9') || qualLower.includes('add2')) {
    extensionInterval = 14; // 9
  } else if (qualLower.includes('13')) {
    extensionInterval = 21; // 13
  }

  const intervals: number[] = [];
  // Always include 3rd and 7th (guide tones), plus 5th and/or color extension
  intervals.push(thirdInterval);
  if (seventhInterval !== null) {
    intervals.push(seventhInterval);
  }
  intervals.push(fifthInterval);

  if (extensionInterval !== null) {
    intervals.push(extensionInterval);
  } else {
    // Include root in upper structure for triads or 4-note fullness
    intervals.push(0);
  }

  return {
    rootPc,
    bassPc,
    hasExplicitBass,
    guideAndColorIntervals: intervals
  };
}

/**
 * Generates candidate upper-structure voicings (inversions + Drop-2 open voicings)
 * strictly within [HARMONY_MIN_MIDI (C3=48), HARMONY_MAX_MIDI (G5=79)],
 * ensuring no close intervals (< 5 semitones) exist below C3.
 */
function generateCandidateUpperVoicings(
  rootPc: number,
  bassMidi: number,
  intervals: number[]
): number[][] {
  // Unique pitch classes for the upper harmony voices
  const pcs: number[] = [];
  intervals.forEach(intv => {
    const pc = (((rootPc + intv) % 12) + 12) % 12;
    if (!pcs.includes(pc)) pcs.push(pc);
  });
  while (pcs.length < 3) {
    const fallbackPc = (rootPc + (pcs.length === 1 ? 7 : 12)) % 12;
    if (!pcs.includes(fallbackPc)) pcs.push(fallbackPc);
    else break;
  }

  const candidates: number[][] = [];
  const minUpperMidi = Math.max(HARMONY_MIN_MIDI, bassMidi + 5); // At least a fourth above bass

  // Build close-position inversions across octaves 3 and 4, then also derive Drop-2 voicings
  for (let startOctave = 3; startOctave <= 4; startOctave++) {
    for (let inv = 0; inv < pcs.length; inv++) {
      const rotated = [...pcs.slice(inv), ...pcs.slice(0, inv)];
      const closeVoicing: number[] = [];
      let currentMidi = 12 * (startOctave + 1) + rotated[0];

      for (let i = 0; i < rotated.length; i++) {
        let m = 12 * (startOctave + 1) + rotated[i];
        while (i > 0 && m <= closeVoicing[i - 1]) {
          m += 12;
        }
        // Prevent 2nds in the lower-mid register (< E4 = 64) from sounding clustered
        if (i > 0 && m - closeVoicing[i - 1] <= 2 && closeVoicing[i - 1] < 60) {
          m += 12;
        }
        closeVoicing.push(m);
      }

      closeVoicing.sort((a, b) => a - b);

      // Validate range & mud rules
      if (
        closeVoicing[0] >= minUpperMidi &&
        closeVoicing[closeVoicing.length - 1] <= HARMONY_MAX_MIDI &&
        !(closeVoicing.length >= 2 && closeVoicing[0] < 52 && closeVoicing[1] - closeVoicing[0] < 4)
      ) {
        candidates.push(closeVoicing);
      }

      // Create Drop-2 open voicing from 4-note close voicing:
      // Drop the second-highest voice down 1 octave for lush open spacing
      if (closeVoicing.length >= 4) {
        const drop2 = [...closeVoicing];
        const secondHighestIdx = drop2.length - 2;
        drop2[secondHighestIdx] -= 12;
        drop2.sort((a, b) => a - b);

        const lowestGap = drop2[1] - drop2[0];
        if (
          drop2[0] >= minUpperMidi &&
          drop2[drop2.length - 1] <= HARMONY_MAX_MIDI &&
          (drop2[0] >= 52 || lowestGap >= 4)
        ) {
          candidates.push(drop2);
        }
      }
    }
  }

  if (candidates.length === 0) {
    // Safe fallback centered around C4
    const fallback = pcs.map((pc, idx) => 60 + pc + (idx > 2 ? 12 : 0)).sort((a, b) => a - b);
    return [fallback];
  }

  return candidates;
}

/**
 * Computes the optimal full voicing [bassMidi, ...upperHarmonyMidi] using smooth voice leading
 * from `prevUpperVoices` when available.
 */
export function computeSmartVoicing(
  chordSymbol: string,
  prevUpperVoices: number[] | null = null
): { bassMidi: number; upperMidis: number[]; allMidis: number[] } {
  const parsed = parseChordForVoicing(chordSymbol);
  const bassMidi = clampBassMidi(parsed.bassPc);
  const candidates = generateCandidateUpperVoicings(
    parsed.rootPc,
    bassMidi,
    parsed.guideAndColorIntervals
  );

  let bestCandidate = candidates[0];
  let bestScore = Infinity;

  for (const cand of candidates) {
    const centroid = cand.reduce((acc, m) => acc + m, 0) / cand.length;
    const centroidPenalty = Math.abs(centroid - HARMONY_TARGET_CENTROID) * 1.35;
    const span = cand[cand.length - 1] - cand[0];
    // Prefer open voicings spanning roughly an octave (10-16 semitones)
    const spanPenalty = span < 8 ? (8 - span) * 1.5 : span > 18 ? (span - 18) * 1.2 : 0;

    let score = centroidPenalty + spanPenalty;

    if (prevUpperVoices && prevUpperVoices.length > 0) {
      // Voice-leading distance calculation:
      // Match each note in `cand` to the nearest voice in `prevUpperVoices`
      let voiceMotion = 0;
      let commonToneBonus = 0;
      const len = Math.min(cand.length, prevUpperVoices.length);

      for (let i = 0; i < len; i++) {
        const diff = Math.abs(cand[i] - prevUpperVoices[i]);
        if (diff === 0) {
          commonToneBonus += 2.5; // Reward keeping shared notes stationary
        } else {
          voiceMotion += diff + (diff > 5 ? (diff - 5) * 1.8 : 0);
        }
      }
      score = voiceMotion * 2.2 + centroidPenalty * 0.65 + spanPenalty - commonToneBonus;
    }

    if (score < bestScore) {
      bestScore = score;
      bestCandidate = cand;
    }
  }

  return {
    bassMidi,
    upperMidis: bestCandidate,
    allMidis: [bassMidi, ...bestCandidate]
  };
}

export class ChordAudioEngine {
  private ctx: AudioContext | null = null;
  private masterInput: GainNode | null = null;
  private masterCompressor: DynamicsCompressorNode | null = null;
  private activeVoices: ActiveVoiceNodes[] = [];
  private lastUpperVoices: number[] | null = null;

  // Transport state
  private isPlaying = false;
  private isLooping = true;
  private bpm = 104;
  private meter = 4;
  private steps: TransportStep[] = [];
  private currentStepIndex = 0;
  private nextStepTime = 0;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private uiTimers: ReturnType<typeof setTimeout>[] = [];
  private strumCounter = 0;

  private onHighlightCallback: ((measureIdx: number | null, chordIdx: number | null) => void) | null = null;
  private onStateChangeCallback: ((playing: boolean) => void) | null = null;

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
      this.buildMasterSignalChain(this.ctx);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  /**
   * Builds the studio signal processing chain:
   * Input -> Highpass (55Hz sub-cut) -> Low-Shelf (135Hz mud-cut) -> Warm Mid Presence
   * -> Dry/Wet Studio Room Convolution Reverb -> Master Compressor/Limiter -> Destination
   */
  private buildMasterSignalChain(ctx: AudioContext) {
    this.masterInput = ctx.createGain();
    this.masterInput.gain.setValueAtTime(0.9, ctx.currentTime);

    // 1. Sub-bass safety highpass filter (removes < 55 Hz rumble and DC bias)
    const subHighpass = ctx.createBiquadFilter();
    subHighpass.type = 'highpass';
    subHighpass.frequency.setValueAtTime(55, ctx.currentTime);
    subHighpass.Q.setValueAtTime(0.707, ctx.currentTime);

    // 2. Low-shelf filter to trim 100-150 Hz low-end mud
    const mudLowShelf = ctx.createBiquadFilter();
    mudLowShelf.type = 'lowshelf';
    mudLowShelf.frequency.setValueAtTime(140, ctx.currentTime);
    mudLowShelf.gain.setValueAtTime(-3.8, ctx.currentTime);

    // 3. Gentle high-mid warmth & articulation presence
    const presenceFilter = ctx.createBiquadFilter();
    presenceFilter.type = 'peaking';
    presenceFilter.frequency.setValueAtTime(2200, ctx.currentTime);
    presenceFilter.Q.setValueAtTime(0.85, ctx.currentTime);
    presenceFilter.gain.setValueAtTime(1.2, ctx.currentTime);

    // 4. Master Dynamics Compressor / Limiter for uniform level across 3-note to 6-note chords
    this.masterCompressor = ctx.createDynamicsCompressor();
    this.masterCompressor.threshold.setValueAtTime(-16, ctx.currentTime);
    this.masterCompressor.knee.setValueAtTime(10, ctx.currentTime);
    this.masterCompressor.ratio.setValueAtTime(3.8, ctx.currentTime);
    this.masterCompressor.attack.setValueAtTime(0.004, ctx.currentTime);
    this.masterCompressor.release.setValueAtTime(0.22, ctx.currentTime);

    // 5. Algorithmic / Convolution Stereo Room Reverb
    const dryGain = ctx.createGain();
    dryGain.gain.setValueAtTime(0.84, ctx.currentTime);

    const wetGain = ctx.createGain();
    wetGain.gain.setValueAtTime(0.2, ctx.currentTime);

    const convolver = ctx.createConvolver();
    convolver.buffer = this.createRoomImpulseBuffer(ctx, 1.65, 3.2);

    // Connect graph
    this.masterInput.connect(subHighpass);
    subHighpass.connect(mudLowShelf);
    mudLowShelf.connect(presenceFilter);

    presenceFilter.connect(dryGain);
    dryGain.connect(this.masterCompressor);

    presenceFilter.connect(convolver);
    convolver.connect(wetGain);
    wetGain.connect(this.masterCompressor);

    this.masterCompressor.connect(ctx.destination);
  }

  /**
   * Generates a natural stereo studio-room impulse response with pre-delay and high-frequency damping.
   */
  private createRoomImpulseBuffer(ctx: AudioContext, durationSec: number, decayRate: number): AudioBuffer {
    const sampleRate = ctx.sampleRate;
    const length = Math.floor(sampleRate * durationSec);
    const impulse = ctx.createBuffer(2, length, sampleRate);
    const preDelaySamples = Math.floor(sampleRate * 0.014); // 14ms studio pre-delay

    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      let lpState = 0;
      for (let i = 0; i < length; i++) {
        if (i < preDelaySamples) {
          data[i] = 0;
          continue;
        }
        const t = (i - preDelaySamples) / (length - preDelaySamples);
        const env = Math.pow(1 - t, decayRate);
        const white = Math.random() * 2 - 1;
        // Progressive high-frequency air absorption damping
        const damping = 0.35 + 0.5 * (1 - t);
        lpState = lpState + damping * (white - lpState);
        data[i] = lpState * env * 0.65;
      }
    }
    return impulse;
  }

  /**
   * Releases any currently sounding notes smoothly (prevents mud when switching chords quickly).
   */
  private releaseActiveVoicesAt(releaseTime: number) {
    const remaining: ActiveVoiceNodes[] = [];
    for (const v of this.activeVoices) {
      if (v.stopTime > releaseTime + 0.04) {
        v.forceRelease(releaseTime);
      }
    }
    this.activeVoices = remaining;
  }

  /**
   * Synthesizes a single polyphonic voice with:
   * - Subtle random detuning (±3 to 8 cents) + slow LFO pitch drift
   * - Velocity variation & voice-count gain normalization
   * - Warm E-Piano / Acoustic Plucked string-key hybrid timbre
   * - Smooth click-free ADSR envelope (15ms attack, 380ms release)
   */
  private scheduleSingleVoice(
    midi: number,
    startTime: number,
    holdDuration: number,
    isBass: boolean,
    velocity: number,
    normalizationFactor: number
  ) {
    const ctx = this.ensureContext();
    if (!this.masterInput) return;

    const freq = midiToFreq(midi);
    const attackSec = isBass ? 0.014 : 0.016;
    const releaseSec = isBass ? 0.42 : 0.38;
    const totalDuration = Math.max(holdDuration + releaseSec, attackSec + 0.25);
    const stopTime = startTime + totalDuration + 0.03;

    // 1. Primary Warm Oscillator (Triangle for bass body, Sine/Triangle hybrid for upper harmony)
    const oscFundamental = ctx.createOscillator();
    oscFundamental.type = isBass ? 'triangle' : 'sine';
    oscFundamental.frequency.setValueAtTime(freq, startTime);

    // 2. Harmonic Body Oscillator with subtle fine detune (±3 to 8 cents)
    const oscWarmHarmonic = ctx.createOscillator();
    oscWarmHarmonic.type = 'triangle';
    oscWarmHarmonic.frequency.setValueAtTime(freq, startTime);
    const randomDetuneCents = (Math.random() * 10 - 5) + (isBass ? -2 : 3.5);
    oscWarmHarmonic.detune.setValueAtTime(randomDetuneCents, startTime);
    oscFundamental.detune.setValueAtTime(-randomDetuneCents * 0.4, startTime);

    // 3. Soft Plucked / Rhodes Tine Attack Harmonic (decays quickly for natural articulation)
    const oscTransient = ctx.createOscillator();
    oscTransient.type = 'sine';
    oscTransient.frequency.setValueAtTime(freq * (isBass ? 2 : 3), startTime);

    // 4. Slow LFO Pitch Drift (±3.5 cents organic drift)
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(0.38 + Math.random() * 0.3, startTime);
    lfoGain.gain.setValueAtTime(3.5, startTime);
    lfo.connect(lfoGain);
    lfoGain.connect(oscWarmHarmonic.detune);

    // Mix gains per oscillator
    const gainFund = ctx.createGain();
    const gainHarm = ctx.createGain();
    const gainTrans = ctx.createGain();

    const baseLevel = (isBass ? 0.42 : 0.28) * velocity * normalizationFactor;
    gainFund.gain.setValueAtTime(baseLevel, startTime);
    gainHarm.gain.setValueAtTime(baseLevel * (isBass ? 0.38 : 0.46), startTime);

    // Pluck/tine transient envelope
    gainTrans.gain.setValueAtTime(baseLevel * (isBass ? 0.14 : 0.18), startTime);
    gainTrans.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.085);

    // Dynamic lowpass filter per voice (simulates acoustic string/hammer brightness decay)
    const voiceFilter = ctx.createBiquadFilter();
    voiceFilter.type = 'lowpass';
    const baseCutoff = isBass ? 520 : Math.min(3400, Math.max(1100, freq * 3.6));
    const peakCutoff = Math.min(6500, baseCutoff * (1.7 + velocity * 0.5));
    voiceFilter.frequency.setValueAtTime(peakCutoff, startTime);
    voiceFilter.frequency.exponentialRampToValueAtTime(baseCutoff, startTime + 0.32);

    // Click-free ADSR Voice Envelope
    const envGain = ctx.createGain();
    envGain.gain.setValueAtTime(0.0001, startTime);
    envGain.gain.linearRampToValueAtTime(1.0, startTime + attackSec);
    envGain.gain.exponentialRampToValueAtTime(0.62, startTime + attackSec + 0.28);
    envGain.gain.exponentialRampToValueAtTime(0.32, startTime + holdDuration);
    envGain.gain.exponentialRampToValueAtTime(0.0001, startTime + holdDuration + releaseSec);

    oscFundamental.connect(gainFund);
    oscWarmHarmonic.connect(gainHarm);
    oscTransient.connect(gainTrans);

    gainFund.connect(voiceFilter);
    gainHarm.connect(voiceFilter);
    gainTrans.connect(voiceFilter);

    voiceFilter.connect(envGain);
    envGain.connect(this.masterInput);

    oscFundamental.start(startTime);
    oscWarmHarmonic.start(startTime);
    oscTransient.start(startTime);
    lfo.start(startTime);

    oscFundamental.stop(stopTime);
    oscWarmHarmonic.stop(stopTime);
    oscTransient.stop(stopTime);
    lfo.stop(stopTime);

    let released = false;
    const voiceRecord: ActiveVoiceNodes = {
      stopTime,
      forceRelease: (now: number) => {
        if (released) return;
        released = true;
        try {
          const t = Math.max(now, ctx.currentTime);
          envGain.gain.cancelScheduledValues(t);
          envGain.gain.setValueAtTime(Math.max(0.0002, envGain.gain.value || 0.2), t);
          envGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
          const earlyStop = t + 0.16;
          if (earlyStop < stopTime) {
            oscFundamental.stop(earlyStop);
            oscWarmHarmonic.stop(earlyStop);
            oscTransient.stop(earlyStop);
            lfo.stop(earlyStop);
          }
        } catch {}
      }
    };

    this.activeVoices.push(voiceRecord);
  }

  /**
   * Schedules a complete humanized, voice-led chord at `startTime` (AudioContext time).
   */
  public scheduleChordAtTime(
    chordSymbol: string,
    startTime: number,
    durationSec: number,
    strumDirection: 'down' | 'up' = 'down',
    accentMultiplier = 1.0
  ) {
    const voicing = computeSmartVoicing(chordSymbol, this.lastUpperVoices);
    this.lastUpperVoices = voicing.upperMidis;

    // Fade out any overlapping prior chord voices cleanly at startTime
    this.releaseActiveVoicesAt(startTime);

    const numVoices = voicing.allMidis.length;
    // Gain normalization so 5-6 note jazz chords match 3-note triads in loudness
    const normalizationFactor = 1 / Math.pow(Math.max(3, numVoices), 0.54);

    // Order pitches according to strum direction:
    // DOWNSTROKE: Bass first -> lowest to highest upper voices (full, warm downbeat)
    // UPSTROKE: Highest to lowest upper voices, with subtle bass anchor
    const orderedVoices: { midi: number; isBass: boolean }[] =
      strumDirection === 'down'
        ? [
            { midi: voicing.bassMidi, isBass: true },
            ...voicing.upperMidis.map(m => ({ midi: m, isBass: false }))
          ]
        : [
            { midi: voicing.bassMidi, isBass: true },
            ...[...voicing.upperMidis].reverse().map(m => ({ midi: m, isBass: false }))
          ];

    // Staggered strumming micro-delay (16ms - 24ms between consecutive strings/voices)
    const baseStaggerSec = strumDirection === 'down' ? 0.019 : 0.015;

    orderedVoices.forEach((voice, idx) => {
      const jitterSec = (Math.random() - 0.5) * 0.004; // ±2ms human micro-timing variance
      const noteOffset = Math.max(0, idx * baseStaggerSec + jitterSec);
      const noteStart = startTime + noteOffset;

      // Velocity humanization (±8% random variance + slight top-note & bass contour)
      const isTopVoice = idx === orderedVoices.length - 1;
      const contour = voice.isBass ? 1.05 : isTopVoice ? 1.03 : 0.94;
      const humanVelocityVariance = 0.92 + Math.random() * 0.16;
      const velocity = Math.min(1.15, contour * humanVelocityVariance * accentMultiplier);

      this.scheduleSingleVoice(
        voice.midi,
        noteStart,
        Math.max(0.22, durationSec - noteOffset),
        voice.isBass,
        velocity,
        normalizationFactor
      );
    });
  }

  /**
   * Immediately plays a single chord (when tapping a chord in the UI).
   */
  public playSingleChord(chordSymbol: string, beats = 2) {
    if (!chordSymbol) return;
    if (this.isPlaying) {
      this.stop();
    }
    const ctx = this.ensureContext();
    const secPerBeat = 60 / this.bpm;
    const durationSec = Math.min(3.2, Math.max(0.75, beats * secPerBeat * 0.92));
    const direction: 'down' | 'up' = this.strumCounter++ % 2 === 0 ? 'down' : 'up';
    this.scheduleChordAtTime(chordSymbol, ctx.currentTime + 0.005, durationSec, direction, 1.0);
  }

  /**
   * Flattens measures into schedulable transport steps with measure/chord indices.
   */
  private buildStepsFromMeasures(measures: ScheduledChordMeasureItem[][]): TransportStep[] {
    const steps: TransportStep[] = [];
    measures.forEach((meas, mIdx) => {
      let beatCursor = 0;
      meas.forEach((item, cIdx) => {
        if (!item.chord) return;
        const b = Math.max(1, item.beats || 1);
        steps.push({
          chord: item.chord,
          beats: b,
          measureIdx: mIdx,
          chordIdxInMeasure: cIdx,
          beatInMeasure: beatCursor
        });
        beatCursor += b;
      });
    });
    return steps;
  }

  /**
   * Starts sample-accurate transport playback of the progression.
   */
  public startProgression(
    measures: ScheduledChordMeasureItem[][],
    options?: {
      bpm?: number;
      loop?: boolean;
      meter?: number;
      onHighlight?: (measureIdx: number | null, chordIdx: number | null) => void;
      onStateChange?: (playing: boolean) => void;
    }
  ) {
    const ctx = this.ensureContext();
    if (options?.bpm) this.bpm = Math.max(50, Math.min(220, options.bpm));
    if (options?.loop !== undefined) this.isLooping = options.loop;
    if (options?.meter) this.meter = options.meter;
    if (options?.onHighlight) this.onHighlightCallback = options.onHighlight;
    if (options?.onStateChange) this.onStateChangeCallback = options.onStateChange;

    this.steps = this.buildStepsFromMeasures(measures);
    if (this.steps.length === 0) return;

    this.clearTimers();
    this.lastUpperVoices = null; // Fresh voice-leading anchor at start of progression
    this.currentStepIndex = 0;
    this.isPlaying = true;
    this.nextStepTime = ctx.currentTime + 0.025;

    if (this.onStateChangeCallback) {
      this.onStateChangeCallback(true);
    }

    this.runLookaheadScheduler();
    this.schedulerTimer = setInterval(() => this.runLookaheadScheduler(), 25);
  }

  /**
   * Updates the progression measures live during playback (e.g., when user taps Randomize
   * or switches Reharm Technique while listening!).
   */
  public updatePlayingMeasures(measures: ScheduledChordMeasureItem[][], meter?: number) {
    if (meter) this.meter = meter;
    const newSteps = this.buildStepsFromMeasures(measures);
    if (newSteps.length === 0) {
      if (this.isPlaying) this.stop();
      return;
    }
    this.steps = newSteps;
    if (this.currentStepIndex >= this.steps.length) {
      this.currentStepIndex = 0;
    }
  }

  private runLookaheadScheduler() {
    if (!this.isPlaying || !this.ctx) return;
    const scheduleAheadTime = 0.14; // 140ms lookahead window

    while (this.nextStepTime < this.ctx.currentTime + scheduleAheadTime) {
      if (this.currentStepIndex >= this.steps.length) {
        if (this.isLooping && this.steps.length > 0) {
          this.currentStepIndex = 0;
        } else {
          // Schedule transport stop right when the final chord finishes
          const stopDelayMs = Math.max(0, (this.nextStepTime - this.ctx.currentTime) * 1000);
          const endTimer = setTimeout(() => {
            this.stop();
          }, stopDelayMs);
          this.uiTimers.push(endTimer);
          if (this.schedulerTimer) {
            clearInterval(this.schedulerTimer);
            this.schedulerTimer = null;
          }
          return;
        }
      }

      const step = this.steps[this.currentStepIndex];
      const secPerBeat = 60 / this.bpm;
      const stepDurationSec = step.beats * secPerBeat;
      const playTime = this.nextStepTime;

      // Downstroke on beat 0 of a measure (fuller attack), subtle upstroke on inner-measure changes
      const isDownbeat = step.beatInMeasure === 0;
      const strumDir: 'down' | 'up' = isDownbeat ? 'down' : 'up';
      const accent = isDownbeat ? 1.04 : 0.93;

      this.scheduleChordAtTime(
        step.chord,
        playTime,
        stepDurationSec * 0.94,
        strumDir,
        accent
      );

      // Schedule sample-synced visual highlight
      const delayMs = Math.max(0, (playTime - this.ctx.currentTime) * 1000);
      const mIdx = step.measureIdx;
      const cIdx = step.chordIdxInMeasure;
      const uiTimer = setTimeout(() => {
        if (this.isPlaying && this.onHighlightCallback) {
          this.onHighlightCallback(mIdx, cIdx);
        }
      }, delayMs);
      this.uiTimers.push(uiTimer);

      this.nextStepTime += stepDurationSec;
      this.currentStepIndex++;
    }
  }

  public stop() {
    this.isPlaying = false;
    this.clearTimers();
    if (this.ctx) {
      this.releaseActiveVoicesAt(this.ctx.currentTime);
    }
    if (this.onHighlightCallback) {
      this.onHighlightCallback(null, null);
    }
    if (this.onStateChangeCallback) {
      this.onStateChangeCallback(false);
    }
  }

  private clearTimers() {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    for (const t of this.uiTimers) {
      clearTimeout(t);
    }
    this.uiTimers = [];
  }

  public getIsPlaying(): boolean {
    return this.isPlaying;
  }

  public getBpm(): number {
    return this.bpm;
  }

  public setBpm(newBpm: number) {
    this.bpm = Math.max(50, Math.min(220, Math.round(newBpm)));
  }

  public getIsLooping(): boolean {
    return this.isLooping;
  }

  public setIsLooping(loop: boolean) {
    this.isLooping = loop;
  }
}

export const audioEngine = new ChordAudioEngine();
