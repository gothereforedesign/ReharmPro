// ============================================================================
// POLYPHONIC CHORD PROGRESSION AUDIO PLAYBACK ENGINE
// - Smart Voicing & Range Rules (Frequency safety floor E2-G3 bass, Drop-2 / Open upper voicings C3-G5)
// - Smooth Voice Leading & Automatic Inversions (Common-tone retention & minimal pitch distance)
// - Sample-Accurate Web Audio Lookahead Transport Scheduler (BPM, Meter, Loop, Live Hot-Swap)
// - Humanization & Dynamics (Downstroke/Upstroke micro-strumming, velocity variance, LFO pitch drift)
// - Studio Master Signal Chain (Sub highpass, low-shelf mud cut, warm E-Piano/Acoustic hybrid synth,
//   procedural room convolution reverb, dynamic range compression, and voice-count gain normalization)
// ============================================================================

import { SoundFont2 } from 'soundfont2-esm';

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

  // 4. Extensions (9th, b9, #9, 11th, 13th)
  let extensionInterval: number | null = null;
  if (qualLower.includes('b9') || qual.includes('♭9')) {
    extensionInterval = 13; // b9
  } else if (qualLower.includes('#9') || isAlt) {
    extensionInterval = 15; // #9
  } else if (qualLower.includes('11')) {
    extensionInterval = 17; // 11th
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

export type ElectricPianoModel = 'rhodes' | 'wurlitzer' | 'dx7' | 'clavinet';

export interface EPModelInfo {
  id: ElectricPianoModel;
  name: string;
  shortName: string;
  badge: string;
  description: string;
  subtitle: string;
}

export const EP_MODELS: Record<ElectricPianoModel, EPModelInfo> = {
  rhodes: {
    id: 'rhodes',
    name: 'Rhodes Mk I',
    shortName: 'Rhodes',
    badge: 'Rhodes',
    description: 'Velvety Tines & Tonebar',
    subtitle: 'Warm tine bloom & smooth singing decay'
  },
  wurlitzer: {
    id: 'wurlitzer',
    name: 'Wurlitzer 200A',
    shortName: 'Wurli',
    badge: 'Wurli',
    description: 'Smooth Vintage Reed',
    subtitle: 'Warm soul reed & mellow singing decay'
  },
  dx7: {
    id: 'dx7',
    name: 'Yamaha DX7',
    shortName: 'DX7',
    badge: 'DX7',
    description: 'Silky Ballad Crystal FM',
    subtitle: 'Smooth crystalline chime & warm bloom'
  },
  clavinet: {
    id: 'clavinet',
    name: 'Clavinet D6',
    shortName: 'Clav',
    badge: 'Clav',
    description: 'Mellow Funky Keys',
    subtitle: 'Smooth filtered pluck & punchy decay'
  }
};

export const EP_MODEL_ORDER: ElectricPianoModel[] = ['rhodes', 'wurlitzer', 'dx7', 'clavinet'];

/**
 * Analog Tape Soft-Saturation Transfer Curve:
 * Generates an asymmetrical hyperbolic tangent soft-clipping curve
 * providing warm tube/tape compression and musical even/odd harmonics.
 */
function makeTapeSaturationCurve(samples = 1024, drive = 1.35): Float32Array {
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = Math.tanh(x * drive) * 0.94 + 0.06 * Math.tanh(x * x * Math.sign(x));
  }
  return curve;
}

export class ChordAudioEngine {
  private ctx: AudioContext | null = null;
  private masterInput: GainNode | null = null;
  private masterCompressor: DynamicsCompressorNode | null = null;
  private activeVoices: ActiveVoiceNodes[] = [];
  private lastUpperVoices: number[] | null = null;
  private lastBassMidi: number | null = null;

  // Active Electric Piano Voice Model
  private currentModel: ElectricPianoModel = 'rhodes';

  // Custom User Audio Uploads (VST / Instruments & Drum Loop)
  private customInstrumentBuffer: AudioBuffer | null = null;
  private soundFont: SoundFont2 | null = null;
  private customDrumLoopBuffer: AudioBuffer | null = null;
  private customDrumLoopBaseBpm = 120;

  private soundFontName: string | null = null;
  private customInstrumentName: string | null = null;
  private customDrumLoopName: string | null = null;

  private keysLowEq: BiquadFilterNode | null = null;
  private keysHighEq: BiquadFilterNode | null = null;
  private keysGainNode: GainNode | null = null;
  private isKeysActive = true;

  private drumsLowEq: BiquadFilterNode | null = null;
  private drumsHighEq: BiquadFilterNode | null = null;
  private drumsGainNode: GainNode | null = null;
  private isDrumsActive = true;

