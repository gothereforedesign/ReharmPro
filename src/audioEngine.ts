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
const BASS_MIN_MIDI = 38; // D2 (~73.4 Hz) - clean deep bass floor
const BASS_MAX_MIDI = 50; // D3 (~146.8 Hz) - prevents bass from crowding middle register
const BASS_TARGET_MIDI = 43; // G2 (~98.0 Hz) - warm acoustic bass center
const HARMONY_MIN_MIDI = 48; // C3 (~130.8 Hz) - no close intervals below C3
const HARMONY_MAX_MIDI = 70; // Bb4 (~466.2 Hz) - prevents piercing high-octave jumps
const HARMONY_TARGET_CENTROID = 59.0; // B3 (~246.9 Hz) - warm, cohesive piano middle register

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Chooses the optimal bass MIDI note in [BASS_MIN_MIDI..BASS_MAX_MIDI],
 * balancing smooth voice-leading from `prevBassMidi` with a warm anchor around G2 (43).
 */
function chooseBassMidi(pitchClass: number, prevBassMidi: number | null = null): number {
  const pc = ((pitchClass % 12) + 12) % 12;
  const candidates: number[] = [];
  for (let oct = 2; oct <= 4; oct++) {
    const m = 12 * oct + pc;
    if (m >= BASS_MIN_MIDI && m <= BASS_MAX_MIDI + 2) {
      candidates.push(m);
    }
  }
  if (candidates.length === 0) {
    let fallback = 36 + pc;
    while (fallback < BASS_MIN_MIDI) fallback += 12;
    while (fallback > BASS_MAX_MIDI) fallback -= 12;
    return fallback;
  }

  let best = candidates[0];
  let bestScore = Infinity;
  for (const m of candidates) {
    const centerPenalty = Math.abs(m - BASS_TARGET_MIDI) * 0.7;
    const rangePenalty = m > BASS_MAX_MIDI ? (m - BASS_MAX_MIDI) * 2.5 : 0;
    const motionPenalty =
      prevBassMidi !== null ? Math.abs(m - prevBassMidi) * 1.4 : 0;
    const score = centerPenalty + rangePenalty + motionPenalty;
    if (score < bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
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
 * Generates candidate 4-voice upper-structure voicings (sorted close inversions + Drop-2 voicings)
 * strictly within [HARMONY_MIN_MIDI (C3=48), HARMONY_MAX_MIDI (Bb4=70)],
 * ensuring consistent 4-voice hand density across triads and 7th/extended chords.
 */
function generateCandidateUpperVoicings(
  rootPc: number,
  bassMidi: number,
  intervals: number[]
): number[][] {
  // Unique pitch classes for the upper harmony voices, sorted in ascending pitch-class order [0..11]
  // Sorting prevents inversions from accidentally leaping across two octaves!
  const pcs: number[] = [];
  intervals.forEach(intv => {
    const pc = (((rootPc + intv) % 12) + 12) % 12;
    if (!pcs.includes(pc)) pcs.push(pc);
  });
  while (pcs.length < 3) {
    const fallbackPc = (rootPc + (pcs.length === 1 ? 7 : 4)) % 12;
    if (!pcs.includes(fallbackPc)) pcs.push(fallbackPc);
    else break;
  }
  pcs.sort((a, b) => a - b);

  const candidates: number[][] = [];
  const minUpperMidi = Math.max(HARMONY_MIN_MIDI, bassMidi + 4); // At least a major third above bass

  // Build true close-position 4-voice piano inversions across octaves 2, 3, and 4
  for (let startOctave = 2; startOctave <= 4; startOctave++) {
    for (let inv = 0; inv < pcs.length; inv++) {
      const rotated = [...pcs.slice(inv), ...pcs.slice(0, inv)];
      // Ensure a consistent 4-voice upper structure (for 3-note triads, double the bottom note of the inversion an octave up)
      const fourPcs =
        rotated.length === 3
          ? [rotated[0], rotated[1], rotated[2], rotated[0]]
          : rotated.slice(0, 4);

      const closeVoicing: number[] = [];

      for (let i = 0; i < fourPcs.length; i++) {
        let m = 12 * (startOctave + 1) + fourPcs[i];
        while (i > 0 && m <= closeVoicing[i - 1]) {
          m += 12;
        }
        // If two lower voices form a tight minor 2nd (1 semitone) below F3 (53), open the upper voice by an octave
        if (i === 1 && m - closeVoicing[0] === 1 && closeVoicing[0] < 54) {
          m += 12;
        }
        closeVoicing.push(m);
      }

      closeVoicing.sort((a, b) => a - b);

      // Validate range & low-register clarity rules
      const span = closeVoicing[closeVoicing.length - 1] - closeVoicing[0];
      const hasLowCluster =
        closeVoicing.length >= 2 &&
        closeVoicing[0] < 52 &&
        closeVoicing[1] - closeVoicing[0] < 3;

      if (
        closeVoicing[0] >= minUpperMidi &&
        closeVoicing[closeVoicing.length - 1] <= HARMONY_MAX_MIDI &&
        span <= 14 &&
        !hasLowCluster
      ) {
        candidates.push(closeVoicing);
      }

      // Also derive a Drop-2 open voicing when it remains compact and within the warm piano pocket
      if (closeVoicing.length === 4) {
        const drop2 = [...closeVoicing];
        drop2[2] -= 12; // Drop second-highest voice by 1 octave
        drop2.sort((a, b) => a - b);

        const dropSpan = drop2[3] - drop2[0];
        const lowestGap = drop2[1] - drop2[0];
        if (
          drop2[0] >= minUpperMidi &&
          drop2[3] <= HARMONY_MAX_MIDI &&
          dropSpan <= 16 &&
          (drop2[0] >= 52 || lowestGap >= 4)
        ) {
          candidates.push(drop2);
        }
      }
    }
  }

  if (candidates.length === 0) {
    // Safe compact fallback centered around B3/C4
    const fallback: number[] = [];
    const fourPcs = pcs.length === 3 ? [pcs[0], pcs[1], pcs[2], pcs[0]] : pcs.slice(0, 4);
    for (let i = 0; i < fourPcs.length; i++) {
      let m = 48 + fourPcs[i];
      while (m < 52) m += 12;
      while (i > 0 && m <= fallback[i - 1]) m += 12;
      fallback.push(m);
    }
    return [fallback.sort((a, b) => a - b)];
  }

  return candidates;
}

/**
 * Computes the optimal full voicing [bassMidi, ...upperHarmonyMidi] using smooth voice leading
 * from `prevUpperVoices` and `prevBassMidi` when available.
 * Prevents jarring range jumps (such as F to B7) by anchoring common tones,
 * minimizing individual voice motion, and locking soprano (top-voice) and centroid continuity.
 */
export function computeSmartVoicing(
  chordSymbol: string,
  prevUpperVoices: number[] | null = null,
  prevBassMidi: number | null = null
): { bassMidi: number; upperMidis: number[]; allMidis: number[] } {
  const parsed = parseChordForVoicing(chordSymbol);
  const bassMidi = chooseBassMidi(parsed.bassPc, prevBassMidi);
  const candidates = generateCandidateUpperVoicings(
    parsed.rootPc,
    bassMidi,
    parsed.guideAndColorIntervals
  );

  let bestCandidate = candidates[0];
  let bestScore = Infinity;

  for (const cand of candidates) {
    const centroid = cand.reduce((acc, m) => acc + m, 0) / cand.length;
    const centroidPenalty = Math.abs(centroid - HARMONY_TARGET_CENTROID) * 1.6;
    const topNote = cand[cand.length - 1];
    // Gentle penalty for voicings climbing above F4 (65) so chords stay warm and grounded
    const highRegisterPenalty = topNote > 65 ? (topNote - 65) * 1.35 : 0;
    const span = topNote - cand[0];
    // Favor compact piano hand spans (8 to 12 semitones)
    const spanPenalty = span < 7 ? (7 - span) * 1.4 : span > 12 ? (span - 12) * 1.15 : 0;

    let score = centroidPenalty + highRegisterPenalty + spanPenalty;

    if (prevUpperVoices && prevUpperVoices.length > 0) {
      let voiceMotion = 0;
      let commonToneBonus = 0;
      const len = Math.min(cand.length, prevUpperVoices.length);

      for (let i = 0; i < len; i++) {
        const diff = Math.abs(cand[i] - prevUpperVoices[i]);
        // Quadratic penalty for any voice leaping > 3 semitones
        voiceMotion += diff + (diff > 3 ? (diff - 3) * (diff - 3) * 0.95 : 0);
      }

      // Check for common tones across ANY voice pair (e.g., A3=57 shared between F and B7)
      for (const m of cand) {
        if (prevUpperVoices.includes(m)) {
          commonToneBonus += 2.6;
        }
      }

      // Soprano (top-note) continuity: human ear strongly tracks the highest voice
      const prevTop = prevUpperVoices[prevUpperVoices.length - 1];
      const topDiff = Math.abs(topNote - prevTop);
      const topJumpPenalty = topDiff * 1.8 + (topDiff > 3 ? (topDiff - 3) * 2.4 : 0);

      // Overall register centroid continuity between consecutive chords
      const prevCentroid =
        prevUpperVoices.reduce((acc, m) => acc + m, 0) / prevUpperVoices.length;
      const centroidShiftPenalty = Math.abs(centroid - prevCentroid) * 3.1;

      score =
        voiceMotion * 2.1 +
        topJumpPenalty +
        centroidShiftPenalty +
        centroidPenalty * 0.55 +
        highRegisterPenalty +
        spanPenalty -
        commonToneBonus;
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
  private lastBassMidi: number | null = null;

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
   * Input -> Highpass (55Hz sub-cut) -> Low-Shelf (140Hz mud-cut) -> Soundboard Warmth (580Hz)
   * -> Master Gentle Lowpass (2550Hz to tame upper pitches) -> Dry/Wet Room Reverb -> Compressor -> Destination
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
    mudLowShelf.gain.setValueAtTime(-3.6, ctx.currentTime);

    // 3. Acoustic Piano Soundboard Body Warmth (580 Hz gentle resonance)
    const bodyWarmthFilter = ctx.createBiquadFilter();
    bodyWarmthFilter.type = 'peaking';
    bodyWarmthFilter.frequency.setValueAtTime(580, ctx.currentTime);
    bodyWarmthFilter.Q.setValueAtTime(0.75, ctx.currentTime);
    bodyWarmthFilter.gain.setValueAtTime(0.85, ctx.currentTime);

    // 4. Master Gentle Low-Pass Filter to keep higher pitches warm & never piercing
    const masterLowpass = ctx.createBiquadFilter();
    masterLowpass.type = 'lowpass';
    masterLowpass.frequency.setValueAtTime(2550, ctx.currentTime);
    masterLowpass.Q.setValueAtTime(0.62, ctx.currentTime);

    // 5. Master Dynamics Compressor / Limiter for uniform level across chords
    this.masterCompressor = ctx.createDynamicsCompressor();
    this.masterCompressor.threshold.setValueAtTime(-16, ctx.currentTime);
    this.masterCompressor.knee.setValueAtTime(10, ctx.currentTime);
    this.masterCompressor.ratio.setValueAtTime(3.8, ctx.currentTime);
    this.masterCompressor.attack.setValueAtTime(0.004, ctx.currentTime);
    this.masterCompressor.release.setValueAtTime(0.22, ctx.currentTime);

    // 6. Algorithmic / Convolution Stereo Room Reverb
    const dryGain = ctx.createGain();
    dryGain.gain.setValueAtTime(0.85, ctx.currentTime);

    const wetGain = ctx.createGain();
    wetGain.gain.setValueAtTime(0.22, ctx.currentTime);

    const convolver = ctx.createConvolver();
    convolver.buffer = this.createRoomImpulseBuffer(ctx, 2.1, 3.0);

    // Connect graph
    this.masterInput.connect(subHighpass);
    subHighpass.connect(mudLowShelf);
    mudLowShelf.connect(bodyWarmthFilter);
    bodyWarmthFilter.connect(masterLowpass);

    masterLowpass.connect(dryGain);
    dryGain.connect(this.masterCompressor);

    masterLowpass.connect(convolver);
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
   * Releases any currently sounding notes with a smooth, musical half-damper tail
   * so chords blend naturally without hard cut-offs or low-end mud.
   */
  private releaseActiveVoicesAt(releaseTime: number) {
    const remaining: ActiveVoiceNodes[] = [];
    for (const v of this.activeVoices) {
      if (v.stopTime > releaseTime + 0.05) {
        v.forceRelease(releaseTime);
      }
    }
    this.activeVoices = remaining;
  }

  /**
   * Synthesizes a single polyphonic voice with:
   * - Piano-like individual voice distinction (tight unison tuning, subtle keyboard stereo spread,
   *   and delicate felt-hammer 2nd-harmonic articulation)
   * - Pitch-scaled gain and progressive per-voice low-pass filtering so higher pitches stay warm
   *   and never cut through harshly
   * - Musical 2-stage natural decay (unified for quarter/half notes, extended for whole-measure chords)
   */
  private scheduleSingleVoice(
    midi: number,
    startTime: number,
    isWholeMeasure: boolean,
    measureDurationSec: number,
    isBass: boolean,
    velocity: number,
    normalizationFactor: number
  ) {
    const ctx = this.ensureContext();
    if (!this.masterInput) return;

    const freq = midiToFreq(midi);
    const attackSec = isBass ? 0.013 : 0.014;

    // Musical decay profiling:
    // - Quarter & Half notes share the exact same natural, unhurried decay curve (~2.6s audible ring)
    // - Whole-measure chords sustain with a fuller harmonic bloom and longer decay (~4.2s+ audible ring)
    const bloomWindow = isWholeMeasure ? 0.50 : 0.34;
    const bloomTargetLevel = isWholeMeasure ? 0.70 : 0.60;
    const bloomTau = isWholeMeasure ? 0.30 : 0.22;

    const wholeBarSustainSec = isWholeMeasure
      ? Math.max(1.85, measureDurationSec * 0.82)
      : 0;
    const singingDecayTau = isWholeMeasure
      ? (isBass ? 0.78 : 0.72)
      : (isBass ? 0.60 : 0.55);

    const naturalRingDuration = isWholeMeasure
      ? attackSec + wholeBarSustainSec + singingDecayTau * 5.2
      : attackSec + bloomWindow + singingDecayTau * 5.2;

    const stopTime = startTime + naturalRingDuration + 0.15;

    // 1. Primary Fundamental Oscillator (Triangle for bass warmth, pure Sine for clear upper voice fundamental)
    const oscFundamental = ctx.createOscillator();
    oscFundamental.type = isBass ? 'triangle' : 'sine';
    oscFundamental.frequency.setValueAtTime(freq, startTime);

    // 2. Piano Unison String Oscillator (tight ±1.8 cent tuning instead of wide synth chorus so voices stay distinct)
    const oscWarmHarmonic = ctx.createOscillator();
    oscWarmHarmonic.type = 'triangle';
    oscWarmHarmonic.frequency.setValueAtTime(freq, startTime);
    const unisonDetuneCents = (Math.random() * 2.4 - 1.2) + (isBass ? -1.0 : 1.4);
    oscWarmHarmonic.detune.setValueAtTime(unisonDetuneCents, startTime);
    oscFundamental.detune.setValueAtTime(-unisonDetuneCents * 0.35, startTime);

    // 3. Acoustic Piano 2nd-Harmonic Overtone (gives clear piano-key distinction during initial bloom without harshness)
    const oscTransient = ctx.createOscillator();
    oscTransient.type = 'sine';
    oscTransient.frequency.setValueAtTime(freq * 2, startTime);

    // 4. Ultra-subtle organic pitch stability (0.8 cents slow drift)
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(0.35 + Math.random() * 0.25, startTime);
    lfoGain.gain.setValueAtTime(0.8, startTime);
    lfo.connect(lfoGain);
    lfoGain.connect(oscWarmHarmonic.detune);

    // Pitch-dependent level scaling (Fletcher-Munson compensation so higher notes never poke out)
    const highPitchAttenuation =
      !isBass && midi > 55 ? Math.pow(0.962, midi - 55) : 1.0;

    // Mix gains per oscillator
    const gainFund = ctx.createGain();
    const gainHarm = ctx.createGain();
    const gainTrans = ctx.createGain();

    const baseLevel =
      (isBass ? 0.42 : 0.29) *
      highPitchAttenuation *
      velocity *
      normalizationFactor;
    gainFund.gain.setValueAtTime(baseLevel, startTime);
    // Slightly less triangle upper-harmonic weight on higher MIDI notes for a rounder treble
    const harmRatio = isBass
      ? 0.36
      : Math.max(0.24, 0.42 - Math.max(0, midi - 55) * 0.01);
    gainHarm.gain.setValueAtTime(baseLevel * harmRatio, startTime);

    // Subtle felt-hammer 2nd harmonic key-strike articulation (decays smoothly over ~140ms)
    const overtoneLevel = isBass
      ? 0.14
      : Math.max(0.07, 0.15 - Math.max(0, midi - 55) * 0.005);
    gainTrans.gain.setValueAtTime(baseLevel * overtoneLevel, startTime);
    gainTrans.gain.setTargetAtTime(0.0001, startTime + attackSec, 0.085);

    // Per-voice low-pass filter with progressive roll-off on higher pitches:
    // Keeps lower/mid voices articulate like individual piano strings while gently rounding higher pitches
    const voiceFilter = ctx.createBiquadFilter();
    voiceFilter.type = 'lowpass';
    voiceFilter.Q.setValueAtTime(0.7, startTime);

    const harmonicMult = Math.max(1.85, 3.15 - Math.max(0, midi - 53) * 0.075);
    const baseCutoff = isBass
      ? Math.min(540, freq * 3.8)
      : Math.min(1550, Math.max(680, freq * harmonicMult));
    const hammerCutoff = Math.min(
      isBass ? 980 : 2150,
      baseCutoff * (1.38 + velocity * 0.18)
    );

    voiceFilter.frequency.setValueAtTime(hammerCutoff, startTime);
    // Quick 45ms felt-hammer rebound into warm sustain tone
    voiceFilter.frequency.setTargetAtTime(baseCutoff, startTime + attackSec, 0.045);
    voiceFilter.frequency.setTargetAtTime(
      baseCutoff * 0.68,
      startTime + attackSec + bloomWindow,
      isWholeMeasure ? 1.4 : 0.9
    );

    // Click-free Multi-Stage Natural Exponential Decay Envelope (no hard gate cut-off)
    const envGain = ctx.createGain();
    envGain.gain.setValueAtTime(0.0001, startTime);
    envGain.gain.linearRampToValueAtTime(1.0, startTime + attackSec);
    // Stage 1: Initial attack bloom settling into singing body
    envGain.gain.setTargetAtTime(bloomTargetLevel, startTime + attackSec, bloomTau);

    if (isWholeMeasure) {
      // Whole-measure chord: gentle singing sustain across the measure, then warm extended release tail
      const measureSustainTau = Math.max(1.1, measureDurationSec * 0.58);
      envGain.gain.setTargetAtTime(0.28, startTime + attackSec + bloomWindow, measureSustainTau);
      envGain.gain.setTargetAtTime(0.00001, startTime + attackSec + wholeBarSustainSec, singingDecayTau);
    } else {
      // Quarter note or Half note: unified, pleasant natural decay into silence
      envGain.gain.setTargetAtTime(0.00001, startTime + attackSec + bloomWindow, singingDecayTau);
    }

    oscFundamental.connect(gainFund);
    oscWarmHarmonic.connect(gainHarm);
    oscTransient.connect(gainTrans);

    gainFund.connect(voiceFilter);
    gainHarm.connect(voiceFilter);
    gainTrans.connect(voiceFilter);

    voiceFilter.connect(envGain);

    // Subtle acoustic piano stereo perspective (bass slightly left, treble slightly right)
    // Gives spatial separation and clarity to individual voices within a chord
    if (typeof ctx.createStereoPanner === 'function') {
      const panner = ctx.createStereoPanner();
      const panPos = Math.max(-0.22, Math.min(0.22, (midi - 55) * 0.011));
      panner.pan.setValueAtTime(panPos, startTime);
      envGain.connect(panner);
      panner.connect(this.masterInput);
    } else {
      envGain.connect(this.masterInput);
    }

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
          // Smooth damper release using setTargetAtTime (seamless transition from current scheduled curve without jump)
          const damperTau = isBass ? 0.16 : 0.30;
          envGain.gain.setTargetAtTime(0.00001, t + 0.01, damperTau);
          const earlyStop = t + damperTau * 4.8 + 0.08;
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
    beats = 2,
    strumDirection: 'down' | 'up' = 'down',
    accentMultiplier = 1.0
  ) {
    const voicing = computeSmartVoicing(chordSymbol, this.lastUpperVoices, this.lastBassMidi);
    this.lastUpperVoices = voicing.upperMidis;
    this.lastBassMidi = voicing.bassMidi;

    // Gently half-pedal / release prior chord voices as the new chord enters
    this.releaseActiveVoicesAt(startTime);

    const secPerBeat = 60 / this.bpm;
    const isWholeMeasure = beats >= this.meter;
    const measureDurationSec = Math.max(this.meter, beats) * secPerBeat;

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

    // Staggered strumming micro-delay (15ms - 19ms between consecutive strings/voices)
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
        isWholeMeasure,
        measureDurationSec,
        voice.isBass,
        velocity,
        normalizationFactor
      );
    });
  }

  /**
   * Immediately plays a single chord (when tapping a chord in the UI).
   * Quarter notes (1 beat) and half notes (2 beats) share the same decay;
   * whole-measure chords (beats >= meter) receive the extended whole-measure decay.
   */
  public playSingleChord(chordSymbol: string, beats = 2, meter?: number) {
    if (!chordSymbol) return;
    if (meter) this.meter = meter;
    if (this.isPlaying) {
      this.stop();
    }
    const ctx = this.ensureContext();
    const direction: 'down' | 'up' = this.strumCounter++ % 2 === 0 ? 'down' : 'up';
    this.scheduleChordAtTime(chordSymbol, ctx.currentTime + 0.005, beats, direction, 1.0);
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
    this.lastBassMidi = null;
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
          // Let the final chord ring out naturally while resetting transport UI when the measure completes
          const stopDelayMs = Math.max(0, (this.nextStepTime - this.ctx.currentTime) * 1000);
          const endTimer = setTimeout(() => {
            this.stop(false);
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
        step.beats,
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

  public stop(dampVoices = true) {
    this.isPlaying = false;
    this.clearTimers();
    if (dampVoices && this.ctx) {
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