  public setKeysActive(active: boolean) {
    this.isKeysActive = active;
    if (this.ctx && this.keysGainNode) {
      const target = this.isKeysActive ? 1.0 : 0;
      this.keysGainNode.gain.cancelScheduledValues(this.ctx.currentTime);
      this.keysGainNode.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02);
    }
  }

  public toggleKeysActive(): boolean {
    this.isKeysActive = !this.isKeysActive;
    this.setKeysActive(this.isKeysActive);
    return this.isKeysActive;
  }

  public getKeysActive(): boolean {
    return this.isKeysActive;
  }

  public setDrumsActive(active: boolean) {
    this.isDrumsActive = active;
    if (this.ctx && this.drumsGainNode) {
      const target = this.isDrumsActive ? 1.0 : 0;
      this.drumsGainNode.gain.cancelScheduledValues(this.ctx.currentTime);
      this.drumsGainNode.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02);
    }
  }

  public toggleDrumsActive(): boolean {
    this.isDrumsActive = !this.isDrumsActive;
    this.setDrumsActive(this.isDrumsActive);
    return this.isDrumsActive;
  }

  public getDrumsActive(): boolean {
    return this.isDrumsActive;
  }

  public setKeysLowEq(db: number) {
    if (this.ctx && this.keysLowEq) {
      this.keysLowEq.gain.setValueAtTime(Math.max(-15, Math.min(15, db)), this.ctx.currentTime);
    }
  }

  public getKeysLowEq(): number {
    return this.keysLowEq?.gain.value || 0;
  }

  public setKeysHighEq(db: number) {
    if (this.ctx && this.keysHighEq) {
      this.keysHighEq.gain.setValueAtTime(Math.max(-15, Math.min(15, db)), this.ctx.currentTime);
    }
  }

  public getKeysHighEq(): number {
    return this.keysHighEq?.gain.value || 0;
  }

  public setKeysGain(gain: number) {
    if (this.ctx && this.keysGainNode) {
      const activeMult = this.isKeysActive ? 1.0 : 0;
      this.keysGainNode.gain.setValueAtTime(Math.max(0, Math.min(2.0, gain)) * activeMult, this.ctx.currentTime);
    }
  }

  public getKeysGain(): number {
    return this.keysGainNode?.gain.value || 1.0;
  }

  public setDrumsLowEq(db: number) {
    if (this.ctx && this.drumsLowEq) {
      this.drumsLowEq.gain.setValueAtTime(Math.max(-15, Math.min(15, db)), this.ctx.currentTime);
    }
  }

  public getDrumsLowEq(): number {
    return this.drumsLowEq?.gain.value || 0;
  }

  public setDrumsHighEq(db: number) {
    if (this.ctx && this.drumsHighEq) {
      this.drumsHighEq.gain.setValueAtTime(Math.max(-15, Math.min(15, db)), this.ctx.currentTime);
    }
  }

  public getDrumsHighEq(): number {
    return this.drumsHighEq?.gain.value || 0;
  }

  public setDrumsGain(gain: number) {
    if (this.ctx && this.drumsGainNode) {
      const activeMult = this.isDrumsActive ? 1.0 : 0;
      this.drumsGainNode.gain.setValueAtTime(Math.max(0, Math.min(2.0, gain)) * activeMult, this.ctx.currentTime);
    }
  }

  public getDrumsGain(): number {
    return this.drumsGainNode?.gain.value || 1.0;
  }

  public async loadSoundFont(arrayBuffer: ArrayBuffer, name?: string) {
    const ctx = this.ensureContext();
    try {
      this.soundFont = new SoundFont2(new Uint8Array(arrayBuffer));
      this.customInstrumentBuffer = null;
      this.customInstrumentName = null;
      this.soundFontName = name || 'SoundFont.sf2';
    } catch (e) {
      console.error('Failed to parse SF2 SoundFont:', e);
      throw e;
    }
  }

  public clearSoundFont() {
    this.soundFont = null;
    this.soundFontName = null;
  }

  public getHasSoundFont(): boolean {
    return this.soundFont !== null;
  }

  public getSoundFontName(): string | null {
    return this.soundFontName;
  }

  public async loadCustomInstrumentSample(arrayBuffer: ArrayBuffer, name?: string) {
    const ctx = this.ensureContext();
    this.customInstrumentBuffer = await ctx.decodeAudioData(arrayBuffer);
    this.soundFont = null;
    this.soundFontName = null;
    this.customInstrumentName = name || 'Instrument.wav';
  }

  public clearCustomInstrument() {
    this.customInstrumentBuffer = null;
    this.customInstrumentName = null;
  }

  public getHasCustomInstrument(): boolean {
    return this.customInstrumentBuffer !== null;
  }

  public getCustomInstrumentName(): string | null {
    return this.customInstrumentName;
  }

  public async loadCustomDrumLoop(arrayBuffer: ArrayBuffer, baseBpm: number, name?: string) {
    const ctx = this.ensureContext();
    this.customDrumLoopBuffer = await ctx.decodeAudioData(arrayBuffer);
    this.customDrumLoopBaseBpm = Math.max(20, baseBpm);
    this.customDrumLoopName = name || 'DrumLoop.wav';
  }

  public clearCustomDrumLoop() {
    this.customDrumLoopBuffer = null;
    this.customDrumLoopName = null;
  }

  public getHasCustomDrumLoop(): boolean {
    return this.customDrumLoopBuffer !== null;
  }

  public getCustomDrumLoopName(): string | null {
    return this.customDrumLoopName;
  }

  public setCustomDrumLoopBaseBpm(bpm: number) {
    this.customDrumLoopBaseBpm = Math.max(20, bpm);
  }

  public getCustomDrumLoopBaseBpm(): number {
    return this.customDrumLoopBaseBpm;
  }

  // Transport state
  private isPlaying = false;
  private isLooping = true;
  private bpm = 80;
  private meter = 4;
  private steps: TransportStep[] = [];
  private currentStepIndex = 0;
  private nextStepTime = 0;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private uiTimers: ReturnType<typeof setTimeout>[] = [];
  private strumCounter = 0;

  // Back Beat (Acoustic Jazz Brush Swing Kit)
  private isBeatActive = true;
  private beatVolume = 0.52;
  private drumGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

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

  public prefetch() {
    try {
      this.ensureContext();
    } catch {}
  }

  public getModel(): ElectricPianoModel {
    return this.currentModel;
  }

  public setModel(model: ElectricPianoModel) {
    if (EP_MODELS[model]) {
      this.currentModel = model;
    }
  }

  public cycleModel(): ElectricPianoModel {
    const idx = EP_MODEL_ORDER.indexOf(this.currentModel);
    const nextIdx = (idx + 1) % EP_MODEL_ORDER.length;
    this.currentModel = EP_MODEL_ORDER[nextIdx];
    return this.currentModel;
  }

  public getModelInfo(model: ElectricPianoModel = this.currentModel): EPModelInfo {
    return EP_MODELS[model] || EP_MODELS.rhodes;
  }

  /**
   * Vintage Warm Master Signal Chain:
   * Input
   *   -> Sub Highpass (38Hz)
   *   -> Analog Console Tone EQ (Warm low-shelf + Air cushion roll-off)
   *   -> Deep Lush Stereo Chorus / Ensemble (Dual modulated BBD lines with LFOs)
   *   -> Studio Scoring Stage Room Reverb (Wooden reflection acoustic space)
   *   -> Master Limiter / Dynamics Compressor -> Destination
   */
  private buildMasterSignalChain(ctx: AudioContext) {
    this.masterInput = ctx.createGain();
    this.masterInput.gain.setValueAtTime(0.78, ctx.currentTime);

    this.keysLowEq = ctx.createBiquadFilter();
    this.keysLowEq.type = 'lowshelf';
    this.keysLowEq.frequency.setValueAtTime(200, ctx.currentTime);
    this.keysLowEq.gain.setValueAtTime(0, ctx.currentTime);

    this.keysHighEq = ctx.createBiquadFilter();
    this.keysHighEq.type = 'highshelf';
    this.keysHighEq.frequency.setValueAtTime(5000, ctx.currentTime);
    this.keysHighEq.gain.setValueAtTime(0, ctx.currentTime);

    this.keysGainNode = ctx.createGain();
    this.keysGainNode.gain.setValueAtTime(this.isKeysActive ? 1.0 : 0, ctx.currentTime);

    this.masterInput.connect(this.keysLowEq);
    this.keysLowEq.connect(this.keysHighEq);
    this.keysHighEq.connect(this.keysGainNode);

    // 1. Sub-bass safety filter (removes < 38 Hz rumble)
    const subHighpass = ctx.createBiquadFilter();
    subHighpass.type = 'highpass';
    subHighpass.frequency.setValueAtTime(38, ctx.currentTime);
    subHighpass.Q.setValueAtTime(0.707, ctx.currentTime);

    this.keysGainNode.connect(subHighpass);

    // 2. Analog Console Warm Tone Shaping (removes harsh digital top-end, adds low-mid warmth)
    const consoleLowWarmth = ctx.createBiquadFilter();
    consoleLowWarmth.type = 'lowshelf';
    consoleLowWarmth.frequency.setValueAtTime(180, ctx.currentTime);
    consoleLowWarmth.gain.setValueAtTime(1.4, ctx.currentTime);

    const consoleAirCushion = ctx.createBiquadFilter();
    consoleAirCushion.type = 'highshelf';
    consoleAirCushion.frequency.setValueAtTime(5200, ctx.currentTime);
    consoleAirCushion.gain.setValueAtTime(-3.2, ctx.currentTime);

    // 3. Deep Lush Stereo Chorus / Ensemble Stage (Silky, rich, dimensional)
    const chorusDryGain = ctx.createGain();
    chorusDryGain.gain.setValueAtTime(0.80, ctx.currentTime);

    const chorusWetGain = ctx.createGain();
    chorusWetGain.gain.setValueAtTime(0.30, ctx.currentTime);

    const chorusCombiner = ctx.createGain();
    chorusCombiner.gain.setValueAtTime(1.0, ctx.currentTime);

    // Modulated BBD delay line Left (14ms baseline, 0.38Hz smooth sine LFO)
    const delayL = ctx.createDelay();
    delayL.delayTime.setValueAtTime(0.014, ctx.currentTime);
    const lfoL = ctx.createOscillator();
    lfoL.type = 'sine';
    lfoL.frequency.setValueAtTime(0.38, ctx.currentTime);
    const lfoGainL = ctx.createGain();
    lfoGainL.gain.setValueAtTime(0.0016, ctx.currentTime);
    lfoL.connect(lfoGainL);
    lfoGainL.connect(delayL.delayTime);
    lfoL.start(ctx.currentTime);

    // Modulated BBD delay line Right (19ms baseline, 0.48Hz triangle LFO)
    const delayR = ctx.createDelay();
    delayR.delayTime.setValueAtTime(0.019, ctx.currentTime);
    const lfoR = ctx.createOscillator();
    lfoR.type = 'triangle';
    lfoR.frequency.setValueAtTime(0.48, ctx.currentTime);
    const lfoGainR = ctx.createGain();
    lfoGainR.gain.setValueAtTime(0.0020, ctx.currentTime);
    lfoR.connect(lfoGainR);
    lfoGainR.connect(delayR.delayTime);
    lfoR.start(ctx.currentTime);

    if (typeof ctx.createStereoPanner === 'function') {
      const panL = ctx.createStereoPanner();
      panL.pan.setValueAtTime(-0.75, ctx.currentTime);
      delayL.connect(panL);
      panL.connect(chorusWetGain);

      const panR = ctx.createStereoPanner();
      panR.pan.setValueAtTime(0.75, ctx.currentTime);
      delayR.connect(panR);
      panR.connect(chorusWetGain);
    } else {
      delayL.connect(chorusWetGain);
      delayR.connect(chorusWetGain);
    }

    // Connect console tone shaping into chorus paths
    this.masterInput.connect(subHighpass);
    subHighpass.connect(consoleLowWarmth);
    consoleLowWarmth.connect(consoleAirCushion);

    consoleAirCushion.connect(chorusDryGain);
    consoleAirCushion.connect(delayL);
    consoleAirCushion.connect(delayR);

    chorusDryGain.connect(chorusCombiner);
    chorusWetGain.connect(chorusCombiner);

    // 4. Scoring Stage Reverb
    const reverbDryGain = ctx.createGain();
    reverbDryGain.gain.setValueAtTime(0.82, ctx.currentTime);

    const reverbWetGain = ctx.createGain();
    reverbWetGain.gain.setValueAtTime(0.22, ctx.currentTime);

    const convolver = ctx.createConvolver();
    convolver.buffer = this.createScoringStageImpulse(ctx, 1.85, 2.6);

    chorusCombiner.connect(reverbDryGain);
    chorusCombiner.connect(convolver);
    convolver.connect(reverbWetGain);

    // 5. Master Studio Limiter / Dynamics Compressor (Gentle, musical leveling)
    this.masterCompressor = ctx.createDynamicsCompressor();
    this.masterCompressor.threshold.setValueAtTime(-18, ctx.currentTime);
    this.masterCompressor.knee.setValueAtTime(12, ctx.currentTime);
    this.masterCompressor.ratio.setValueAtTime(2.4, ctx.currentTime);
    this.masterCompressor.attack.setValueAtTime(0.020, ctx.currentTime);
    this.masterCompressor.release.setValueAtTime(0.28, ctx.currentTime);

    reverbDryGain.connect(this.masterCompressor);
    reverbWetGain.connect(this.masterCompressor);

    // 6. Acoustic Jazz Backbeat Drum Bus
    this.drumGain = ctx.createGain();
    this.drumGain.gain.setValueAtTime(this.isBeatActive ? this.beatVolume : 0, ctx.currentTime);

    this.drumsLowEq = ctx.createBiquadFilter();
    this.drumsLowEq.type = 'lowshelf';
    this.drumsLowEq.frequency.setValueAtTime(200, ctx.currentTime);
    this.drumsLowEq.gain.setValueAtTime(0, ctx.currentTime);

    this.drumsHighEq = ctx.createBiquadFilter();
    this.drumsHighEq.type = 'highshelf';
    this.drumsHighEq.frequency.setValueAtTime(5000, ctx.currentTime);
    this.drumsHighEq.gain.setValueAtTime(0, ctx.currentTime);

    this.drumsGainNode = ctx.createGain();
    this.drumsGainNode.gain.setValueAtTime(this.isDrumsActive ? 1.0 : 0, ctx.currentTime);

    this.drumGain.connect(this.drumsLowEq);
    this.drumsLowEq.connect(this.drumsHighEq);
    this.drumsHighEq.connect(this.drumsGainNode);

    // Drum subtle room reverb send (warm acoustic studio blend)
    const drumReverbSend = ctx.createGain();
    drumReverbSend.gain.setValueAtTime(0.14, ctx.currentTime);
    this.drumsGainNode.connect(drumReverbSend);
    drumReverbSend.connect(convolver);

    // Direct dry drum send to master compressor
    const drumDryGain = ctx.createGain();
    drumDryGain.gain.setValueAtTime(0.86, ctx.currentTime);
    this.drumsGainNode.connect(drumDryGain);
    drumDryGain.connect(this.masterCompressor);

    // Master makeup gain boost (+4.3dB / 1.85 multiplier) for high keyboard volume & presence
    const masterGainBoost = ctx.createGain();
    masterGainBoost.gain.setValueAtTime(1.85, ctx.currentTime);
    this.masterCompressor.connect(masterGainBoost);
    masterGainBoost.connect(ctx.destination);
  }

  /**
   * Generates a stereo Studio Scoring Stage impulse response:
   * - 16ms pre-delay (keeping electric piano in the intimate nearfield)
   * - Warm wooden room reflections (smooth 1.85s decay, air absorption low-pass damping)
   */
  private createScoringStageImpulse(ctx: AudioContext, durationSec = 1.85, decayRate = 2.6): AudioBuffer {
    const sampleRate = ctx.sampleRate;
    const length = Math.floor(sampleRate * durationSec);
    const impulse = ctx.createBuffer(2, length, sampleRate);
    const preDelaySamples = Math.floor(sampleRate * 0.016);

    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      let lpState = 0;
      const stereoOffset = ch === 0 ? 0 : Math.floor(sampleRate * 0.0016);
      for (let i = 0; i < length; i++) {
        if (i < preDelaySamples + stereoOffset) {
          data[i] = 0;
          continue;
        }
        const t = (i - (preDelaySamples + stereoOffset)) / (length - preDelaySamples);
        const env = Math.pow(1 - t, decayRate);
        const noise = Math.random() * 2 - 1;
        const damping = 0.32 + 0.48 * (1 - t);
        lpState = lpState + damping * (noise - lpState);
        data[i] = lpState * env * 0.65;
      }
    }
    return impulse;
  }

  /**
   * Releases active notes with a smooth damper felt decay curve (~650ms)
   * so chords blend naturally and musically like a real sustained electric keyboard.
   */
  private releaseActiveVoicesAt(releaseTime: number) {
    const remaining: ActiveVoiceNodes[] = [];
    for (const v of this.activeVoices) {
      if (v.stopTime > releaseTime + 0.05) {
        v.forceRelease(releaseTime);
        remaining.push(v);
      }
    }
    this.activeVoices = remaining;
  }

  /**
   * Schedules a single polyphonic electric piano voice:
   * - Gentle cushioned attack (16ms-22ms ramp, never harsh click spikes)
   * - Long singing natural exponential decay (notes ring out for bars, never chopped off)
   * - Smooth, pleasant, velvety acoustic voicing tailored per model:
   *   1. Rhodes Mk I: Warm fundamental + 2nd harmonic tonebar + 250Hz wooden body + warm 1700Hz lowpass
   *   2. Wurlitzer 200A: Warm reed core + 650Hz vintage soul warmth + 1900Hz lowpass
   *   3. Yamaha DX7: Smooth ballad FM tines with gentle glassy shimmer + 2600Hz lowpass (zero harshness)
   *   4. Clavinet D6: Warm filtered funk keys with smooth dynamic envelope sweep (zero ear-piercing buzz)
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

    // Cut base keys sound: only use uploaded sounds
    if (!this.soundFont && !this.customInstrumentBuffer) {
      return;
    }

    const freq = midiToFreq(midi);

    // If user uploaded a SoundFont (.sf2), use SF2 sample mapping
    if (this.soundFont) {
      try {
        const keyData = this.soundFont.getKeyData(midi);
        if (keyData && keyData.sample) {
          const sampleObj = keyData.sample;
          const header = sampleObj.header;
          const pcmData = sampleObj.data;
          if (pcmData && pcmData.length > 0 && header.sampleRate > 0) {
            const audioBuf = ctx.createBuffer(1, pcmData.length, header.sampleRate);
            const channel = audioBuf.getChannelData(0);
            for (let i = 0; i < pcmData.length; i++) {
              channel[i] = pcmData[i] / 32768.0;
            }
            const source = ctx.createBufferSource();
            source.buffer = audioBuf;

            const origPitch = header.originalPitch >= 0 && header.originalPitch < 128 ? header.originalPitch : 60;
            const rate = Math.pow(2, (midi - origPitch) / 12);
            source.playbackRate.setValueAtTime(Math.max(0.1, Math.min(8.0, rate)), startTime);

            const sampleGain = ctx.createGain();
            sampleGain.gain.setValueAtTime(0.0001, startTime);
            sampleGain.gain.linearRampToValueAtTime(velocity * 1.6 * normalizationFactor, startTime + 0.015);
            sampleGain.gain.setTargetAtTime(0.00001, startTime + Math.max(0.1, measureDurationSec * 0.8), 0.4);

            source.connect(sampleGain);
            sampleGain.connect(this.masterInput);

            source.start(startTime);
            const stopT = startTime + measureDurationSec + 0.8;
            source.stop(stopT);

            let released = false;
            const voiceRecord: ActiveVoiceNodes = {
              stopTime: stopT,
              forceRelease: (now: number) => {
                if (released) return;
                released = true;
                try {
                  const t = Math.max(now, ctx.currentTime);
                  sampleGain.gain.setTargetAtTime(0.00001, t, 0.12);
                } catch {}
              }
            };
            this.activeVoices.push(voiceRecord);
            return;
          }
        }
      } catch (e) {
        console.error('Error playing SF2 sample for MIDI note', midi, e);
      }
    }

    // If user uploaded a custom instrument sample, play it pitched to note frequency
    if (this.customInstrumentBuffer) {
      const source = ctx.createBufferSource();
      source.buffer = this.customInstrumentBuffer;
      const baseFreq = 261.63; // C4 reference
      const rate = freq / baseFreq;
      source.playbackRate.setValueAtTime(Math.max(0.25, Math.min(4.0, rate)), startTime);

      const sampleGain = ctx.createGain();
      sampleGain.gain.setValueAtTime(0.0001, startTime);
      sampleGain.gain.linearRampToValueAtTime(velocity * 1.45 * normalizationFactor, startTime + 0.012);
      sampleGain.gain.setTargetAtTime(0.00001, startTime + Math.max(0.1, measureDurationSec * 0.8), 0.35);

      source.connect(sampleGain);
      sampleGain.connect(this.masterInput);

      source.start(startTime);
      const stopT = startTime + measureDurationSec + 0.6;
      source.stop(stopT);

      let released = false;
      const voiceRecord: ActiveVoiceNodes = {
        stopTime: stopT,
        forceRelease: (now: number) => {
          if (released) return;
          released = true;
          try {
            const t = Math.max(now, ctx.currentTime);
            sampleGain.gain.setTargetAtTime(0.00001, t, 0.12);
          } catch {}
        }
      };
      this.activeVoices.push(voiceRecord);
      return;
    }

    const model = this.currentModel;

    // Model-specific gentle attack, musical initial decay to warm singing sustain, and felt damper
    let attackSec = 0.026;
    let initialDecaySec = 0.40;
    let sustainRatio = 0.36;
    let longDecayTau = 2.2;
    let damperTau = 0.24;

    if (model === 'rhodes') {
      attackSec = 0.026;
      initialDecaySec = 0.40;
      sustainRatio = 0.36;
      longDecayTau = isWholeMeasure ? (isBass ? 2.8 : 2.5) : (isBass ? 2.0 : 1.8);
      damperTau = 0.24;
    } else if (model === 'wurlitzer') {
      attackSec = 0.024;
      initialDecaySec = 0.34;
      sustainRatio = 0.34;
      longDecayTau = isWholeMeasure ? (isBass ? 2.5 : 2.2) : (isBass ? 1.8 : 1.6);
      damperTau = 0.22;
    } else if (model === 'dx7') {
      attackSec = 0.025;
      initialDecaySec = 0.42;
      sustainRatio = 0.35;
      longDecayTau = isWholeMeasure ? (isBass ? 2.8 : 2.5) : (isBass ? 2.0 : 1.8);
      damperTau = 0.25;
    } else if (model === 'clavinet') {
      attackSec = 0.018;
      initialDecaySec = 0.28;
      sustainRatio = 0.28;
      longDecayTau = isWholeMeasure ? (isBass ? 1.8 : 1.5) : (isBass ? 1.4 : 1.1);
      damperTau = 0.18;
    }

    const naturalRingDuration = attackSec + initialDecaySec + longDecayTau * 3.5;
    const stopTime = startTime + naturalRingDuration + 0.6;

    // Expressive, cushioned peak strike level: velvety and pleasant (never harsh or hammered)
    const peakLevel = (isBass ? 0.20 : 0.16) * velocity * normalizationFactor;
    const sustainLevel = Math.max(0.0001, peakLevel * sustainRatio);

    const envGain = ctx.createGain();
    envGain.gain.setValueAtTime(0.00001, startTime);
    // 1. Soft, cushioned, gentle attack ramp — zero click, zero spike
    envGain.gain.linearRampToValueAtTime(peakLevel, startTime + attackSec);
    // 2. Initial musical decay: note drops smoothly from attack bloom down to singing sustain body
    envGain.gain.exponentialRampToValueAtTime(sustainLevel, startTime + attackSec + initialDecaySec);
    // 3. Warm, singing sustain ringing out gently with long decay
    envGain.gain.setTargetAtTime(0.00001, startTime + attackSec + initialDecaySec, longDecayTau);

    // Warm Post-Filtering / Tone Shaping (removes all harsh, shrill frequencies)
    const eqFilter1 = ctx.createBiquadFilter();
    const eqFilter2 = ctx.createBiquadFilter();

    if (model === 'rhodes') {
      // Warm Rhodes: low-mid wooden body + buttery smooth 1150Hz lowpass
      eqFilter1.type = 'peaking';
      eqFilter1.frequency.setValueAtTime(260, startTime);
      eqFilter1.Q.setValueAtTime(0.9, startTime);
      eqFilter1.gain.setValueAtTime(1.4, startTime);

      eqFilter2.type = 'lowpass';
      eqFilter2.frequency.setValueAtTime(1150, startTime);
      eqFilter2.Q.setValueAtTime(0.50, startTime);
    } else if (model === 'wurlitzer') {
      // Warm Wurlitzer: vintage 500Hz soul warmth + warm 1300Hz lowpass
      eqFilter1.type = 'peaking';
      eqFilter1.frequency.setValueAtTime(500, startTime);
      eqFilter1.Q.setValueAtTime(0.9, startTime);
      eqFilter1.gain.setValueAtTime(1.2, startTime);

      eqFilter2.type = 'lowpass';
      eqFilter2.frequency.setValueAtTime(1300, startTime);
      eqFilter2.Q.setValueAtTime(0.55, startTime);
    } else if (model === 'dx7') {
      // Smooth DX7: warm presence + 1650Hz lowpass (silky glass without ANY digital edge)
      eqFilter1.type = 'peaking';
      eqFilter1.frequency.setValueAtTime(1100, startTime);
      eqFilter1.Q.setValueAtTime(0.9, startTime);
      eqFilter1.gain.setValueAtTime(1.0, startTime);

      eqFilter2.type = 'lowpass';
      eqFilter2.frequency.setValueAtTime(1650, startTime);
      eqFilter2.Q.setValueAtTime(0.55, startTime);
    } else if (model === 'clavinet') {
      // Mellow Funk Clavinet: warm dynamic auto-wah sweep + warm 650Hz body
      eqFilter1.type = 'peaking';
      eqFilter1.frequency.setValueAtTime(650, startTime);
      eqFilter1.Q.setValueAtTime(1.0, startTime);
      eqFilter1.gain.setValueAtTime(1.2, startTime);

      eqFilter2.type = 'lowpass';
      eqFilter2.frequency.setValueAtTime(1150, startTime);
      eqFilter2.frequency.setTargetAtTime(800, startTime + 0.02, 0.16);
      eqFilter2.Q.setValueAtTime(0.70, startTime);
    }

    envGain.connect(eqFilter1);
    eqFilter1.connect(eqFilter2);

    // Stereo Keyboard Panning (Bass left, middle center, treble right)
    if (typeof ctx.createStereoPanner === 'function') {
      const panner = ctx.createStereoPanner();
      const panPos = Math.max(-0.25, Math.min(0.25, (midi - 57) * 0.016));
      panner.pan.setValueAtTime(panPos, startTime);
      eqFilter2.connect(panner);
      panner.connect(this.masterInput);
    } else {
      eqFilter2.connect(this.masterInput);
    }

    // Oscillators to start/stop
    const oscillatorsToStop: AudioNode[] = [];

    if (model === 'rhodes') {
      // --- SMOOTH VELVETY RHODES MK I ---
      // Fundamental pure rounded sine core
      const oscFund = ctx.createOscillator();
      oscFund.type = 'sine';
      oscFund.frequency.setValueAtTime(freq, startTime);

      // Warm 2nd harmonic tonebar resonance
      const oscBody = ctx.createOscillator();
      oscBody.type = 'sine';
      oscBody.frequency.setValueAtTime(freq * 2.0, startTime);

      // Gentle, musical 3rd harmonic tine chime (soft, never harsh, fast bloom decay)
      const oscTine = ctx.createOscillator();
      oscTine.type = 'sine';
      oscTine.frequency.setValueAtTime(freq * 3.0, startTime);

      const gFund = ctx.createGain();
      const gBody = ctx.createGain();
      const gTine = ctx.createGain();

      gFund.gain.setValueAtTime(0.82, startTime);
      gBody.gain.setValueAtTime(0.12, startTime);

      // Soft tine chime that gently recedes quickly
      gTine.gain.setValueAtTime(0.025 * velocity, startTime);
      gTine.gain.setTargetAtTime(0.0001, startTime + attackSec, 0.08);

      oscFund.connect(gFund);
      oscBody.connect(gBody);
      oscTine.connect(gTine);

      gFund.connect(envGain);
      gBody.connect(envGain);
      gTine.connect(envGain);

      [oscFund, oscBody, oscTine].forEach(osc => {
        osc.start(startTime);
        osc.stop(stopTime);
        oscillatorsToStop.push(osc);
      });
    } else if (model === 'wurlitzer') {
      // --- WARM VINTAGE WURLITZER 200A ---
      // Warm fundamental sine core
      const oscFund = ctx.createOscillator();
      oscFund.type = 'sine';
      oscFund.frequency.setValueAtTime(freq, startTime);

      // Vintage soul reed triangle (filtered)
      const oscReed = ctx.createOscillator();
      oscReed.type = 'triangle';
      oscReed.frequency.setValueAtTime(freq, startTime);

      // Warm 2nd harmonic reed body
      const oscPart2 = ctx.createOscillator();
      oscPart2.type = 'sine';
      oscPart2.frequency.setValueAtTime(freq * 2.0, startTime);

      const gFund = ctx.createGain();
      const gReed = ctx.createGain();
      const gPart2 = ctx.createGain();

      gFund.gain.setValueAtTime(0.68, startTime);
      gReed.gain.setValueAtTime(0.22, startTime);
      gPart2.gain.setValueAtTime(0.10, startTime);

      oscFund.connect(gFund);
      oscReed.connect(gReed);
      oscPart2.connect(gPart2);

      gFund.connect(envGain);
      gReed.connect(envGain);
      gPart2.connect(envGain);

      [oscFund, oscReed, oscPart2].forEach(osc => {
        osc.start(startTime);
        osc.stop(stopTime);
        oscillatorsToStop.push(osc);
      });
    } else if (model === 'dx7') {
      // --- SILKY 80S BALLAD YAMAHA DX7 ---
      // Soft carrier sine
      const carrier1 = ctx.createOscillator();
      carrier1.type = 'sine';
      carrier1.frequency.setValueAtTime(freq, startTime);

      // Gentle glassy modulator (subtle modulation index - velvety, silky, never harsh)
      const modulator = ctx.createOscillator();
      modulator.type = 'sine';
      modulator.frequency.setValueAtTime(freq * 1.0, startTime);

      const modGain = ctx.createGain();
      modGain.gain.setValueAtTime(freq * 0.065 * velocity, startTime);
      modGain.gain.setTargetAtTime(freq * 0.006, startTime + attackSec, 0.10);

      modulator.connect(modGain);
      modGain.connect(carrier1.frequency);

      // Second carrier: subtle warm chorus detune (+0.8 cent)
      const carrier2 = ctx.createOscillator();
      carrier2.type = 'sine';
      carrier2.frequency.setValueAtTime(freq * 1.0005, startTime);

      // Soft crystalline bell harmonic (quiet, glassy, no sharp click)
      const oscBell = ctx.createOscillator();
      oscBell.type = 'sine';
      oscBell.frequency.setValueAtTime(freq * 2.0, startTime);

      const gCar1 = ctx.createGain();
      const gCar2 = ctx.createGain();
      const gBell = ctx.createGain();

      gCar1.gain.setValueAtTime(0.76, startTime);
      gCar2.gain.setValueAtTime(0.20, startTime);
      gBell.gain.setValueAtTime(0.04 * velocity, startTime);
      gBell.gain.setTargetAtTime(0.0001, startTime + attackSec, 0.10);

      carrier1.connect(gCar1);
      carrier2.connect(gCar2);
      oscBell.connect(gBell);

      gCar1.connect(envGain);
      gCar2.connect(envGain);
      gBell.connect(envGain);

      [carrier1, modulator, carrier2, oscBell].forEach(osc => {
        osc.start(startTime);
        osc.stop(stopTime);
        oscillatorsToStop.push(osc);
      });
    } else if (model === 'clavinet') {
      // --- WARM FUNKY CLAVINET D6 ---
      // Warm fundamental sine core
      const oscFund = ctx.createOscillator();
      oscFund.type = 'sine';
      oscFund.frequency.setValueAtTime(freq, startTime);

      // Filtered triangle string (smooth and musical)
      const oscString = ctx.createOscillator();
      oscString.type = 'triangle';
      oscString.frequency.setValueAtTime(freq, startTime);

      // Gentle pluck tick (soft felt plectrum, no sharp metallic click)
      const oscPluck = ctx.createOscillator();
      oscPluck.type = 'sine';
      oscPluck.frequency.setValueAtTime(freq * 2.0, startTime);

      const gFund = ctx.createGain();
      const gString = ctx.createGain();
      const gPluck = ctx.createGain();

      gFund.gain.setValueAtTime(0.52, startTime);
      gString.gain.setValueAtTime(0.42, startTime);
      gPluck.gain.setValueAtTime(0.03 * velocity, startTime);
      gPluck.gain.setTargetAtTime(0.0001, startTime + attackSec, 0.025);

      oscFund.connect(gFund);
      oscString.connect(gString);
      oscPluck.connect(gPluck);

      gFund.connect(envGain);
      gString.connect(envGain);
      gPluck.connect(envGain);

      [oscFund, oscString, oscPluck].forEach(osc => {
        osc.start(startTime);
        osc.stop(stopTime);
        oscillatorsToStop.push(osc);
      });
    }

    const stopVoiceFn = (stopT: number) => {
      oscillatorsToStop.forEach(osc => {
        try {
          (osc as OscillatorNode).stop(stopT);
        } catch {}
      });
    };

    let released = false;
    const voiceRecord: ActiveVoiceNodes = {
      stopTime,
      forceRelease: (now: number) => {
        if (released) return;
        released = true;
        try {
          const t = Math.max(now, ctx.currentTime);
          envGain.gain.setTargetAtTime(0.00001, t, damperTau);
          const earlyStop = t + damperTau * 4.0;
          if (earlyStop < stopTime) {
            stopVoiceFn(earlyStop);
          }
        } catch {}
      }
    };

    this.activeVoices.push(voiceRecord);
  }

  /**
   * Schedules a complete humanized, voice-led chord at `startTime` (AudioContext time).
   * Playback is cushioned, velvety, and expressive with smooth chord transitions.
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

    // Gently half-pedal / fade prior chord voices smoothly as the new chord enters
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

    // Staggered strumming micro-delay (16ms - 20ms between consecutive voices)
    const baseStaggerSec = strumDirection === 'down' ? 0.020 : 0.016;

    orderedVoices.forEach((voice, idx) => {
      const jitterSec = (Math.random() - 0.5) * 0.003; // ±1.5ms human micro-timing variance
      const noteOffset = Math.max(0, idx * baseStaggerSec + jitterSec);
      const noteStart = startTime + noteOffset;

      // Soft, expressive velocity contour: warm, gentle, pleasant, never harsh or hammered
      const isTopVoice = idx === orderedVoices.length - 1;
      const contour = voice.isBass ? 1.01 : isTopVoice ? 1.01 : 0.97;
      const humanVelocityVariance = 0.82 + Math.random() * 0.10;
      const velocity = Math.min(0.74, contour * humanVelocityVariance * (accentMultiplier * 0.72));

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

      // Downstroke on beat 0 of a measure (warm natural attack), gentle touch on inner-measure changes
      const isDownbeat = step.beatInMeasure === 0;
      const strumDir: 'down' | 'up' = isDownbeat ? 'down' : 'up';
      const accent = isDownbeat ? 1.00 : 0.92;

      this.scheduleChordAtTime(
        step.chord,
        playTime,
        step.beats,
        strumDir,
        accent
      );

      // Schedule subtle acoustic jazz brush back beat for each beat in this chord step
      const numBeats = Math.max(1, Math.round(step.beats));
      for (let b = 0; b < numBeats; b++) {
        const beatTime = playTime + b * secPerBeat;
        const currentBeatInMeasure = (step.beatInMeasure + b) % this.meter;
        this.scheduleBackbeatAtTime(beatTime, currentBeatInMeasure, secPerBeat);
      }

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

  // ==========================================================================
  // ACOUSTIC JAZZ BRUSH BACK BEAT SYNTHESIS & CONTROLS
  // ==========================================================================

  public isBeatEnabled(): boolean {
    return this.isBeatActive;
  }

  public setBeatActive(active: boolean) {
    this.isBeatActive = active;
    this.updateDrumGain();
  }

  public toggleBeat(): boolean {
    this.isBeatActive = !this.isBeatActive;
    this.updateDrumGain();
    return this.isBeatActive;
  }

  public getBeatVolume(): number {
    return this.beatVolume;
  }

  public setBeatVolume(vol: number) {
    this.beatVolume = Math.max(0, Math.min(1, vol));
    this.updateDrumGain();
  }

  private updateDrumGain() {
    if (!this.ctx || !this.drumGain) return;
    const target = this.isBeatActive ? this.beatVolume : 0;
    this.drumGain.gain.cancelScheduledValues(this.ctx.currentTime);
    this.drumGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02);
  }

  private getNoiseBuffer(ctx: AudioContext): AudioBuffer {
    if (!this.noiseBuffer) {
      const length = Math.floor(ctx.sampleRate * 2.0);
      const buf = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < length; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      this.noiseBuffer = buf;
    }
    return this.noiseBuffer;
  }

  /**
   * Delicate acoustic feather kick:
   * Very soft, warm low-end thud (sine oscillator with gentle pitch drop 64Hz -> 42Hz,
   * smooth attack, lowpass at 160Hz to prevent click, quiet velocity).
   */
  private triggerFeatherKick(time: number, velocity = 0.25) {
    if (!this.ctx || !this.drumGain) return;
    const ctx = this.ctx;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(64, time);
    osc.frequency.exponentialRampToValueAtTime(42, time + 0.08);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(160, time);
    filter.Q.setValueAtTime(0.707, time);

    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(velocity * 0.42, time + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.13);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.drumGain);

    osc.start(time);
    osc.stop(time + 0.14);
  }

  /**
   * Delicate brushed snare sweep / stir:
   * Filtered white noise with smooth swelling attack and gentle textured decay,
   * emulating the soft circular brush stir on a coated snare head.
   */
  private triggerBrushedSnareSweep(time: number, durationSec = 0.22, velocity = 0.22) {
    if (!this.ctx || !this.drumGain) return;
    const ctx = this.ctx;

    const source = ctx.createBufferSource();
    source.buffer = this.getNoiseBuffer(ctx);
    source.playbackRate.setValueAtTime(0.96 + Math.random() * 0.08, time);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(2800, time);
    bp.Q.setValueAtTime(1.1, time);

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(1050, time);

    const gain = ctx.createGain();
    const actualDur = Math.max(0.12, durationSec);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(velocity * 0.30, time + 0.035);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + actualDur);

    source.connect(bp);
    bp.connect(hp);
    hp.connect(gain);
    gain.connect(this.drumGain);

    const offset = Math.random() * 1.5;
    source.start(time, offset);
    source.stop(time + actualDur + 0.02);
  }

  /**
   * Delicate brushed snare backbeat tap:
   * Crisp but soft brush snap with snare wire flutter + warm 180Hz wooden shell body.
   */
  private triggerBrushedSnareTap(time: number, velocity = 0.36) {
    if (!this.ctx || !this.drumGain) return;
    const ctx = this.ctx;

    // 1. Brushed wire response (noise)
    const noise = ctx.createBufferSource();
    noise.buffer = this.getNoiseBuffer(ctx);
    noise.playbackRate.setValueAtTime(1.0 + Math.random() * 0.1, time);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(3400, time);
    bp.Q.setValueAtTime(1.3, time);

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(1600, time);

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.0001, time);
    noiseGain.gain.linearRampToValueAtTime(velocity * 0.44, time + 0.005);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.11);

    noise.connect(bp);
    bp.connect(hp);
    hp.connect(noiseGain);
    noiseGain.connect(this.drumGain);

    const offset = Math.random() * 1.5;
    noise.start(time, offset);
    noise.stop(time + 0.12);

    // 2. Subtle wooden shell body tone
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(182, time);
    osc.frequency.exponentialRampToValueAtTime(155, time + 0.05);

    const bodyFilter = ctx.createBiquadFilter();
    bodyFilter.type = 'lowpass';
    bodyFilter.frequency.setValueAtTime(320, time);

    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(0.0001, time);
    bodyGain.gain.linearRampToValueAtTime(velocity * 0.18, time + 0.004);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.06);

    osc.connect(bodyFilter);
    bodyFilter.connect(bodyGain);
    bodyGain.connect(this.drumGain);

    osc.start(time);
    osc.stop(time + 0.07);
  }

  /**
   * Brushed hi-hat / cymbal ride tap:
   * Whispering high-frequency texture with fast silky decay.
   */
  private triggerBrushedHiHat(time: number, velocity = 0.22, decaySec = 0.055) {
    if (!this.ctx || !this.drumGain) return;
    const ctx = this.ctx;

    const source = ctx.createBufferSource();
    source.buffer = this.getNoiseBuffer(ctx);
    source.playbackRate.setValueAtTime(1.02 + Math.random() * 0.1, time);

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(7800, time);
    hp.Q.setValueAtTime(1.1, time);

    const peak = ctx.createBiquadFilter();
    peak.type = 'peaking';
    peak.frequency.setValueAtTime(10800, time);
    peak.gain.setValueAtTime(2.5, time);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(velocity * 0.26, time + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + decaySec);

    source.connect(hp);
    hp.connect(peak);
    peak.connect(gain);
    gain.connect(this.drumGain);

    const offset = Math.random() * 1.5;
    source.start(time, offset);
    source.stop(time + decaySec + 0.015);
  }

  /**
   * Schedules a subtle jazz brush groove beat:
   * Feather kick on downbeats, delicate snare sweeps and backbeat taps,
   * brushed hi-hat with authentic swing triplet skip!
   */
  private scheduleBackbeatAtTime(time: number, beatInMeasure: number, secPerBeat: number) {
    if (!this.isBeatActive) return;
    if (!this.customDrumLoopBuffer) return; // Cut base drum sound entirely

    if (this.ctx && this.drumGain) {
      if (beatInMeasure === 0) {
        const source = this.ctx.createBufferSource();
        source.buffer = this.customDrumLoopBuffer;
        const rate = this.bpm / this.customDrumLoopBaseBpm;
        source.playbackRate.setValueAtTime(Math.max(0.4, Math.min(2.5, rate)), time);

        const loopGain = this.ctx.createGain();
        loopGain.gain.setValueAtTime(0.85, time);

        source.connect(loopGain);
        loopGain.connect(this.drumGain);

        source.start(time);
        source.stop(time + (this.customDrumLoopBuffer.duration / rate));
      }
      return;
    }

    if (this.meter === 3) {
      // 3/4 Jazz Waltz Swing Feel
      if (beatInMeasure === 0) {
        this.triggerFeatherKick(time, 0.26);
        this.triggerBrushedSnareSweep(time, secPerBeat * 0.7, 0.20);
        this.triggerBrushedHiHat(time, 0.22, 0.06);
      } else if (beatInMeasure === 1) {
        this.triggerBrushedSnareTap(time, 0.34);
        this.triggerBrushedHiHat(time, 0.22, 0.05);
      } else {
        this.triggerBrushedSnareTap(time, 0.32);
        this.triggerBrushedHiHat(time, 0.22, 0.05);
        // Swing triplet skip on beat 3
        const skipTime = time + (2 / 3) * secPerBeat;
        this.triggerBrushedHiHat(skipTime, 0.16, 0.032);
      }
    } else {
      // 4/4 Jazz Brush Swing Feel
      if (beatInMeasure === 0) {
        // Beat 1: Feather kick + soft brush sweep + brushed hat
        this.triggerFeatherKick(time, 0.26);
        this.triggerBrushedSnareSweep(time, secPerBeat * 0.7, 0.20);
        this.triggerBrushedHiHat(time, 0.22, 0.06);
      } else if (beatInMeasure === 1) {
        // Beat 2: Backbeat brushed snare tap + brushed hat + swing triplet skip!
        this.triggerBrushedSnareTap(time, 0.38);
        this.triggerBrushedHiHat(time, 0.24, 0.05);
        const skipTime = time + (2 / 3) * secPerBeat;
        this.triggerBrushedHiHat(skipTime, 0.16, 0.032);
      } else if (beatInMeasure === 2) {
        // Beat 3: Subtle feather kick (feathered pulse) + brush sweep + hat
        this.triggerFeatherKick(time, 0.20);
        this.triggerBrushedSnareSweep(time, secPerBeat * 0.7, 0.18);
        this.triggerBrushedHiHat(time, 0.22, 0.06);
      } else {
        // Beat 4: Backbeat brushed snare tap + brushed hat + swing triplet skip!
        this.triggerBrushedSnareTap(time, 0.38);
        this.triggerBrushedHiHat(time, 0.24, 0.05);
        const skipTime = time + (2 / 3) * secPerBeat;
        this.triggerBrushedHiHat(skipTime, 0.17, 0.032);
      }
    }
  }
}

export const audioEngine = new ChordAudioEngine();
