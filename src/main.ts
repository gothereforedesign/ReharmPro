import './index.css';
import { audioEngine } from './audioEngine';

// Safely register Service Worker in production builds; in dev, clear any stale dev SW
if ('serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  } else {
    navigator.serviceWorker
      .getRegistrations()
      .then(regs => {
        regs.forEach(r => r.unregister());
      })
      .catch(() => {});
  }
}

interface ChordBeatItem {
  chord: string;
  beats: number;
  isTurnaround?: boolean;
}

interface BeatSlot {
  chord: Chord;
  isAttack: boolean;
  isTurnaround?: boolean;
}

export type ChordSlotRole = 'ANCHOR' | 'TARGET' | 'APPROACH_SPACE' | 'PASSING_SLOT';
export type ReharmMode = 'PASSING_ONLY' | 'APPROACH_TARGETING' | 'HYBRID' | 'FULL_REFRAME';
export type ReharmDensity = 'SPARSE' | 'BALANCED' | 'DENSE';

export interface ChordSlot {
  measure: number;          // 1-indexed measure number (1, 2, 3, 4...)
  beat: number;             // Beat position (1, 2, 3, 4)
  durationInBeats: number;
  chord: string;            // e.g., "D", "A7"
  role: ChordSlotRole;
  isUserFixed: boolean;     // True if user locks this chord/measure
}

export interface ReharmRequest {
  progression: ChordSlot[];
  mode: ReharmMode;
  targetIndex?: number;     // Specific measure index (0-based) being targeted (defaults to cadences)
  density: ReharmDensity;   // Controls harmonic rhythm
  techniqueId?: string;
  strategy?: string;
  meter?: number;
}

export interface ReharmExecutionOptions {
  mode?: ReharmMode;
  density?: ReharmDensity;
  targetIndex?: number | null;
  lockedMeasures?: number[];
  meter?: number;
  loopTargetChord?: Chord;
  disableTurnaround?: boolean;
}

type SavedSectionKey = 'basic' | 'jazz' | 'dark';

interface SavedSections {
  basic: string[];
  jazz: string[];
  dark: string[];
}

interface VaultPayload {
  updatedAt: number;
  theme: 'dark' | 'light';
  savedSections: SavedSections;
  baseProgressionsPool: string[];
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

const NOTE_TO_PITCH: Record<string, number> = {
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

const PITCH_TO_NOTE_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const PITCH_TO_NOTE_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const SHARP_ROOTS = new Set(['G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'G#', 'D#']);

export class Chord {
  root: string;
  quality: string;
  pitch: number;
  bass: string | null;
  preferSharps: boolean;

  constructor(root: string, quality = 'maj', bass: string | null = null, preferSharps: boolean | null = null) {
    const pitch = NOTE_TO_PITCH[root] ?? 0;
    const useSharp = preferSharps !== null
      ? preferSharps
      : (root.includes('#') || (!root.includes('b') && SHARP_ROOTS.has(root)));
    this.root = useSharp ? PITCH_TO_NOTE_SHARP[pitch] : PITCH_TO_NOTE_FLAT[pitch];
    this.quality = quality;
    this.pitch = pitch;
    this.bass = bass;
    this.preferSharps = useSharp;
  }

  static fromSymbol(symbolStr: string): Chord {
    if (!symbolStr) return new Chord('C', 'maj');
    const parts = symbolStr.trim().split('/');
    const mainPart = parts[0].trim();
    const rawBass = parts.length > 1 ? parts[1].trim() : null;
    const bassPart = rawBass ? rawBass.replace(/^([a-g])/, (_, c: string) => c.toUpperCase()) : null;

    const match = mainPart.match(/^([a-gA-G][#b]?)(.*)$/);
    if (!match) return new Chord('C', 'maj');

    const rawRoot = match[1].charAt(0).toUpperCase() + match[1].slice(1);
    const rawQual = match[2].trim();
    const useSharp = rawRoot.includes('#') || (!rawRoot.includes('b') && SHARP_ROOTS.has(rawRoot));

    let quality = 'maj';
    if (rawQual === '°7' || rawQual.toLowerCase() === 'dim7' || rawQual === '°') {
      quality = '°7';
    } else if (rawQual === 'ø' || rawQual.includes('m7b5') || rawQual.includes('m7(b5)') || rawQual.includes('dim')) {
      quality = 'm7b5';
    } else if (rawQual === 'm(maj7)' || rawQual === 'mMaj7' || rawQual === 'mΔ7' || rawQual === 'mΔ') {
      quality = 'm(maj7)';
    } else if (rawQual === 'Δ' || rawQual.includes('maj7') || rawQual.includes('M7') || rawQual.includes('Maj7')) {
      quality = 'maj7';
    } else if (rawQual.includes('m7') || rawQual.includes('min7')) {
      quality = 'm7';
    } else if (rawQual.includes('m6')) {
      quality = 'm6';
    } else if (rawQual.startsWith('m') || rawQual.startsWith('min')) {
      quality = 'm';
    } else if (rawQual === '7+' || rawQual === '7#5' || rawQual === '7aug') {
      quality = '7+';
    } else if (rawQual === '+' || rawQual === 'aug') {
      quality = '+';
    } else if (rawQual.toLowerCase() === '7alt') {
      quality = '7alt';
    } else if (rawQual.includes('7(b9)') || rawQual.includes('7b9')) {
      quality = '7(b9)';
    } else if (rawQual.includes('add2')) {
      quality = 'add2';
    } else if (rawQual.includes('add9')) {
      quality = 'add9';
    } else if (rawQual.includes('7') || rawQual.includes('9') || rawQual.includes('13')) {
      quality = '7';
    } else if (rawQual === '6') {
      quality = '6';
    } else if (rawQual === '' || rawQual === 'maj' || rawQual === 'M') {
      quality = 'maj';
    } else {
      quality = rawQual || 'maj';
    }

    return new Chord(rawRoot, quality, bassPart, useSharp);
  }

  isMinorTarget(): boolean {
    return (
      this.quality === 'm' ||
      this.quality === 'm7' ||
      this.quality === 'm7b5' ||
      this.quality === 'm6' ||
      this.quality === 'm(maj7)' ||
      this.quality === '°7'
    );
  }

  toString(): string {
    const qMap: Record<string, string> = {
      'maj': '',
      'maj7': 'Δ',
      'm': 'm',
      'm7': 'm7',
      'm6': 'm6',
      'm(maj7)': 'm(maj7)',
      '7': '7',
      '7alt': '7alt',
      '7+': '7+',
      '+': '+',
      '7(b9)': '7(b9)',
      '°7': '°7',
      'm7b5': 'ø',
      '6': '6',
      'add2': 'add2',
      'add9': 'add9'
    };
    const qStr = qMap[this.quality] !== undefined ? qMap[this.quality] : this.quality;
    return this.bass ? `${this.root}${qStr}/${this.bass}` : `${this.root}${qStr}`;
  }
}

export class TargetBackwardEngine {
  static transpose(root: string, semitones: number, preferSharps = false): string {
    const basePitch = NOTE_TO_PITCH[root] ?? 0;
    const pitch = ((basePitch + semitones) % 12 + 12) % 12;
    return preferSharps ? PITCH_TO_NOTE_SHARP[pitch] : PITCH_TO_NOTE_FLAT[pitch];
  }

  // 1. Tonicization (V7): X + 7 semitones -> Dominant 7th
  static tonicize(target: Chord): Chord {
    const useSharp = target.preferSharps ?? SHARP_ROOTS.has(target.root);
    const v7Root = this.transpose(target.root, 7, useSharp);
    return new Chord(v7Root, '7', null, useSharp);
  }

  // 2. Tritone Sub (bII7): X + 1 semitone -> Dominant 7th (flat spelling)
  static tritone_sub(target: Chord): Chord {
    const bii7Root = this.transpose(target.root, 1, false);
    return new Chord(bii7Root, '7', null, false);
  }

  // 3. Related ii7 Insertion: V7 + 7 semitones (or Target + 2 semitones) -> m7 (or m7b5)
  static add_related_two(dominantChord: Chord, resolveToMinor = false): Chord {
    const useSharp = dominantChord.preferSharps ?? SHARP_ROOTS.has(dominantChord.root);
    const iiRoot = this.transpose(dominantChord.root, 7, useSharp);
    return new Chord(iiRoot, resolveToMinor ? 'm7b5' : 'm7', null, useSharp);
  }

  // 4. Side-Step (Above): X + 1 semitone, exact same quality as X
  static side_step_above(target: Chord): Chord {
    const ssRoot = this.transpose(target.root, 1, false);
    return new Chord(ssRoot, target.quality, null, false);
  }

  // 5. Side-Step (Below): X - 1 semitone, exact same quality as X
  static side_step_below(target: Chord): Chord {
    const useSharp = target.preferSharps ?? false;
    const ssRoot = this.transpose(target.root, -1, useSharp);
    return new Chord(ssRoot, target.quality, null, useSharp);
  }

  // --- STRICTLY MUTUALLY EXCLUSIVE APPROACH CELLS PER REHARM TECHNIQUE ---
  static getApproachChords(targetChordX: Chord, techniqueId: string) {
    const isMin = targetChordX.isMinorTarget();
    let step1: Chord;
    let step2: Chord;
    let step3: Chord;
    let step4: Chord;
    let twoChordCell: Chord[];
    let threeChordCell: Chord[];
    let fourChordCell: Chord[];

    switch (techniqueId) {
      case 'tonicize': {
        // Pure V7 secondary dominant chain (no ii7, no tritone subs)
        step1 = this.tonicize(targetChordX);
        step2 = this.tonicize(step1);
        step3 = this.tonicize(step2);
        step4 = this.tonicize(step3);
        twoChordCell = [step2, step1];
        threeChordCell = [step3, step2, step1];
        fourChordCell = [step4, step3, step2, step1];
        break;
      }

      case 'tritone_sub': {
        // Pure bII7 tritone substitution chain (no V7, no ii7)
        step1 = this.tritone_sub(targetChordX);
        step2 = this.tritone_sub(step1);
        step3 = this.tritone_sub(step2);
        step4 = this.tritone_sub(step3);
        twoChordCell = [step2, step1];
        threeChordCell = [step3, step2, step1];
        fourChordCell = [step4, step3, step2, step1];
        break;
      }

      case 'standard_two_five': {
        // Pure diatonic/secondary ii-V cells (no tritone subs, no side-steps)
        const v7 = this.tonicize(targetChordX);
        const ii7 = this.add_related_two(v7, isMin);
        const v7OfIi = this.tonicize(ii7);
        const iiOfIi = this.add_related_two(v7OfIi, true);
        step1 = v7;
        step2 = ii7;
        step3 = v7OfIi;
        step4 = iiOfIi;
        twoChordCell = [ii7, v7];
        threeChordCell = [v7OfIi, ii7, v7];
        fourChordCell = [iiOfIi, v7OfIi, ii7, v7];
        break;
      }

      case 'tritone_two_five': {
        // Pure tritone bii7 - bII7 cells (never mixes standard ii-V)
        const bII7 = this.tritone_sub(targetChordX);
        const bii7 = this.add_related_two(bII7, false);
        const bII7OfBii = this.tritone_sub(bii7);
        const biiOfBii = this.add_related_two(bII7OfBii, false);
        step1 = bII7;
        step2 = bii7;
        step3 = bII7OfBii;
        step4 = biiOfBii;
        twoChordCell = [bii7, bII7];
        threeChordCell = [bII7OfBii, bii7, bII7];
        fourChordCell = [biiOfBii, bII7OfBii, bii7, bII7];
        break;
      }

      case 'side_step_above': {
        // Pure upper chromatic side-step of identical quality (never mixes V7)
        step1 = this.side_step_above(targetChordX);
        step2 = this.side_step_above(step1);
        step3 = this.side_step_above(step2);
        step4 = this.side_step_above(step3);
        twoChordCell = [step2, step1];
        threeChordCell = [step3, step2, step1];
        fourChordCell = [step4, step3, step2, step1];
        break;
      }

      case 'side_step_below': {
        // Pure lower chromatic side-step of identical quality (never mixes V7)
        step1 = this.side_step_below(targetChordX);
        step2 = this.side_step_below(step1);
        step3 = this.side_step_below(step2);
        step4 = this.side_step_below(step3);
        twoChordCell = [step2, step1];
        threeChordCell = [step3, step2, step1];
        fourChordCell = [step4, step3, step2, step1];
        break;
      }

      case 'side_step_two_five': {
        // Pure side-stepped ii-V -> target ii-V (always ending on the true ii-V of targetChordX)
        const v7 = this.tonicize(targetChordX);
        const ii7 = this.add_related_two(v7, isMin);
        const ssV = this.side_step_above(v7);
        const ssII = this.side_step_above(ii7);
        step1 = v7;
        step2 = ii7;
        step3 = ssV;
        step4 = ssII;
        twoChordCell = [ii7, v7];
        threeChordCell = [ssV, ii7, v7];
        fourChordCell = [ssII, ssV, ii7, v7];
        break;
      }

      case 'dorian_dark': {
        const pal = this.buildDarkPalette(targetChordX.root);
        step1 = pal.IV7;
        step2 = pal.ii7;
        step3 = pal.i6;
        step4 = pal.im7;
        twoChordCell = [pal.ii7, pal.IV7];
        threeChordCell = [pal.i6, pal.ii7, pal.IV7];
        fourChordCell = [pal.im7, pal.i6, pal.ii7, pal.IV7];
        break;
      }

      case 'chromatic_mediant': {
        const pal = this.buildDarkPalette(targetChordX.root);
        step1 = pal.bvi;
        step2 = pal.biii;
        step3 = pal.bVIaug;
        step4 = pal.bvi6;
        twoChordCell = [pal.biii, pal.bvi];
        threeChordCell = [pal.bVI, pal.biii, pal.bvi];
        fourChordCell = [pal.bvi6, pal.bVIaug, pal.biii, pal.bvi];
        break;
      }

      case 'gothic_dominant': {
        const pal = this.buildDarkPalette(targetChordX.root);
        step1 = pal.V7b9;
        step2 = pal.iiHalf;
        step3 = pal.bVIaug;
        step4 = pal.ivMin6;
        twoChordCell = [pal.iiHalf, pal.V7b9];
        threeChordCell = [pal.ivMin6, pal.iiHalf, pal.V7b9];
        fourChordCell = [pal.bVIaug, pal.ivMin6, pal.iiHalf, pal.V7b9];
        break;
      }

      case 'neapolitan_slide': {
        const pal = this.buildDarkPalette(targetChordX.root);
        step1 = pal.bII;
        step2 = pal.biim;
        step3 = pal.bII7;
        step4 = pal.i6;
        twoChordCell = [pal.biim, pal.bII];
        threeChordCell = [pal.i6, pal.biim, pal.bII7];
        fourChordCell = [pal.i6, pal.bII, pal.biim, pal.bII7];
        break;
      }

      case 'diminished_axis': {
        const pal = this.buildDarkPalette(targetChordX.root);
        step1 = pal.viiDim7;
        step2 = pal.sh4Dim7;
        step3 = pal.Vaug;
        step4 = pal.sh1Dim7;
        twoChordCell = [pal.sh4Dim7, pal.viiDim7];
        threeChordCell = [pal.sh1Dim7, pal.sh4Dim7, pal.viiDim7];
        fourChordCell = [pal.tritMin, pal.sh1Dim7, pal.sh4Dim7, pal.viiDim7];
        break;
      }

      case 'elfman_modulation': {
        const pal = this.buildDarkPalette(targetChordX.root);
        const modUp3 = this.buildDarkPalette(this.transpose(targetChordX.root, 3, false));
        const modDown4 = this.buildDarkPalette(this.transpose(targetChordX.root, 8, false));
        step1 = pal.imMaj7;
        step2 = modUp3.imMaj7;
        step3 = modDown4.i6;
        step4 = modUp3.i;
        twoChordCell = [modUp3.i, pal.imMaj7];
        threeChordCell = [modDown4.i, modUp3.imMaj7, pal.imMaj7];
        fourChordCell = [modDown4.i, modDown4.imMaj7, modUp3.i, pal.imMaj7];
        break;
      }

      case 'circle_of_fifths':
      default: {
        // Pure extended Circle of 5ths dominant chain
        step1 = this.tonicize(targetChordX);
        step2 = this.tonicize(step1);
        step3 = this.tonicize(step2);
        step4 = this.tonicize(step3);
        twoChordCell = [step2, step1];
        threeChordCell = [step3, step2, step1];
        fourChordCell = [step4, step3, step2, step1];
        break;
      }
    }

    return {
      step1,
      step2,
      step3,
      step4,
      twoChordCell,
      threeChordCell,
      fourChordCell
    };
  }

  static fillBarBeats(barGrid: BeatSlot[], chordsList: Chord[], splitMode: 'standard' | 'early' | 'late' = 'standard') {
    const len = barGrid.length;
    if (len === 0 || !chordsList || chordsList.length === 0) return;

    if (chordsList.length === 1) {
      for (let b = 0; b < len; b++) {
        barGrid[b] = { chord: chordsList[0], isAttack: b === 0 };
      }
      return;
    }

    if (chordsList.length === 2) {
      const [c1, c2] = chordsList;
      if (len === 3) {
        const splitIdx = splitMode === 'early' ? 1 : 2;
        for (let b = 0; b < len; b++) {
          barGrid[b] = { chord: b < splitIdx ? c1 : c2, isAttack: b === 0 || b === splitIdx };
        }
      } else {
        const half = Math.max(1, Math.floor(len / 2));
        const splitIdx = splitMode === 'late' ? Math.max(1, len - 1) : (splitMode === 'early' ? 1 : half);
        for (let b = 0; b < len; b++) {
          barGrid[b] = { chord: b < splitIdx ? c1 : c2, isAttack: b === 0 || b === splitIdx };
        }
      }
      return;
    }

    if (chordsList.length === 3) {
      const [c1, c2, c3] = chordsList;
      if (len === 3) {
        barGrid[0] = { chord: c1, isAttack: true };
        barGrid[1] = { chord: c2, isAttack: true };
        barGrid[2] = { chord: c3, isAttack: true };
      } else if (len >= 4) {
        if (splitMode === 'early') {
          barGrid[0] = { chord: c1, isAttack: true };
          barGrid[1] = { chord: c2, isAttack: true };
          for (let b = 2; b < len; b++) barGrid[b] = { chord: c3, isAttack: b === 2 };
        } else {
          const firstSpan = len - 2;
          for (let b = 0; b < firstSpan; b++) barGrid[b] = { chord: c1, isAttack: b === 0 };
          barGrid[len - 2] = { chord: c2, isAttack: true };
          barGrid[len - 1] = { chord: c3, isAttack: true };
        }
      } else {
        this.fillBarBeats(barGrid, [c2, c3], splitMode);
      }
      return;
    }

    if (len === 3) {
      const last3 = chordsList.slice(-3);
      barGrid[0] = { chord: last3[0], isAttack: true };
      barGrid[1] = { chord: last3[1], isAttack: true };
      barGrid[2] = { chord: last3[2], isAttack: true };
    } else if (len >= 4) {
      const last4 = chordsList.slice(-4);
      barGrid[0] = { chord: last4[0], isAttack: true };
      barGrid[1] = { chord: last4[1], isAttack: true };
      barGrid[2] = { chord: last4[2], isAttack: true };
      for (let b = 3; b < len; b++) barGrid[b] = { chord: last4[3], isAttack: b === 3 };
    } else {
      this.fillBarBeats(barGrid, chordsList.slice(-2), splitMode);
    }
  }

  // ============================================================================
  // AUTONOMOUS TARGET DETECTION & STRUCTURAL HEURISTICS
  // ============================================================================
  static resolveTargetMeasureIndex(
    numMeasures: number,
    explicitTargetIdx?: number | null
  ): number {
    if (numMeasures <= 0) return 0;
    if (
      explicitTargetIdx !== undefined &&
      explicitTargetIdx !== null &&
      explicitTargetIdx >= 0 &&
      explicitTargetIdx < numMeasures
    ) {
      return explicitTargetIdx;
    }
    return numMeasures - 1;
  }

  /**
   * Automatically scans a phrase of measures to find the natural Cadence Landing ("Target X"):
   * - If the last 2 bars of a 4+ bar phrase hold the exact same chord after a change
   *   (e.g., Dm7 | G7 | Cmaj7 | Cmaj7, or C | F | G | G), Measure 3 (index numMeasures - 2)
   *   is the primary harmonic arrival (Target X), while Measure 4 is a static post-cadence bar.
   * - If a 4-bar phrase is a 2+2 pattern (e.g., Cmaj7 | Cmaj7 | Fmaj7 | Fmaj7),
   *   Measure 3 (index 2) is the internal cadence shift Target X.
   * - Otherwise (e.g., D | D | D | A, or C | G | Am | F), the final bar of the phrase
   *   (numMeasures - 1) is Target X.
   */
  static detectAutonomousTargetIndex(
    measures: ChordBeatItem[][],
    explicitTargetIdx?: number | null
  ): { targetMIdx: number; hasPostCadenceExtension: boolean; isTwoByTwoPhrase: boolean } {
    const numMeasures = measures.length;
    if (numMeasures <= 1) {
      return { targetMIdx: 0, hasPostCadenceExtension: false, isTwoByTwoPhrase: false };
    }
    if (
      explicitTargetIdx !== undefined &&
      explicitTargetIdx !== null &&
      explicitTargetIdx >= 0 &&
      explicitTargetIdx < numMeasures
    ) {
      return {
        targetMIdx: explicitTargetIdx,
        hasPostCadenceExtension: false,
        isTwoByTwoPhrase: false
      };
    }

    if (numMeasures >= 4) {
      const m0 = measures[0];
      const m1 = measures[1];
      const mLast2 = measures[numMeasures - 2];
      const mLast1 = measures[numMeasures - 1];
      const mLast3 = measures[numMeasures - 3];

      const isTwoByTwo =
        numMeasures === 4 &&
        m0.length === 1 &&
        m1.length === 1 &&
        mLast2.length === 1 &&
        mLast1.length === 1 &&
        m0[0].chord === m1[0].chord &&
        mLast2[0].chord === mLast1[0].chord &&
        m1[0].chord !== mLast2[0].chord;

      if (isTwoByTwo) {
        return { targetMIdx: 2, hasPostCadenceExtension: true, isTwoByTwoPhrase: true };
      }

      const isDoubledCadence =
        mLast2.length === 1 &&
        mLast1.length === 1 &&
        mLast2[0].chord === mLast1[0].chord &&
        mLast3[0]?.chord !== mLast2[0].chord;

      if (isDoubledCadence) {
        return {
          targetMIdx: numMeasures - 2,
          hasPostCadenceExtension: true,
          isTwoByTwoPhrase: false
        };
      }
    }

    return {
      targetMIdx: numMeasures - 1,
      hasPostCadenceExtension: false,
      isTwoByTwoPhrase: false
    };
  }

  static parseProgressionToSlots(
    measures: ChordBeatItem[][],
    options: ReharmExecutionOptions = {}
  ): ChordSlot[] {
    if (!measures || measures.length === 0) return [];
    const mode: ReharmMode = options.mode || 'HYBRID';
    const lockedSet = new Set(options.lockedMeasures || []);
    const numMeasures = measures.length;
    const { targetMIdx } = this.detectAutonomousTargetIndex(measures, options.targetIndex);
    const approachMIdx = targetMIdx > 0 ? targetMIdx - 1 : numMeasures - 1;

    const slots: ChordSlot[] = [];

    measures.forEach((meas, mIdx) => {
      let currentBeat = 1;
      const isMeasureLocked = lockedSet.has(mIdx);

      meas.forEach((item, cIdx) => {
        let role: ChordSlotRole = 'APPROACH_SPACE';

        if (isMeasureLocked) {
          role = 'ANCHOR';
        } else if (mIdx === targetMIdx && cIdx === 0) {
          role = 'TARGET';
        } else if (mIdx === 0 && cIdx === 0 && mode !== 'FULL_REFRAME') {
          // Rule 1: Measure 1, Beat 1 is automatically locked as ANCHOR
          role = 'ANCHOR';
        } else if (mode === 'PASSING_ONLY') {
          role = 'PASSING_SLOT';
        } else if (mIdx === approachMIdx) {
          role = 'APPROACH_SPACE';
        } else {
          role = 'PASSING_SLOT';
        }

        slots.push({
          measure: mIdx + 1,
          beat: currentBeat,
          durationInBeats: item.beats,
          chord: item.chord,
          role,
          isUserFixed: isMeasureLocked
        });

        currentBeat += item.beats;
      });
    });

    return slots;
  }

  static slotsToMeasures(slots: ChordSlot[]): ChordBeatItem[][] {
    if (!slots || slots.length === 0) return [];
    const byMeasure = new Map<number, ChordBeatItem[]>();
    slots.forEach(s => {
      const mIdx = Math.max(0, s.measure - 1);
      if (!byMeasure.has(mIdx)) {
        byMeasure.set(mIdx, []);
      }
      const arr = byMeasure.get(mIdx)!;
      if (arr.length > 0 && arr[arr.length - 1].chord === s.chord) {
        arr[arr.length - 1].beats += s.durationInBeats;
      } else {
        arr.push({ chord: s.chord, beats: s.durationInBeats });
      }
    });
    const maxM = Math.max(...Array.from(byMeasure.keys()));
    const result: ChordBeatItem[][] = [];
    for (let m = 0; m <= maxM; m++) {
      result.push(byMeasure.get(m) || []);
    }
    return result;
  }

  // ============================================================================
  // HELPER: INSERT PASSING CHORD(S) INTO A BAR WITHOUT DELETING BASE CHORD(S)
  // ============================================================================
  static insertPassingIntoBar(
    barGrid: BeatSlot[],
    origMeas: ChordBeatItem[],
    nextTargetChord: Chord,
    techniqueId: string,
    subStyle: 'beat4_pickup' | 'beats34_single' | 'beats34_two_chord' | 'beats234_walk'
  ) {
    const len = barGrid.length;
    if (len < 2 || !origMeas || origMeas.length === 0) return;

    const approachToNext = this.getApproachChords(nextTargetChord, techniqueId);
    const { step1, step2, step3, twoChordCell, fourChordCell } = approachToNext;
    const isTwoFiveTech =
      techniqueId === 'standard_two_five' ||
      techniqueId === 'tritone_two_five' ||
      techniqueId === 'side_step_two_five';

    // Case A: Single sustained chord in the measure (e.g. | D / / / |)
    if (origMeas.length === 1) {
      const baseChord = Chord.fromSymbol(origMeas[0].chord);
      if (len === 3) {
        if (isTwoFiveTech || subStyle === 'beats34_two_chord' || subStyle === 'beats234_walk') {
          this.fillBarBeats(barGrid, [baseChord, twoChordCell[0], twoChordCell[1]], 'standard');
        } else {
          this.fillBarBeats(barGrid, [baseChord, step1], 'late');
        }
        return;
      }

      // 4/4 time (len >= 4)
      if (isTwoFiveTech) {
        if (techniqueId === 'side_step_two_five' && subStyle === 'beats234_walk') {
          this.fillBarBeats(barGrid, fourChordCell, 'standard');
        } else {
          // Always insert the complete [ii, V] pair on Beats 3 & 4 leading into nextTargetChord
          this.fillBarBeats(barGrid, [baseChord, twoChordCell[0], twoChordCell[1]], 'standard');
        }
        return;
      }

      if (subStyle === 'beat4_pickup') {
        // Keep baseChord on Beats 1, 2, 3; insert passing chord on Beat 4
        this.fillBarBeats(barGrid, [baseChord, step1], 'late');
      } else if (subStyle === 'beats34_single') {
        // Keep baseChord on Beats 1 & 2; insert passing chord on Beats 3 & 4
        this.fillBarBeats(barGrid, [baseChord, step1], 'standard');
      } else if (subStyle === 'beats34_two_chord') {
        // Keep baseChord on Beats 1 & 2; insert 2-chord passing cell on Beats 3 & 4
        this.fillBarBeats(barGrid, [baseChord, twoChordCell[0], twoChordCell[1]], 'standard');
      } else {
        // 'beats234_walk': Keep baseChord on Beat 1; 3-step passing walk on Beats 2, 3, 4
        this.fillBarBeats(barGrid, [baseChord, step3, step2, step1], 'standard');
      }
      return;
    }

    // Case B: Measure already has 2 chords (e.g. | C / G / |, each 2 beats)
    if (origMeas.length === 2 && len >= 4) {
      const c1 = Chord.fromSymbol(origMeas[0].chord);
      const c2 = Chord.fromSymbol(origMeas[1].chord);
      if (isTwoFiveTech) {
        // Keep c1 on Beat 1, c2 on Beat 2, and insert the complete [ii, V] of nextTargetChord on Beats 3 & 4
        barGrid[0] = { chord: c1, isAttack: true };
        barGrid[1] = { chord: c2, isAttack: true };
        barGrid[2] = { chord: twoChordCell[0], isAttack: true };
        for (let b = 3; b < len; b++) {
          barGrid[b] = { chord: twoChordCell[1], isAttack: b === 3 };
        }
      } else if (subStyle === 'beat4_pickup' || subStyle === 'beats34_single') {
        // Keep c1 on Beats 1-2, c2 on Beat 3, insert passing chord on Beat 4 approaching next bar
        barGrid[0] = { chord: c1, isAttack: true };
        barGrid[1] = { chord: c1, isAttack: false };
        barGrid[2] = { chord: c2, isAttack: true };
        for (let b = 3; b < len; b++) {
          barGrid[b] = { chord: step1, isAttack: b === 3 };
        }
      } else {
        // Insert passing chord on Beat 2 approaching c2 AND on Beat 4 approaching next bar
        const appToC2 = this.getApproachChords(c2, techniqueId);
        barGrid[0] = { chord: c1, isAttack: true };
        barGrid[1] = { chord: appToC2.step1, isAttack: true };
        barGrid[2] = { chord: c2, isAttack: true };
        for (let b = 3; b < len; b++) {
          barGrid[b] = { chord: step1, isAttack: b === 3 };
        }
      }
      return;
    }

    // Case C: Measure has 3 chords in 4/4 (e.g. 2 beats + 1 beat + 1 beat) -> subdivide the 2-beat slot if first
    if (origMeas.length === 3 && origMeas[0].beats >= 2 && len >= 4) {
      const c1 = Chord.fromSymbol(origMeas[0].chord);
      const c2 = Chord.fromSymbol(origMeas[1].chord);
      const c3 = Chord.fromSymbol(origMeas[2].chord);
      const appToC2 = this.getApproachChords(c2, techniqueId);
      barGrid[0] = { chord: c1, isAttack: true };
      barGrid[1] = { chord: appToC2.step1, isAttack: true };
      barGrid[2] = { chord: c2, isAttack: true };
      for (let b = 3; b < len; b++) {
        barGrid[b] = { chord: c3, isAttack: b === 3 };
      }
    }
  }

  // ============================================================================
  // TURNAROUND / TURN-BACK ENGINE (TREATS BAR 1, BEAT 1 AS IMPLICIT TARGET X)
  // ============================================================================
  static applyTurnaroundToFinalBar(
    finalGrid: BeatSlot[],
    _origFinalBar: ChordBeatItem[],
    loopDestinationChord: Chord,
    techniqueId: string,
    turnaroundStyle: 'auto' | 'two_chord' | 'single_34' | 'beat4_pickup' = 'auto'
  ): void {
    const len = finalGrid.length;
    if (len < 2) return;

    const { step1, step2, twoChordCell } = this.getApproachChords(loopDestinationChord, techniqueId);
    const isPassingBeatTechnique =
      techniqueId === 'diminished_pivot' ||
      techniqueId === 'side_step' ||
      techniqueId === 'chromatic_bass' ||
      techniqueId === 'diminished_axis';
    const isTwoFiveFamily =
      techniqueId === 'standard_two_five' ||
      techniqueId === 'tritone_two_five' ||
      techniqueId === 'side_step_two_five' ||
      techniqueId === 'circle_of_fifths' ||
      techniqueId === 'backdoor' ||
      techniqueId === 'dorian_dark' ||
      techniqueId === 'gothic_dominant' ||
      techniqueId === 'neapolitan_slide' ||
      techniqueId === 'chromatic_mediant';

    const isCoreTwoFive =
      techniqueId === 'standard_two_five' ||
      techniqueId === 'tritone_two_five' ||
      techniqueId === 'side_step_two_five';

    let resolvedStyle: 'two_chord' | 'single_34' | 'beat4_pickup';
    if (isCoreTwoFive && len >= 4) {
      resolvedStyle = 'two_chord';
    } else if (turnaroundStyle === 'auto') {
      if (isPassingBeatTechnique) {
        resolvedStyle = 'beat4_pickup';
      } else if (isTwoFiveFamily) {
        resolvedStyle = 'two_chord';
      } else {
        resolvedStyle = 'single_34';
      }
    } else {
      resolvedStyle = turnaroundStyle;
    }

    const firstChord = finalGrid[0].chord;

    if (len === 3) {
      // 3/4 meter: keep Beats 1-2, insert turnaround pickup on Beat 3
      const prevChordStr = finalGrid[len - 2].chord.toString();
      const pickupChord = step1.toString() === prevChordStr ? twoChordCell[0] : step1;
      finalGrid[len - 1] = { chord: pickupChord, isAttack: true, isTurnaround: true };
      return;
    }

    if (resolvedStyle === 'beat4_pickup') {
      // Preserve Beats 1..3 (e.g. A A/B A/C#) and insert passing chromatic/turnaround chord on final beat (Beat 4)
      const prevChordStr = finalGrid[len - 2].chord.toString();
      const pickupChord = step1.toString() === prevChordStr ? twoChordCell[0] : step1;
      finalGrid[len - 1] = { chord: pickupChord, isAttack: true, isTurnaround: true };
      return;
    }

    if (resolvedStyle === 'single_34') {
      // Hold opening chord of the final measure on Beats 1 & 2, reserve Beats 3 & 4 for turn-back chord
      finalGrid[0] = { chord: firstChord, isAttack: true };
      finalGrid[1] = { chord: firstChord, isAttack: false };
      if (step1.toString() === firstChord.toString()) {
        finalGrid[len - 2] = { chord: twoChordCell[0], isAttack: true, isTurnaround: true };
        finalGrid[len - 1] = { chord: twoChordCell[1], isAttack: true, isTurnaround: true };
      } else {
        finalGrid[len - 2] = { chord: step1, isAttack: true, isTurnaround: true };
        finalGrid[len - 1] = { chord: step1, isAttack: false, isTurnaround: true };
      }
      return;
    }

    // resolvedStyle === 'two_chord'
    // Hold opening chord of the final measure on Beats 1 & 2, reserve Beats 3 & 4 for 2-chord turnaround (e.g. Em7 A7 or Bbm7 Eb7)
    finalGrid[0] = { chord: firstChord, isAttack: true };
    finalGrid[1] = { chord: firstChord, isAttack: false };
    const c1 = twoChordCell[0];
    const c2 = twoChordCell[1];
    if (c1.toString() === c2.toString()) {
      finalGrid[len - 2] = { chord: step2, isAttack: true, isTurnaround: true };
      finalGrid[len - 1] = { chord: step1, isAttack: true, isTurnaround: true };
    } else {
      finalGrid[len - 2] = { chord: c1, isAttack: true, isTurnaround: true };
      finalGrid[len - 1] = { chord: c2, isAttack: true, isTurnaround: true };
    }
  }

  // ============================================================================
  // MODE A: PASSING CHORD MODE (INSERTION — NEVER DELETES BASE CHORDS)
  // ============================================================================
  static reharmonizePassingMode(
    measures: ChordBeatItem[][],
    techniqueId: string,
    strategy: string,
    options: ReharmExecutionOptions = {}
  ): ChordBeatItem[][] {
    if (!measures || measures.length === 0) return [];
    const density: ReharmDensity = options.density || 'BALANCED';
    const lockedSet = new Set(options.lockedMeasures || []);
    const numMeasures = measures.length;
    const targetMIdx = this.resolveTargetMeasureIndex(numMeasures, options.targetIndex);

    const measureBeatGrids: BeatSlot[][] = measures.map(meas => {
      const beats: BeatSlot[] = [];
      meas.forEach(item => {
        const cObj = Chord.fromSymbol(item.chord);
        for (let b = 0; b < item.beats; b++) {
          beats.push({ chord: cObj, isAttack: b === 0 });
        }
      });
      return beats;
    });

    const isTwoFiveFamily = (
      techniqueId === 'standard_two_five' ||
      techniqueId === 'tritone_two_five' ||
      techniqueId === 'side_step_two_five' ||
      techniqueId === 'dorian_dark' ||
      techniqueId === 'gothic_dominant'
    );

    // Map strategy + density to which bars receive passing chords and which subdivision style
    for (let mIdx = 0; mIdx < numMeasures; mIdx++) {
      if (lockedSet.has(mIdx)) continue; // Respect user lock

      const nextMIdx = (mIdx + 1) % numMeasures;
      const nextChord = measureBeatGrids[nextMIdx]?.[0]?.chord;
      if (!nextChord) continue;

      const isTargetBar = mIdx === targetMIdx;
      const isRunwayBeforeTarget = mIdx === ((targetMIdx - 1 + numMeasures) % numMeasures);

      let shouldSubdivide = false;
      let subStyle: 'beat4_pickup' | 'beats34_single' | 'beats34_two_chord' | 'beats234_walk' =
        density === 'SPARSE'
          ? 'beat4_pickup'
          : density === 'DENSE'
            ? 'beats34_two_chord'
            : (isTwoFiveFamily ? 'beats34_two_chord' : 'beats34_single');

      if (numMeasures === 1) {
        shouldSubdivide = true;
        if (strategy === 'strategy2') subStyle = 'beat4_pickup';
        else if (strategy === 'strategy3') subStyle = 'beats34_two_chord';
        else if (strategy === 'strategy4') subStyle = 'beats234_walk';
      } else {
        switch (strategy) {
          case 'strategy1': {
            // Primary Passing: All non-target bars get passing movement into the next bar
            shouldSubdivide = !isTargetBar;
            break;
          }
          case 'strategy2': {
            // Late Beat-4 Pickups on all non-target bars
            shouldSubdivide = !isTargetBar;
            subStyle = 'beat4_pickup';
            break;
          }
          case 'strategy3': {
            // 2-chord passing cell on Beats 3 & 4 in runway bar; Beat-4 pickup in earlier bars
            shouldSubdivide = !isTargetBar;
            subStyle = isRunwayBeforeTarget ? 'beats34_two_chord' : 'beat4_pickup';
            break;
          }
          case 'strategy4': {
            // Spacious Alternating: Only Runway bar (and Bar 1 if 4+ bars) get passing chords
            shouldSubdivide = isRunwayBeforeTarget || (numMeasures >= 4 && mIdx === 0 && !isTargetBar);
            subStyle = density === 'SPARSE' ? 'beat4_pickup' : 'beats34_two_chord';
            break;
          }
          case 'strategy5': {
            // Focused Cadential Passing: Only the bar immediately before Target X gets passing chords
            shouldSubdivide = isRunwayBeforeTarget;
            subStyle = isTwoFiveFamily || density !== 'SPARSE' ? 'beats34_two_chord' : 'beats34_single';
            break;
          }
          case 'strategy6': {
            // Internal bars get 2-beat passing; Target X bar also gets a Beat-4 turnaround pickup
            shouldSubdivide = true;
            subStyle = isTargetBar ? 'beat4_pickup' : 'beats34_single';
            break;
          }
          case 'strategy7': {
            // Escalating harmonic rhythm: Beat-4 pickup early, 2-chord cell in runway before Target
            if (!isTargetBar) {
              shouldSubdivide = true;
              subStyle = isRunwayBeforeTarget
                ? (density === 'DENSE' ? 'beats234_walk' : 'beats34_two_chord')
                : 'beat4_pickup';
            }
            break;
          }
          case 'strategy8':
          default: {
            // Full forward momentum across all unlocked bars including turnaround
            shouldSubdivide = true;
            subStyle = density === 'SPARSE'
              ? 'beats34_single'
              : (density === 'DENSE' && isRunwayBeforeTarget ? 'beats234_walk' : 'beats34_two_chord');
            break;
          }
        }
      }

      if (shouldSubdivide) {
        if (mIdx === numMeasures - 1 && !options.disableTurnaround) {
          this.applyTurnaroundToFinalBar(
            measureBeatGrids[mIdx],
            measures[mIdx],
            options.loopTargetChord || nextChord,
            techniqueId,
            subStyle === 'beat4_pickup' ? 'beat4_pickup' : 'auto'
          );
        } else {
          this.insertPassingIntoBar(
            measureBeatGrids[mIdx],
            measures[mIdx],
            nextChord,
            techniqueId,
            subStyle
          );
        }
      }
    }

    return this.compressBeatGrids(measureBeatGrids);
  }

  // ============================================================================
  // AUTONOMOUS TARGET-FIRST BACKWARD & PASSING ENGINE
  // ============================================================================
  static reharmonizeProgressionBackward(
    measures: ChordBeatItem[][],
    techniqueId = 'tonicize',
    strategy = 'strategy1',
    options: ReharmExecutionOptions = {}
  ): ChordBeatItem[][] {
    if (!measures || measures.length === 0) return [];

    // Default to autonomous HYBRID arrangement (combines Passing Chords on static bars + Approach Chains before Target X)
    const mode: ReharmMode = options.mode || 'HYBRID';
    const density: ReharmDensity = options.density || 'BALANCED';
    const lockedSet = new Set(options.lockedMeasures || []);

    if (mode === 'PASSING_ONLY') {
      return this.reharmonizePassingMode(measures, techniqueId, strategy, options);
    }

    // Strategy 4 in autonomous HYBRID mode acts as "Card 1 (Subtle Passing)":
    // Keeps the ending as-is and adds light internal passing chords on Beats 3-4 before changes
    if (mode === 'HYBRID' && !options.targetIndex && strategy === 'strategy4') {
      return this.reharmonizePassingMode(measures, techniqueId, 'strategy1', options);
    }

    // Build fresh beat grids from the unmodified base measures
    const measureBeatGrids: BeatSlot[][] = measures.map(meas => {
      const beats: BeatSlot[] = [];
      meas.forEach(item => {
        const cObj = Chord.fromSymbol(item.chord);
        for (let b = 0; b < item.beats; b++) {
          beats.push({ chord: cObj, isAttack: b === 0 });
        }
      });
      return beats;
    });

    const numMeasures = measureBeatGrids.length;
    const loopDestinationChord = options.loopTargetChord || measureBeatGrids[0][0].chord;
    const finalMIdx = numMeasures - 1;
    const canTurnaroundFinalBar =
      !options.disableTurnaround &&
      !lockedSet.has(finalMIdx) &&
      measureBeatGrids[finalMIdx].length >= 2;

    // Strategy 2 & Strategy 5 in autonomous HYBRID mode act as "Loop Turnaround" variations:
    // Keep Bars 1..(N-1) intact (or on Strategy 5, also add a passing approach in Bar 1 -> Bar 2)
    // and reharmonize the end of the final bar to pull back into Bar 1, Beat 1!
    if (
      mode === 'HYBRID' &&
      !options.targetIndex &&
      numMeasures >= 2 &&
      canTurnaroundFinalBar &&
      (strategy === 'strategy2' || strategy === 'strategy5')
    ) {
      const isPassingBeatTechnique =
        techniqueId === 'diminished_pivot' ||
        techniqueId === 'side_step' ||
        techniqueId === 'chromatic_bass' ||
        techniqueId === 'diminished_axis';
      if (strategy === 'strategy5' && numMeasures >= 3 && !lockedSet.has(0)) {
        const bar1Target = measureBeatGrids[1]?.[0]?.chord;
        if (bar1Target) {
          this.insertPassingIntoBar(
            measureBeatGrids[0],
            measures[0],
            bar1Target,
            techniqueId,
            'beats34_two_chord'
          );
        }
      }
      const turnStyle =
        strategy === 'strategy2'
          ? 'auto'
          : (isPassingBeatTechnique ? 'two_chord' : 'beat4_pickup');
      this.applyTurnaroundToFinalBar(
        measureBeatGrids[finalMIdx],
        measures[finalMIdx],
        loopDestinationChord,
        techniqueId,
        turnStyle
      );
      return this.compressBeatGrids(measureBeatGrids);
    }

    const autoTarget = this.detectAutonomousTargetIndex(measures, options.targetIndex);
    let targetMIdx = autoTarget.targetMIdx;

    // For doubled-cadence progressions (e.g., Dm7 | G7 | Cmaj7 | Cmaj7),
    // targetMIdx defaults to Measure 3 (index numMeasures - 2, the initial resolution of Cmaj7).
    // Allow strategy 8 to target the final Measure 4 (numMeasures - 1) as an alternate cadence resolution!
    const userPinnedTarget =
      options.targetIndex !== undefined && options.targetIndex !== null;
    if (
      !userPinnedTarget &&
      autoTarget.hasPostCadenceExtension &&
      !autoTarget.isTwoByTwoPhrase &&
      strategy === 'strategy8'
    ) {
      targetMIdx = numMeasures - 1;
    }

    const targetGrid = measureBeatGrids[targetMIdx];
    if (!targetGrid || targetGrid.length === 0) return measures;

    const targetChordX = targetGrid[0].chord;
    const approach = this.getApproachChords(targetChordX, techniqueId);
    const { step1, step2, step3, step4, twoChordCell, threeChordCell, fourChordCell } = approach;
    const isTwoFiveFamily = (
      techniqueId === 'standard_two_five' ||
      techniqueId === 'tritone_two_five' ||
      techniqueId === 'side_step_two_five' ||
      techniqueId === 'dorian_dark' ||
      techniqueId === 'gothic_dominant'
    );

    // =========================================================================
    // RULE 1: AUTO-ANCHORING HOME LANDMARKS
    // Measure 0 Beat 1 is automatically locked as ANCHOR unless mode === 'FULL_REFRAME'
    // or Measure 0 itself is Target X.
    // =========================================================================
    const isAnchorMeasure = (mIdx: number): boolean => {
      if (lockedSet.has(mIdx)) return true;
      if (mode !== 'FULL_REFRAME' && mIdx === 0 && targetMIdx !== 0) return true;
      return false;
    };

    const r1Idx = targetMIdx > 0 ? targetMIdx - 1 : numMeasures - 1;
    const r2Idx = targetMIdx > 1 ? targetMIdx - 2 : -1;
    const r3Idx = targetMIdx > 2 ? targetMIdx - 3 : -1;

    const r1LockedByUser = lockedSet.has(r1Idx);
    const r1IsProtectedHomeAnchor = mode !== 'FULL_REFRAME' && r1Idx === 0 && targetMIdx === 1;

    const canReplaceR1Full = !r1LockedByUser && !r1IsProtectedHomeAnchor && r1Idx !== targetMIdx;
    const canReplaceR2Full =
      canReplaceR1Full &&
      r2Idx >= 0 &&
      !isAnchorMeasure(r2Idx) &&
      mode !== 'HYBRID';
    const canReplaceR3Full =
      canReplaceR2Full &&
      r3Idx >= 0 &&
      !isAnchorMeasure(r3Idx) &&
      mode === 'FULL_REFRAME';

    // =========================================================================
    // CASE 1: 1 Single Measure Progression
    // =========================================================================
    if (numMeasures === 1) {
      if (!lockedSet.has(0) && measureBeatGrids[0].length >= 2) {
        const homeChord = measureBeatGrids[0][0].chord;
        if (mode === 'FULL_REFRAME') {
          this.fillBarBeats(measureBeatGrids[0], [homeChord, step2, step1], 'standard');
        } else {
          this.applyTurnaroundToFinalBar(
            measureBeatGrids[0],
            measures[0],
            homeChord,
            techniqueId,
            strategy === 'strategy2' ? 'beat4_pickup' : 'auto'
          );
        }
      }
      return this.compressBeatGrids(measureBeatGrids);
    }

    // =========================================================================
    // CASE 2: Target X is Measure 2 (r1Idx === 0, Home Anchor is immediately before Target X, e.g. 2-bar progression)
    // =========================================================================
    if (r1IsProtectedHomeAnchor && !r1LockedByUser) {
      // Keep Home Anchor on Beat 1 (and Beat 2) of Measure 0, insert approach to Target X on Beats 3-4
      const subMap: Record<string, 'beat4_pickup' | 'beats34_single' | 'beats34_two_chord' | 'beats234_walk'> = {
        strategy1: isTwoFiveFamily || density === 'DENSE' ? 'beats34_two_chord' : 'beats34_single',
        strategy2: 'beat4_pickup',
        strategy3: 'beats34_two_chord',
        strategy4: 'beats234_walk',
        strategy5: 'beats34_single',
        strategy6: 'beats34_two_chord',
        strategy7: 'beat4_pickup',
        strategy8: 'beats234_walk'
      };
      this.insertPassingIntoBar(
        measureBeatGrids[0],
        measures[0],
        targetChordX,
        techniqueId,
        subMap[strategy] || 'beats34_two_chord'
      );

      // On 2-bar loops, include turnaround in Bar 2 back to Bar 1 on turnaround strategies
      if (
        numMeasures === 2 &&
        canTurnaroundFinalBar &&
        (strategy === 'strategy1' || strategy === 'strategy6' || strategy === 'strategy8')
      ) {
        this.applyTurnaroundToFinalBar(
          measureBeatGrids[1],
          measures[1],
          loopDestinationChord,
          techniqueId,
          strategy === 'strategy6' ? 'beat4_pickup' : 'auto'
        );
      }
      return this.compressBeatGrids(measureBeatGrids);
    }

    // =========================================================================
    // CASE 3: Standard Runway Replacement (canReplaceR1Full is true)
    // =========================================================================
    if (canReplaceR1Full) {
      const barR1 = measureBeatGrids[r1Idx];
      const origR1Chord = barR1[0].chord;
      const singleStepCell =
        origR1Chord.toString() === step1.toString() ? twoChordCell : [step1];

      const applyOneBarRunway = (strat: string) => {
        if (density === 'SPARSE') {
          if (strat === 'strategy1') {
            this.fillBarBeats(barR1, isTwoFiveFamily ? twoChordCell : singleStepCell, 'standard');
          } else if (strat === 'strategy2') {
            this.fillBarBeats(barR1, singleStepCell, 'standard');
          } else if (strat === 'strategy3') {
            this.fillBarBeats(barR1, [origR1Chord, step1], 'standard');
          } else if (strat === 'strategy4') {
            this.fillBarBeats(barR1, [origR1Chord, step1], 'late');
          } else {
            this.fillBarBeats(barR1, twoChordCell, 'standard');
          }
          return;
        }

        if (density === 'DENSE') {
          if (strat === 'strategy1') {
            this.fillBarBeats(barR1, barR1.length === 3 ? threeChordCell : fourChordCell, 'standard');
          } else if (strat === 'strategy2') {
            this.fillBarBeats(barR1, threeChordCell, 'standard');
          } else {
            this.fillBarBeats(barR1, twoChordCell, 'standard');
          }
          return;
        }

        // Autonomous Curated Variations across Strategies:
        const prevBarChord = r2Idx >= 0 ? measureBeatGrids[r2Idx]?.[0]?.chord : null;
        const collidesWithPrevBarRoot =
          prevBarChord !== null &&
          twoChordCell.length >= 2 &&
          prevBarChord.root === twoChordCell[0].root &&
          origR1Chord.root !== targetChordX.root;

        if (strat === 'strategy1') {
          if (techniqueId === 'side_step_two_five') {
            this.fillBarBeats(barR1, fourChordCell, 'standard');
          } else if (isTwoFiveFamily && collidesWithPrevBarRoot && origR1Chord.root !== twoChordCell[0].root) {
            // Preserve distinct harmonic chord in barR1 on Beats 1-2 and place [ii, V] of Target X on Beats 3-4
            this.fillBarBeats(barR1, [origR1Chord, twoChordCell[0], twoChordCell[1]], 'standard');
          } else {
            this.fillBarBeats(
              barR1,
              isTwoFiveFamily || techniqueId === 'circle_of_fifths' ? twoChordCell : singleStepCell,
              'standard'
            );
          }
        } else if (strat === 'strategy3') {
          // Full-bar Cadence Approach in the bar before Target X
          this.fillBarBeats(
            barR1,
            techniqueId === 'side_step_two_five'
              ? fourChordCell
              : (isTwoFiveFamily || techniqueId === 'circle_of_fifths' ? twoChordCell : singleStepCell),
            'standard'
          );
        } else if (strat === 'strategy6') {
          // Half-Bar Hold + Approach on Beats 3-4 into Target X
          if (isTwoFiveFamily && r2Idx >= 0 && !lockedSet.has(r2Idx)) {
            this.insertPassingIntoBar(
              measureBeatGrids[r2Idx],
              measures[r2Idx],
              origR1Chord,
              techniqueId,
              'beats34_two_chord'
            );
          }
          this.fillBarBeats(
            barR1,
            isTwoFiveFamily ? [origR1Chord, twoChordCell[0], twoChordCell[1]] : [origR1Chord, step1],
            'standard'
          );
        } else if (strat === 'strategy7') {
          // Extended Approach into Target X
          if (techniqueId === 'side_step_two_five') {
            const ssBelowV = this.side_step_below(step1);
            const ssBelowII = this.side_step_below(step2);
            this.fillBarBeats(barR1, [ssBelowII, ssBelowV, step2, step1], 'standard');
          } else if (isTwoFiveFamily) {
            this.fillBarBeats(barR1, fourChordCell, 'standard');
          } else {
            this.fillBarBeats(barR1, threeChordCell, 'standard');
          }
        } else {
          // Strategy 8: Full Passing / Walk Momentum into Target X
          if (isTwoFiveFamily && origR1Chord.root !== twoChordCell[0].root) {
            this.fillBarBeats(barR1, [origR1Chord, twoChordCell[0], twoChordCell[1]], 'standard');
          } else {
            this.fillBarBeats(barR1, barR1.length === 3 ? threeChordCell : fourChordCell, 'standard');
          }
        }
      };

      const useThreeBarChain =
        canReplaceR3Full &&
        (strategy === 'strategy1' || strategy === 'strategy6' || strategy === 'strategy8');

      const useTwoBarChain =
        canReplaceR2Full &&
        (density === 'DENSE'
          ? (strategy !== 'strategy2' && strategy !== 'strategy3')
          : (strategy === 'strategy6' || strategy === 'strategy8'));

      if (useThreeBarChain && r3Idx >= 0 && r2Idx >= 0) {
        const barR3 = measureBeatGrids[r3Idx];
        const barR2 = measureBeatGrids[r2Idx];
        if (this.isDarkTechnique(techniqueId)) {
          return this.reharmonizeProgressionDarkWithLocks(measures, techniqueId, strategy, lockedSet, targetMIdx);
        }
        if (strategy === 'strategy1') {
          this.fillBarBeats(barR3, [step4], 'standard');
          this.fillBarBeats(barR2, [step3, step2], 'standard');
          this.fillBarBeats(barR1, [step2, step1], 'standard');
        } else if (strategy === 'strategy6') {
          this.fillBarBeats(barR3, [step4, step3], 'standard');
          this.fillBarBeats(barR2, [step3, step2], 'standard');
          this.fillBarBeats(barR1, [step1], 'standard');
        } else {
          this.fillBarBeats(barR3, [step4, step3], 'standard');
          this.fillBarBeats(barR2, [step2], 'standard');
          this.fillBarBeats(barR1, twoChordCell, 'standard');
        }
      } else if (useTwoBarChain && r2Idx >= 0) {
        const barR2 = measureBeatGrids[r2Idx];
        const origR2Chord = barR2[0].chord;
        if (strategy === 'strategy6') {
          this.fillBarBeats(barR2, [origR2Chord, isTwoFiveFamily ? step3 : step2], 'standard');
          this.fillBarBeats(barR1, isTwoFiveFamily ? [step2, step1] : [step1], 'standard');
        } else {
          this.fillBarBeats(barR2, [step4, step3], 'standard');
          this.fillBarBeats(barR1, [step2, step1], 'standard');
        }
      } else {
        // 1-Bar Runway in r1Idx (all earlier bars keep their own original chords!)
        applyOneBarRunway(strategy);
      }
    }

    // =========================================================================
    // RULE 3: AUTONOMOUS PASSING CHORDS ON STATIC HELD BARS
    // Automatically subdivides static held internal measures on Beats 3 & 4
    // =========================================================================
    if (mode === 'HYBRID') {
      for (let mIdx = 0; mIdx < numMeasures - 1; mIdx++) {
        if (mIdx === targetMIdx || mIdx === r1Idx || lockedSet.has(mIdx)) continue;

        const nextMIdx = mIdx + 1;
        const nextChord = measureBeatGrids[nextMIdx]?.[0]?.chord;
        const curChord = measureBeatGrids[mIdx]?.[0]?.chord;
        if (!nextChord || !curChord) continue;

        const isSingleHeldBar = measures[mIdx].length === 1;
        const isStaticRepeatBar =
          isSingleHeldBar &&
          measures[nextMIdx]?.length === 1 &&
          measures[mIdx][0].chord === measures[nextMIdx][0].chord;

        let shouldInsert = false;
        if (nextChord.quality === 'm7b5' || nextChord.quality === '°7') {
          shouldInsert = false;
        } else if (isStaticRepeatBar) {
          shouldInsert = strategy === 'strategy7' || strategy === 'strategy8';
        } else if (isTwoFiveFamily) {
          shouldInsert = strategy === 'strategy8';
        } else if (mIdx > 0) {
          shouldInsert = strategy === 'strategy7' || strategy === 'strategy8';
        }

        if (shouldInsert) {
          const hybridSubStyle: 'beat4_pickup' | 'beats34_single' | 'beats34_two_chord' =
            isTwoFiveFamily
              ? 'beats34_two_chord'
              : density === 'SPARSE'
                ? 'beat4_pickup'
                : density === 'DENSE'
                  ? 'beats34_two_chord'
                  : (strategy === 'strategy8' ? 'beats34_single' : 'beat4_pickup');

          this.insertPassingIntoBar(
            measureBeatGrids[mIdx],
            measures[mIdx],
            nextChord,
            techniqueId,
            hybridSubStyle
          );
        }
      }
    }

    // =========================================================================
    // RULE 4: AUTONOMOUS TURNAROUND / TURN-BACK ENGINE ON FINAL MEASURE
    // Treats Bar 1, Beat 1 (loopDestinationChord) as implicit Target X for the end of the phrase
    // on Turnaround strategies (strategy1, strategy6, strategy8).
    // (Note: strategy2 & strategy5 already returned Pure Loop Turnarounds above,
    //  while strategy3, strategy4, strategy7 keep the ending as-is.)
    // =========================================================================
    if (
      canTurnaroundFinalBar &&
      (strategy === 'strategy1' || strategy === 'strategy6' || strategy === 'strategy8')
    ) {
      const turnStyle = strategy === 'strategy6' ? 'two_chord' : 'auto';
      this.applyTurnaroundToFinalBar(
        measureBeatGrids[finalMIdx],
        measures[finalMIdx],
        loopDestinationChord,
        techniqueId,
        turnStyle
      );
    }

    return this.compressBeatGrids(measureBeatGrids);
  }

  static compressBeatGrids(measureBeatGrids: BeatSlot[][]): ChordBeatItem[][] {
    return measureBeatGrids.map(grid => {
      const compressed: ChordBeatItem[] = [];
      grid.forEach(slot => {
        const sym = slot.chord.toString();
        if (compressed.length > 0 && compressed[compressed.length - 1].chord === sym) {
          compressed[compressed.length - 1].beats += 1;
          if (slot.isTurnaround) {
            compressed[compressed.length - 1].isTurnaround = true;
          }
        } else {
          compressed.push({
            chord: sym,
            beats: 1,
            ...(slot.isTurnaround ? { isTurnaround: true } : {})
          });
        }
      });
      return compressed;
    });
  }

  // ============================================================================
  // DARK REHARMONIZATION ENGINE (STRICTLY MUTUALLY EXCLUSIVE PALETTES)
  // ============================================================================
  static isDarkTechnique(techniqueId: string): boolean {
    return (
      techniqueId === 'dorian_dark' ||
      techniqueId === 'chromatic_mediant' ||
      techniqueId === 'gothic_dominant' ||
      techniqueId === 'neapolitan_slide' ||
      techniqueId === 'diminished_axis' ||
      techniqueId === 'elfman_modulation'
    );
  }

  static buildDarkPalette(rootNote: string) {
    const R = rootNote;
    const i       = new Chord(R, 'm', null, false);
    const i6      = new Chord(R, 'm6', null, false);
    const imMaj7  = new Chord(R, 'm(maj7)', null, false);
    const im7     = new Chord(R, 'm7', null, false);

    // Dorian raised-6th chords (IV, IV7, ii7)
    const IV      = new Chord(this.transpose(R, 5, false), 'maj', null, false);
    const IV7     = new Chord(this.transpose(R, 5, false), '7', null, false);
    const ii7     = new Chord(this.transpose(R, 2, false), 'm7', null, false);

    // Chromatic Mediants (minor & major 3rd shifts: bvi, biii, bVI, bVI+)
    const bvi     = new Chord(this.transpose(R, 8, false), 'm', null, false);
    const bvi6    = new Chord(this.transpose(R, 8, false), 'm6', null, false);
    const biii    = new Chord(this.transpose(R, 3, false), 'm', null, false);
    const biiiMaj = new Chord(this.transpose(R, 3, false), 'm(maj7)', null, false);
    const bVI     = new Chord(this.transpose(R, 8, false), 'maj', null, false);
    const bVIaug  = new Chord(this.transpose(R, 8, false), '+', null, false);

    // Harmonic minor & altered / augmented dominants
    const iiHalf  = new Chord(this.transpose(R, 2, false), 'm7b5', null, false);
    const ivMin6  = new Chord(this.transpose(R, 5, false), 'm6', null, false);
    const V7b9    = new Chord(this.transpose(R, 7, true), '7(b9)', null, true);
    const V7aug   = new Chord(this.transpose(R, 7, true), '7+', null, true);
    const Vaug    = new Chord(this.transpose(R, 7, true), '+', null, true);

    // Phrygian / Neapolitan & Diminished / Tritone axis
    const bII     = new Chord(this.transpose(R, 1, false), 'maj', null, false);
    const biim    = new Chord(this.transpose(R, 1, false), 'm', null, false);
    const bII7    = new Chord(this.transpose(R, 1, false), '7', null, false);
    const viiDim7 = new Chord(this.transpose(R, 11, true), '°7', null, true);
    const sh1Dim7 = new Chord(this.transpose(R, 1, true), '°7', null, true);
    const sh4Dim7 = new Chord(this.transpose(R, 6, true), '°7', null, true);
    const tritMin = new Chord(this.transpose(R, 6, true), 'm', null, true);

    return {
      i, i6, imMaj7, im7,
      IV, IV7, ii7,
      bvi, bvi6, biii, biiiMaj, bVI, bVIaug,
      iiHalf, ivMin6, V7b9, V7aug, Vaug,
      bII, biim, bII7, viiDim7, sh1Dim7, sh4Dim7, tritMin
    };
  }

  static fillDarkTargetBar(targetGrid: BeatSlot[], H: string, techniqueId: string, strategy: string) {
    const firstTarget = targetGrid[0].chord;
    const palH = this.buildDarkPalette(H);
    const palT = this.buildDarkPalette(firstTarget.root);

    switch (techniqueId) {
      case 'dorian_dark': {
        const choices: Record<string, Chord[]> = {
          strategy1: [palT.i6],
          strategy2: [palH.IV7, palT.i6],
          strategy3: [palT.i6, palT.IV],
          strategy4: [palT.ii7, palT.IV7],
          strategy5: [palT.im7, palT.i6],
          strategy6: [palH.ii7, palT.i6],
          strategy7: [palT.IV, palT.i6],
          strategy8: [palT.i, palT.ii7, palT.i6]
        };
        this.fillBarBeats(targetGrid, choices[strategy] || choices.strategy1, 'standard');
        return;
      }

      case 'chromatic_mediant': {
        const choices: Record<string, Chord[]> = {
          strategy1: [palH.bvi],
          strategy2: [palH.biii, palH.i],
          strategy3: [palH.bvi6, palT.i],
          strategy4: [palH.bVI, palH.bvi],
          strategy5: [palT.bvi, palT.i],
          strategy6: [palH.biiiMaj],
          strategy7: [palH.bvi, palH.biii],
          strategy8: [palH.bVIaug, palH.bvi]
        };
        this.fillBarBeats(targetGrid, choices[strategy] || choices.strategy1, 'standard');
        return;
      }

      case 'gothic_dominant': {
        const choices: Record<string, Chord[]> = {
          strategy1: [palH.V7b9, palH.i],
          strategy2: [palH.V7aug, palH.imMaj7],
          strategy3: [palH.iiHalf, palH.V7b9],
          strategy4: [palH.bVIaug, palH.V7b9],
          strategy5: [palH.V7b9, palH.V7aug],
          strategy6: [palT.imMaj7],
          strategy7: [palH.ivMin6, palH.V7b9],
          strategy8: [palH.iiHalf, palH.V7aug, palH.i]
        };
        this.fillBarBeats(targetGrid, choices[strategy] || choices.strategy1, 'standard');
        return;
      }

      case 'neapolitan_slide': {
        const choices: Record<string, Chord[]> = {
          strategy1: [palH.bII, palH.i],
          strategy2: [palH.bII7, palH.i6],
          strategy3: [palH.biim, palH.i],
          strategy4: [palT.bII, palT.i],
          strategy5: [palH.bII, palH.bII7],
          strategy6: [palH.i, palH.bII],
          strategy7: [palH.biim, palH.bII7, palH.i],
          strategy8: [palT.bII7, palT.i]
        };
        this.fillBarBeats(targetGrid, choices[strategy] || choices.strategy1, 'standard');
        return;
      }

      case 'diminished_axis': {
        const choices: Record<string, Chord[]> = {
          strategy1: [palH.viiDim7, palH.i],
          strategy2: [palH.sh4Dim7, palH.Vaug],
          strategy3: [palH.sh1Dim7, palH.i6],
          strategy4: [palH.tritMin, palH.viiDim7],
          strategy5: [palH.Vaug, palH.viiDim7],
          strategy6: [palH.sh4Dim7, palH.viiDim7, palH.i],
          strategy7: [palT.viiDim7, palT.i],
          strategy8: [palH.sh1Dim7, palH.sh4Dim7, palH.viiDim7]
        };
        this.fillBarBeats(targetGrid, choices[strategy] || choices.strategy1, 'standard');
        return;
      }

      case 'elfman_modulation':
      default: {
        const modSemis = (strategy === 'strategy2' || strategy === 'strategy6') ? 8
          : (strategy === 'strategy3' || strategy === 'strategy7') ? 1
          : 3;
        const modRoot = this.transpose(H, modSemis, false);
        const palMod = this.buildDarkPalette(modRoot);
        if (strategy === 'strategy1' || strategy === 'strategy4') {
          this.fillBarBeats(targetGrid, [palMod.i, palMod.imMaj7, palMod.i6], 'standard');
        } else if (strategy === 'strategy2' || strategy === 'strategy5') {
          this.fillBarBeats(targetGrid, [palMod.imMaj7, palMod.im7, palMod.i6], 'standard');
        } else {
          this.fillBarBeats(targetGrid, [palMod.i, palMod.imMaj7], 'standard');
        }
      }
    }
  }

  static reharmonizeProgressionDark(
    measures: ChordBeatItem[][],
    techniqueId = 'dorian_dark',
    strategy = 'strategy1'
  ): ChordBeatItem[][] {
    return this.reharmonizeProgressionDarkWithLocks(
      measures,
      techniqueId,
      strategy,
      new Set<number>(),
      Math.max(0, (measures?.length || 1) - 1)
    );
  }

  static reharmonizeProgressionDarkWithLocks(
    measures: ChordBeatItem[][],
    techniqueId = 'dorian_dark',
    strategy = 'strategy1',
    lockedSet: Set<number> = new Set<number>(),
    explicitTargetMIdx?: number
  ): ChordBeatItem[][] {
    if (!measures || measures.length === 0) return [];

    const measureBeatGrids: BeatSlot[][] = measures.map(meas => {
      const beats: BeatSlot[] = [];
      meas.forEach(item => {
        const cObj = Chord.fromSymbol(item.chord);
        for (let b = 0; b < item.beats; b++) {
          beats.push({ chord: cObj, isAttack: b === 0 });
        }
      });
      return beats;
    });

    const numMeasures = measureBeatGrids.length;
    const targetMIdx =
      explicitTargetMIdx !== undefined && explicitTargetMIdx >= 0 && explicitTargetMIdx < numMeasures
        ? explicitTargetMIdx
        : numMeasures - 1;
    const H = measureBeatGrids[0][0].chord.root;
    const pal = this.buildDarkPalette(H);

    let bar0Choices: Record<string, Chord[]>;
    let bar1Choices: Record<string, Chord[]>;
    let bar2Choices: Record<string, Chord[]>;

    switch (techniqueId) {
      case 'dorian_dark': {
        // Strictly Dorian Minor: i, im6, im7, ii7, IV, IV7
        bar0Choices = {
          strategy1: [pal.i],
          strategy2: [pal.i6],
          strategy3: [pal.i, pal.IV],
          strategy4: [pal.im7],
          strategy5: [pal.i, pal.ii7, pal.i6],
          strategy6: [pal.i6, pal.ii7],
          strategy7: [pal.im7, pal.IV7],
          strategy8: [pal.i, pal.i6]
        };
        bar1Choices = {
          strategy1: [pal.IV],
          strategy2: [pal.i6, pal.IV7],
          strategy3: [pal.ii7],
          strategy4: [pal.ii7, pal.IV7],
          strategy5: [pal.IV7],
          strategy6: [pal.i6],
          strategy7: [pal.i, pal.ii7],
          strategy8: [pal.IV, pal.IV7]
        };
        bar2Choices = {
          strategy1: [pal.i6, pal.IV7],
          strategy2: [pal.IV, pal.ii7],
          strategy3: [pal.im7, pal.IV7],
          strategy4: [pal.i, pal.ii7, pal.IV],
          strategy5: [pal.ii7, pal.IV],
          strategy6: [pal.IV7, pal.ii7],
          strategy7: [pal.i6, pal.IV],
          strategy8: [pal.im7, pal.ii7, pal.IV7]
        };
        break;
      }

      case 'chromatic_mediant': {
        // Strictly Chromatic Mediants: i, i6, bvi, bvi6, biii, bVI, bVI+
        bar0Choices = {
          strategy1: [pal.i],
          strategy2: [pal.i6],
          strategy3: [pal.i, pal.bvi],
          strategy4: [pal.i, pal.biii],
          strategy5: [pal.i6, pal.bvi6],
          strategy6: [pal.i, pal.bVI],
          strategy7: [pal.biii, pal.i],
          strategy8: [pal.bvi, pal.i6]
        };
        bar1Choices = {
          strategy1: [pal.bvi],
          strategy2: [pal.biii],
          strategy3: [pal.biii, pal.bvi],
          strategy4: [pal.bvi6],
          strategy5: [pal.bVI, pal.bvi],
          strategy6: [pal.biiiMaj],
          strategy7: [pal.bvi, pal.bVIaug],
          strategy8: [pal.biii, pal.bvi6]
        };
        bar2Choices = {
          strategy1: [pal.biii, pal.bVI],
          strategy2: [pal.bvi, pal.biii],
          strategy3: [pal.bvi6, pal.bVIaug],
          strategy4: [pal.biii, pal.bvi, pal.bVI],
          strategy5: [pal.i6, pal.bvi],
          strategy6: [pal.bVI, pal.biii],
          strategy7: [pal.bvi, pal.bVI],
          strategy8: [pal.bVIaug, pal.biii]
        };
        break;
      }

      case 'gothic_dominant': {
        // Strictly Harmonic Minor & Altered Gothic Cadences: i, im(maj7), ivm6, iiø, bVI+, V7(b9), V7+
        bar0Choices = {
          strategy1: [pal.imMaj7],
          strategy2: [pal.i, pal.imMaj7],
          strategy3: [pal.i],
          strategy4: [pal.i, pal.ivMin6],
          strategy5: [pal.imMaj7, pal.ivMin6],
          strategy6: [pal.i, pal.iiHalf],
          strategy7: [pal.i, pal.bVIaug],
          strategy8: [pal.ivMin6, pal.imMaj7]
        };
        bar1Choices = {
          strategy1: [pal.ivMin6],
          strategy2: [pal.iiHalf],
          strategy3: [pal.ivMin6, pal.iiHalf],
          strategy4: [pal.iiHalf, pal.V7b9],
          strategy5: [pal.bVIaug],
          strategy6: [pal.ivMin6, pal.V7aug],
          strategy7: [pal.bVIaug, pal.iiHalf],
          strategy8: [pal.V7b9, pal.ivMin6]
        };
        bar2Choices = {
          strategy1: [pal.iiHalf, pal.V7b9],
          strategy2: [pal.V7aug, pal.V7b9],
          strategy3: [pal.ivMin6, pal.iiHalf, pal.V7aug],
          strategy4: [pal.imMaj7, pal.V7b9],
          strategy5: [pal.bVIaug, pal.V7b9],
          strategy6: [pal.iiHalf, pal.V7aug],
          strategy7: [pal.ivMin6, pal.V7b9],
          strategy8: [pal.bVIaug, pal.iiHalf, pal.V7b9]
        };
        break;
      }

      case 'neapolitan_slide': {
        // Strictly Phrygian / Neapolitan half-step motion: i, i6, bII, biim, bII7
        bar0Choices = {
          strategy1: [pal.i],
          strategy2: [pal.i, pal.bII],
          strategy3: [pal.i6],
          strategy4: [pal.i, pal.biim],
          strategy5: [pal.i, pal.bII7],
          strategy6: [pal.i6, pal.bII],
          strategy7: [pal.biim, pal.i],
          strategy8: [pal.bII, pal.i]
        };
        bar1Choices = {
          strategy1: [pal.bII],
          strategy2: [pal.biim],
          strategy3: [pal.bII, pal.biim],
          strategy4: [pal.i6, pal.bII],
          strategy5: [pal.biim, pal.bII7],
          strategy6: [pal.bII7],
          strategy7: [pal.bII, pal.i6],
          strategy8: [pal.i, pal.biim]
        };
        bar2Choices = {
          strategy1: [pal.biim, pal.bII7],
          strategy2: [pal.bII, pal.bII7],
          strategy3: [pal.i6, pal.bII7],
          strategy4: [pal.i, pal.bII, pal.bII7],
          strategy5: [pal.bII, pal.biim],
          strategy6: [pal.biim, pal.bII],
          strategy7: [pal.i6, pal.biim, pal.bII7],
          strategy8: [pal.bII7, pal.bII]
        };
        break;
      }

      case 'diminished_axis': {
        // Strictly Diminished 7th & Tritone/Augmented Axis: i, #i°7, #iv°7, vii°7, V+, tritMin
        bar0Choices = {
          strategy1: [pal.i],
          strategy2: [pal.i, pal.viiDim7],
          strategy3: [pal.i, pal.sh1Dim7],
          strategy4: [pal.i, pal.sh4Dim7],
          strategy5: [pal.i, pal.Vaug],
          strategy6: [pal.sh1Dim7, pal.i],
          strategy7: [pal.i, pal.tritMin],
          strategy8: [pal.viiDim7, pal.i]
        };
        bar1Choices = {
          strategy1: [pal.sh1Dim7],
          strategy2: [pal.sh4Dim7],
          strategy3: [pal.viiDim7],
          strategy4: [pal.tritMin],
          strategy5: [pal.sh1Dim7, pal.sh4Dim7],
          strategy6: [pal.sh4Dim7, pal.Vaug],
          strategy7: [pal.viiDim7, pal.tritMin],
          strategy8: [pal.Vaug, pal.sh4Dim7]
        };
        bar2Choices = {
          strategy1: [pal.sh4Dim7, pal.viiDim7],
          strategy2: [pal.sh1Dim7, pal.viiDim7],
          strategy3: [pal.sh4Dim7, pal.Vaug],
          strategy4: [pal.sh1Dim7, pal.sh4Dim7, pal.viiDim7],
          strategy5: [pal.tritMin, pal.viiDim7],
          strategy6: [pal.Vaug, pal.viiDim7],
          strategy7: [pal.sh1Dim7, pal.tritMin, pal.viiDim7],
          strategy8: [pal.viiDim7, pal.Vaug]
        };
        break;
      }

      case 'elfman_modulation':
      default: {
        // Strictly Restless Key Modulations & Minor Line Cliché (m -> m(maj7) -> m7 -> m6)
        const modUp3   = this.buildDarkPalette(this.transpose(H, 3, false));
        const modDown4 = this.buildDarkPalette(this.transpose(H, 8, false));
        const modUp1   = this.buildDarkPalette(this.transpose(H, 1, false));
        const modTrit  = this.buildDarkPalette(this.transpose(H, 6, true));

        bar0Choices = {
          strategy1: [pal.i, pal.imMaj7],
          strategy2: [pal.imMaj7, pal.im7],
          strategy3: [pal.i, pal.imMaj7, pal.im7, pal.i6],
          strategy4: [pal.i, pal.i6],
          strategy5: [pal.imMaj7],
          strategy6: [pal.i, pal.imMaj7, pal.i6],
          strategy7: [pal.i],
          strategy8: [pal.im7, pal.i6]
        };
        bar1Choices = {
          strategy1: [modUp3.i, modUp3.imMaj7],
          strategy2: [modDown4.i, modDown4.imMaj7],
          strategy3: [modUp1.i, modUp1.i6],
          strategy4: [modUp3.imMaj7, modUp3.i6],
          strategy5: [modTrit.i, modTrit.imMaj7],
          strategy6: [modDown4.imMaj7, modDown4.i6],
          strategy7: [modUp1.imMaj7, modUp1.im7],
          strategy8: [modTrit.i6]
        };
        bar2Choices = {
          strategy1: [modDown4.i, modUp3.imMaj7],
          strategy2: [modUp3.i6, modDown4.imMaj7],
          strategy3: [modUp1.i, modUp3.i6],
          strategy4: [modTrit.i, modUp3.imMaj7],
          strategy5: [modUp3.i, modUp3.imMaj7, modUp3.i6],
          strategy6: [modDown4.i, modDown4.imMaj7, modDown4.i6],
          strategy7: [modUp3.i, modUp1.imMaj7],
          strategy8: [modTrit.imMaj7, modUp3.i6]
        };
        break;
      }
    }

    const b0Seq = bar0Choices[strategy] || bar0Choices.strategy1;
    const b1Seq = bar1Choices[strategy] || bar1Choices.strategy1;
    const b2Seq = bar2Choices[strategy] || bar2Choices.strategy1;

    if (targetMIdx >= 3) {
      if (!lockedSet.has(targetMIdx - 3)) this.fillBarBeats(measureBeatGrids[targetMIdx - 3], b0Seq, 'standard');
      if (!lockedSet.has(targetMIdx - 2)) this.fillBarBeats(measureBeatGrids[targetMIdx - 2], b1Seq, 'standard');
      if (!lockedSet.has(targetMIdx - 1)) this.fillBarBeats(measureBeatGrids[targetMIdx - 1], b2Seq, 'standard');
      if (!lockedSet.has(targetMIdx)) this.fillDarkTargetBar(measureBeatGrids[targetMIdx], H, techniqueId, strategy);
    } else if (targetMIdx === 2) {
      if (!lockedSet.has(0)) this.fillBarBeats(measureBeatGrids[0], b0Seq, 'standard');
      if (!lockedSet.has(1)) this.fillBarBeats(measureBeatGrids[1], b2Seq, 'standard');
      if (!lockedSet.has(2)) this.fillDarkTargetBar(measureBeatGrids[2], H, techniqueId, strategy);
    } else if (targetMIdx === 1) {
      const combinedBar0 = b0Seq.length === 1 && b1Seq.length >= 1
        ? [b0Seq[0], b1Seq[0], ...(b2Seq.slice(-1))]
        : b2Seq;
      if (!lockedSet.has(0)) this.fillBarBeats(measureBeatGrids[0], combinedBar0, 'standard');
      if (!lockedSet.has(1)) this.fillDarkTargetBar(measureBeatGrids[1], H, techniqueId, strategy);
    } else {
      if (!lockedSet.has(0)) this.fillBarBeats(measureBeatGrids[0], [b0Seq[0], ...b2Seq.slice(-2)], 'standard');
    }

    const finalIdx = numMeasures - 1;
    if (
      !lockedSet.has(finalIdx) &&
      measureBeatGrids[finalIdx] &&
      measureBeatGrids[finalIdx].length >= 2 &&
      (strategy === 'strategy1' || strategy === 'strategy2' || strategy === 'strategy6' || strategy === 'strategy8')
    ) {
      const fGrid = measureBeatGrids[finalIdx];
      fGrid[fGrid.length - 1].isTurnaround = true;
    }

    return this.compressBeatGrids(measureBeatGrids);
  }

  static executeSinglePhraseReharm(
    measures: ChordBeatItem[][],
    techniqueId: string,
    strategy: string,
    options: ReharmExecutionOptions = {}
  ): ChordBeatItem[][] {
    if (!techniqueId || techniqueId === 'default') {
      return measures.map(m => m.map(c => ({ ...c })));
    }
    const mode: ReharmMode = options.mode || 'APPROACH_TARGETING';
    if (mode === 'FULL_REFRAME' && this.isDarkTechnique(techniqueId)) {
      const lockedSet = new Set(options.lockedMeasures || []);
      const targetMIdx = this.resolveTargetMeasureIndex(measures.length, options.targetIndex);
      return this.reharmonizeProgressionDarkWithLocks(measures, techniqueId, strategy, lockedSet, targetMIdx);
    }
    return this.reharmonizeProgressionBackward(measures, techniqueId, strategy, options);
  }

  static executeReharm(
    measures: ChordBeatItem[][],
    techniqueId: string,
    strategy: string,
    options: ReharmExecutionOptions = {}
  ): ChordBeatItem[][] {
    if (!measures || measures.length === 0) return [];
    if (!techniqueId || techniqueId === 'default') {
      return measures.map(m => m.map(c => ({ ...c })));
    }

    const hasExplicitTarget =
      options.targetIndex !== undefined &&
      options.targetIndex !== null &&
      options.targetIndex >= 0 &&
      options.targetIndex < measures.length;

    if (!hasExplicitTarget && measures.length > 4) {
      let splitIdx = Math.ceil(measures.length / 2);
      if (measures.length === 9) {
        splitIdx = 3;
      } else if (measures.length % 4 === 0) {
        splitIdx = 4;
      } else if (measures.length > 8) {
        splitIdx = 4;
      }

      const locked = options.lockedMeasures || [];
      const firstLocks = locked.filter(m => m < splitIdx);
      const restLocks = locked.filter(m => m >= splitIdx).map(m => m - splitIdx);
      const rootHomeChord = options.loopTargetChord || Chord.fromSymbol(measures[0][0].chord);

      const firstPart = this.executeReharm(
        measures.slice(0, splitIdx),
        techniqueId,
        strategy,
        {
          ...options,
          targetIndex: null,
          lockedMeasures: firstLocks,
          disableTurnaround: true
        }
      );
      const restPart = this.executeReharm(
        measures.slice(splitIdx),
        techniqueId,
        strategy,
        {
          ...options,
          targetIndex: null,
          lockedMeasures: restLocks,
          loopTargetChord: rootHomeChord
        }
      );
      return [...firstPart, ...restPart];
    }
    return this.executeSinglePhraseReharm(measures, techniqueId, strategy, options);
  }

  static executeReharmRequest(request: ReharmRequest): ChordSlot[] {
    const measures = this.slotsToMeasures(request.progression);
    const lockedMeasures: number[] = [];
    request.progression.forEach(s => {
      if (s.isUserFixed) {
        const mIdx = Math.max(0, s.measure - 1);
        if (!lockedMeasures.includes(mIdx)) lockedMeasures.push(mIdx);
      }
    });
    const outMeasures = this.executeReharm(
      measures,
      request.techniqueId || 'standard_two_five',
      request.strategy || 'strategy1',
      {
        mode: request.mode,
        density: request.density,
        targetIndex: request.targetIndex ?? null,
        lockedMeasures,
        meter: request.meter
      }
    );
    return this.parseProgressionToSlots(outMeasures, {
      mode: request.mode,
      density: request.density,
      targetIndex: request.targetIndex ?? null,
      lockedMeasures,
      meter: request.meter
    });
  }
}

const LEGACY_JAZZ_FROM_BASIC = [
  "Dm7 | G7 | Cmaj7 | Cmaj7",
  "Gm7(b5) | C7alt | Fm7 | Fm7",
  "Bbmaj7 | Gm7 | Cm7 | F7",
  "F7 | Bb7 | Ebmaj7 | Ebmaj7",
  "Am7 | Ab7 | Gmaj7 | Gmaj7",
  "Em7 | A7 | Dm7 | G7",
  "Bbmaj7 | Ebmaj7",
  "Abmaj7 | Abm7 | Ebmaj7 | Ebmaj7",
  "Cmaj7 | D7 | Dm7 | G7",
  "Fmaj7 | A7 | Dm7 | Dm7",
  "Bb7 | Eb7 | Bb7 | Bb7 | Eb7 | Eb7 | Bb7 | G7 | Cm7 | F7 | Bb7 | F7",
  "Fmaj7 | Em7(b5) | A7 | Dm7 | G7 | Cm7 | F7 | Bbmaj7 | Bbm7 | Eb7 | Am7 | D7 | Gm7 | C7 | Fmaj7 | D7 | Gm7 | C7",
  "Cmaj7 | Am7 | Dm7 | G7 | Em7 | A7 | Dm7 | G7 | Gm7 | C7 | Fmaj7 | Fm7 | Em7 | A7 | Dm7 | G7",
  "Cm7 | F7 | Gmaj7 | Gmaj7",
  "Am7 | G7 | F7 | E7",
  "Gm | Gm(maj7) | Gm7 | Gm6",
  "Cmaj7 | Eb7 | Abmaj7 | B7 | Emaj7 | G7 | Cmaj7 | Cmaj7",
  "Dm7 | G7 | Cmaj7 | Cm7 | F7 | Bbmaj7 | Bbm7 | Eb7 | Abmaj7 | Abmaj7",
  "Dm7 | Em7",
  "Fmaj7 | F#dim7 | Gm7 | G#dim7 | Am7 | Am7"
];

const DEFAULT_BASIC_PROGRESSIONS = [
  "C | Am | Dm | G",
  "C | G | Am | F",
  "C | F | G | G",
  "C | F | C | G",
  "F | C | G | Am",
  "Am | F | C | G",
  "G | Am | F | C",
  "C | Em | Am | F",
  "C | G | F | C",
  "F | C",
  "Bb | F | C | C",
  "C | G/B | Am | F",
  "C | Bb | F/A | Ab",
  "C | Em7 | F | D7/F#",
  "C7 | G7 | F7 | C7",
  "C7 | F7 | C7 | G7 | F7 | C7",
  "C7 | C7 | C7 | C7 | F7 | F7 | C7 | C7 | G7 | F7 | C7 | G7",
  "C | Dm | Em | F | G | Am | Bdim | Bdim",
  "C | Dm | Em | F | G7 | Am",
  "Cm | Ddim | Eb | Fm | Gm | Ab | Bb | Bb"
];

const DEFAULT_JAZZ_PROGRESSIONS = [
  "Dm7 | G7 | Cmaj7 | Cmaj7",
  "Dm7b5 | G7 | Cm7 | Cm7",
  "Gm7(b5) | C7alt | Fm7 | Fm7",
  "C | Am7 | Dm7 | G7",
  "Bbmaj7 | Gm7 | Cm7 | F7",
  "Em7 | A7 | Dm7 | G7",
  "E7 | A7 | D7 | G7",
  "Cmaj7 | Ebmaj7 | Abmaj7 | Dbmaj7",
  "Fmaj7 | Em7 | Am7 | G7",
  "Am7 | Dm7 | G9 | Cmaj7",
  "Cmaj7 | Bb7 | Fmaj7 | Fm7",
  "Bb7 | Cmaj7",
  "Cmaj7 | Fmaj7",
  "Bbmaj7 | Ebmaj7",
  "F7 | Bb7 | Ebmaj7 | Ebmaj7",
  "Am7 | Ab7 | Gmaj7 | Gmaj7",
  "Abmaj7 | Abm7 | Ebmaj7 | Ebmaj7",
  "Cmaj7 | D7 | Dm7 | G7",
  "Fmaj7 | A7 | Dm7 | Dm7",
  "Cm7 | F7 | Gmaj7 | Gmaj7",
  "Am7 | G7 | F7 | E7",
  "Gm | Gm(maj7) | Gm7 | Gm6",
  "Dm7 | Em7",
  "Fmaj7 | F#dim7 | Gm7 | G#dim7 | Am7 | Am7",
  "Cmaj7 | Eb7 | Abmaj7 | B7 | Emaj7 | G7 | Cmaj7 | Cmaj7",
  "Dm7 | G7 | Cmaj7 | Cm7 | F7 | Bbmaj7 | Bbm7 | Eb7 | Abmaj7 | Abmaj7",
  "Bb7 | Eb7 | Bb7 | Bb7 | Eb7 | Eb7 | Bb7 | G7 | Cm7 | F7 | Bb7 | F7",
  "Fmaj7 | Em7(b5) | A7 | Dm7 | G7 | Cm7 | F7 | Bbmaj7 | Bbm7 | Eb7 | Am7 | D7 | Gm7 | C7 | Fmaj7 | D7 | Gm7 | C7",
  "Cmaj7 | Am7 | Dm7 | G7 | Em7 | A7 | Dm7 | G7 | Gm7 | C7 | Fmaj7 | Fm7 | Em7 | A7 | Dm7 | G7"
];

const DEFAULT_SAVED_PROGRESSIONS = [
  "Em | F | Em | Em",
  "Em | F | B7 | C",
  "B7 | Em | F/A | B | C | B",
  "Cm | Ebm | Cm | Cm",
  "Cm | Abm | Cm | Cm",
  "Cm | Dm7b5/C | Em | Fm | G7 | G7",
  "Gm | Bbm | Abm | Em | Bm | Gm | Bm | Gm",
  "Dm | Fm | C | Ebm | G | Em | C#m | C#m",
  "Cm | Ebm | F | Bbm",
  "Cm | F | Cm | Cm",
  "Cm | Dm | Cm | Cm",
  "Dm | Dbm | C | Bbm | Am | A7",
  "Cm | Ab | Fm | G",
  "C | Em | C | Em",
  "Dm | Dm(maj7) | Dm7 | Dm6 | C#°7 | C#°7",
  "Cm | Eb+ | Fm | G",
  "Dm | G#"
];

const DEFAULT_PROGRESSIONS = [
  ...DEFAULT_JAZZ_PROGRESSIONS,
  ...DEFAULT_BASIC_PROGRESSIONS
];

// Maps only legacy odd-measure default progressions to their even-measure versions
// so existing browser vaults upgrade built-in defaults while leaving user-added progressions untouched.
const LEGACY_DEFAULT_ODD_TO_EVEN_MAP: Record<string, string> = {
  "Dm7 | G7 | Cmaj7": "Dm7 | G7 | Cmaj7 | Cmaj7",
  "Gm7(b5) | C7alt | Fm7": "Gm7(b5) | C7alt | Fm7 | Fm7",
  "F7 | Bb7 | Ebmaj7": "F7 | Bb7 | Ebmaj7 | Ebmaj7",
  "Am7 | Ab7 | Gmaj7": "Am7 | Ab7 | Gmaj7 | Gmaj7",
  "Abmaj7 | Abm7 | Ebmaj7": "Abmaj7 | Abm7 | Ebmaj7 | Ebmaj7",
  "Fmaj7 | A7 | Dm7": "Fmaj7 | A7 | Dm7 | Dm7",
  "Cm7 | F7 | Gmaj7": "Cm7 | F7 | Gmaj7 | Gmaj7",
  "Cmaj7 | Eb7 | Abmaj7 | B7 | Emaj7 | G7 | Cmaj7": "Cmaj7 | Eb7 | Abmaj7 | B7 | Emaj7 | G7 | Cmaj7 | Cmaj7",
  "Dm7 | G7 | Cmaj7 | Cm7 | F7 | Bbmaj7 | Bbm7 | Eb7 | Abmaj7": "Dm7 | G7 | Cmaj7 | Cm7 | F7 | Bbmaj7 | Bbm7 | Eb7 | Abmaj7 | Abmaj7",
  "Fmaj7 | F#dim7 | Gm7 | G#dim7 | Am7": "Fmaj7 | F#dim7 | Gm7 | G#dim7 | Am7 | Am7",
  "Em | F | Em": "Em | F | Em | Em",
  "Cm | Ebm | Cm": "Cm | Ebm | Cm | Cm",
  "Cm | Abm | Cm": "Cm | Abm | Cm | Cm",
  "Cm | Dm7b5/C | Em | Fm | G7": "Cm | Dm7b5/C | Em | Fm | G7 | G7",
  "Dm | Fm | C | Ebm | G | Em | C#m": "Dm | Fm | C | Ebm | G | Em | C#m | C#m",
  "Cm | F | Cm": "Cm | F | Cm | Cm",
  "Cm | Dm | Cm": "Cm | Dm | Cm | Cm",
  "Dm | Dm(maj7) | Dm7 | Dm6 | C#°7": "Dm | Dm(maj7) | Dm7 | Dm6 | C#°7 | C#°7"
};

// ============================================================================
// 3-LAYER SELF-HEALING PERSISTENT STORAGE VAULT
// Simultaneously persists across:
//   1. localStorage ('reharmpro_vault_v1')
//   2. IndexedDB ('ReharmProVaultDB' -> 'vault')
//   3. Cache Storage ('reharmpro-vault-cache-v1' -> '/__reharmpro_vault__.json')
// plus navigator.storage.persist() so the browser never evicts or resets user data.
// ============================================================================
const VAULT_LS_KEY = 'reharmpro_vault_v1';
const VAULT_IDB_NAME = 'ReharmProVaultDB';
const VAULT_IDB_STORE = 'vault';
const VAULT_CACHE_NAME = 'reharmpro-vault-cache-v1';
const VAULT_CACHE_URL = '/__reharmpro_vault__.json';

function requestPersistentBrowserStorage() {
  try {
    if (navigator.storage && typeof navigator.storage.persist === 'function') {
      navigator.storage.persist().catch(() => {});
    }
  } catch {}
}

function openVaultIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(VAULT_IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(VAULT_IDB_STORE)) {
          db.createObjectStore(VAULT_IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (e) {
      reject(e);
    }
  });
}

async function readVaultFromIDB(): Promise<VaultPayload | null> {
  try {
    const db = await openVaultIDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(VAULT_IDB_STORE, 'readonly');
      const store = tx.objectStore(VAULT_IDB_STORE);
      const req = store.get('main');
      req.onsuccess = () => resolve((req.result as VaultPayload) || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function writeVaultToIDB(payload: VaultPayload): Promise<void> {
  try {
    const db = await openVaultIDB();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(VAULT_IDB_STORE, 'readwrite');
      const store = tx.objectStore(VAULT_IDB_STORE);
      store.put(payload, 'main');
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {}
}

async function readVaultFromCache(): Promise<VaultPayload | null> {
  try {
    if (typeof caches === 'undefined') return null;
    const cache = await caches.open(VAULT_CACHE_NAME);
    const resp = await cache.match(VAULT_CACHE_URL);
    if (!resp) return null;
    return (await resp.json()) as VaultPayload;
  } catch {
    return null;
  }
}

async function writeVaultToCache(payload: VaultPayload): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    const cache = await caches.open(VAULT_CACHE_NAME);
    const resp = new Response(JSON.stringify(payload), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
    await cache.put(VAULT_CACHE_URL, resp);
  } catch {}
}

// ============================================================================
// AUDIO TRANSPORT & REAL-TIME HIGHLIGHT HELPERS
// ============================================================================
function highlightPlayingStep(measureIdx: number | null, chordIdx: number | null) {
  const allMeasureBoxes = document.querySelectorAll<HTMLElement>('[data-measure-box]');
  allMeasureBoxes.forEach(box => {
    const mIdx = Number(box.getAttribute('data-measure-box'));
    if (measureIdx !== null && mIdx === measureIdx) {
      box.classList.add('ring-2', 'ring-sky-500', 'dark:ring-[#38bdf8]');
    } else {
      box.classList.remove('ring-2', 'ring-sky-500', 'dark:ring-[#38bdf8]');
    }
  });

  const allChordSpans = document.querySelectorAll<HTMLElement>('[data-chord-token]');
  allChordSpans.forEach(span => {
    const mIdx = Number(span.getAttribute('data-measure-idx'));
    const cIdx = Number(span.getAttribute('data-chord-idx'));
    if (measureIdx !== null && chordIdx !== null && mIdx === measureIdx && cIdx === chordIdx) {
      span.classList.add('text-sky-600', 'dark:text-[#38bdf8]', 'scale-105');
      span.classList.remove('text-slate-900', 'dark:text-white');
    } else {
      span.classList.remove('text-sky-600', 'dark:text-[#38bdf8]', 'scale-105');
      span.classList.add('text-slate-900', 'dark:text-white');
    }
  });
}

function updateTransportUI(isPlaying = audioEngine.getIsPlaying()) {
  const playBtn = document.getElementById('playProgBtn');
  const playIcon = document.getElementById('playProgIcon');
  const bpmBadge = document.getElementById('bpmBadgeText');
  const bpmRange = document.getElementById('bpmRangeInput') as HTMLInputElement | null;
  const loopBtn = document.getElementById('loopToggleBtn');

  if (playBtn && playIcon) {
    if (isPlaying) {
      playBtn.className = 'px-3.5 py-2.5 border-r border-slate-200 dark:border-[#0c4a6e]/60 shrink-0 cursor-pointer active:scale-95 transition-all flex items-center justify-center text-sky-600 dark:text-[#38bdf8] bg-sky-500/10 dark:bg-[#0c4a6e]/60';
      playIcon.innerHTML = `<svg class="w-4 h-4 fill-current" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;
    } else {
      playBtn.className = 'px-3.5 py-2.5 border-r border-slate-200 dark:border-[#0c4a6e]/60 shrink-0 cursor-pointer active:scale-95 transition-all flex items-center justify-center text-slate-900 dark:text-white hover:text-sky-600 dark:hover:text-[#38bdf8] hover:bg-slate-100 dark:hover:bg-[#0c4a6e]/40';
      playIcon.innerHTML = `<svg class="w-4 h-4 fill-current" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;
    }
  }

  const bpm = audioEngine.getBpm();
  if (bpmBadge) bpmBadge.textContent = String(bpm);
  if (bpmRange && Number(bpmRange.value) !== bpm) bpmRange.value = String(bpm);

  if (loopBtn) {
    if (audioEngine.getIsLooping()) {
      loopBtn.className = 'px-3.5 py-2.5 border-l border-slate-200 dark:border-[#0c4a6e]/60 shrink-0 cursor-pointer active:scale-95 transition-all flex items-center justify-center text-sky-600 dark:text-[#38bdf8] bg-sky-500/10 dark:bg-[#0c4a6e]/60';
    } else {
      loopBtn.className = 'px-3.5 py-2.5 border-l border-slate-200 dark:border-[#0c4a6e]/60 shrink-0 cursor-pointer active:scale-95 transition-all flex items-center justify-center text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-300';
    }
  }
}

function getReharmOptions(): ReharmExecutionOptions {
  return {
    mode: state.reharmMode,
    density: state.reharmDensity,
    targetIndex: state.targetMeasureIdx,
    lockedMeasures: state.lockedMeasures,
    meter: state.meter
  };
}

function getDisplayedMeasures(): ChordBeatItem[][] {
  const baseMeasures = parseInputByMeasures(state.baseProgression);
  if (!baseMeasures || baseMeasures.length === 0) return [];
  return state.reharmActive && state.selectedTechnique !== 'default'
    ? TargetBackwardEngine.executeReharm(
        baseMeasures,
        state.selectedTechnique,
        state.selectedStrategy,
        getReharmOptions()
      )
    : baseMeasures;
}

// ============================================================================
// REHARM SETS & STATE
// ============================================================================
const REHARM_SETS = {
  basic: [
    { id: 'default', name: 'Default', icon: 'I' },
    { id: 'tonicize', name: 'Tonicization (V7)', icon: 'V⁷' },
    { id: 'tritone_sub', name: 'Tritone Sub (♭II7)', icon: '♭II⁷' },
    { id: 'standard_two_five', name: 'Standard ii-V', icon: 'ii-V⁷' },
    { id: 'tritone_two_five', name: 'Tritone ii-V', icon: '♭ii-V⁷' },
    { id: 'side_step_above', name: 'Side-Step (Above)', icon: '↑' },
    { id: 'side_step_below', name: 'Side-Step (Below)', icon: '↓' },
    { id: 'side_step_two_five', name: 'Side-Step 2-5', icon: 'ss 2-5' },
    { id: 'circle_of_fifths', name: 'Circle of 5ths', icon: 'V/V' }
  ],
  dark: [
    { id: 'default', name: 'Default', icon: 'I' },
    { id: 'dorian_dark', name: 'Dorian Minor (i–IV / m6)', icon: 'i-IV' },
    { id: 'chromatic_mediant', name: 'Chromatic Mediant (i–♭vi)', icon: '♭vi' },
    { id: 'gothic_dominant', name: 'Gothic Cadence (V7♭9 / +)', icon: 'V⁷♭⁹' },
    { id: 'neapolitan_slide', name: 'Phrygian Half-Step (♭II)', icon: '♭II' },
    { id: 'diminished_axis', name: 'Diminished Axis (°7 / +)', icon: '°7' },
    { id: 'elfman_modulation', name: 'Dark Modulation (m(maj7) / ±3)', icon: 'mΔ⁷' }
  ]
};

const ALL_TECHNIQUES = [...REHARM_SETS.basic, ...REHARM_SETS.dark];

function normalizeChordSymbol(sym: string): string {
  if (!sym || sym === '/' || sym === '|') return sym;
  const parts = sym.split('/');
  const normPart = (p: string) => {
    if (!p) return p;
    const m = p.match(/^([a-gA-G])([#b]?)(.*)$/);
    if (!m) return p;
    return m[1].toUpperCase() + (m[2] || '') + (m[3] || '');
  };
  if (parts.length > 1 && parts[1].trim() !== '') {
    return normPart(parts[0].trim()) + '/' + normPart(parts[1].trim());
  }
  return normPart(parts[0].trim());
}

function normalizeProgressionString(rawStr: string): string {
  if (!rawStr || !rawStr.trim()) return '';
  let s = rawStr.trim();
  if (s.includes(':')) {
    const afterColon = s.split(':').slice(1).join(':').trim();
    if (afterColon) s = afterColon;
  }
  s = s
    .replace(/\s*(?:->|→)\s*/g, ' | ')
    .replace(/\s+[-–—]\s+/g, ' | ')
    .replace(/\s*\|\s*/g, ' | ')
    .replace(/^\|\s*|\s*\|$/g, '');

  const bars = s.split('|').map(b => b.trim()).filter(Boolean);
  const cleanedBars = bars.map(bar => {
    const toks = bar.split(/\s+/).filter(Boolean);
    const nonSlash = toks.filter(t => t !== '/');
    if (nonSlash.length === 1 && toks[0] !== '/') {
      return normalizeChordSymbol(toks[0]);
    }
    return toks.map(t => t === '/' ? '/' : normalizeChordSymbol(t)).join(' ');
  });
  return cleanedBars.join(' | ');
}

function migrateLegacyDefaultProgression(rawStr: string): string {
  const norm = normalizeProgressionString(rawStr);
  return LEGACY_DEFAULT_ODD_TO_EVEN_MAP[norm] || norm;
}

const LEGACY_JAZZ_FROM_BASIC_SET = new Set(
  LEGACY_JAZZ_FROM_BASIC.map(normalizeProgressionString)
);

function dedupeProgressions(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const norm = migrateLegacyDefaultProgression(String(item || ''));
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

function inferProgressionCategory(progStr: string): SavedSectionKey {
  if (!progStr) return 'basic';
  const hasJazzQuality = /(maj7|Δ|m7b5|m7\(b5\)|7alt|7\(b9\)|7b9|7\+|m\(maj7\)|dim7|°7|ø|m6|9|11|13)/i.test(
    progStr
  );
  if (hasJazzQuality) return 'jazz';
  const m7Matches = progStr.match(/[A-G][#b]?m7\b/g);
  if (m7Matches && m7Matches.length >= 2) return 'jazz';
  return 'basic';
}

function migrateSavedSections(
  rawSections: Partial<SavedSections> | undefined
): { sections: SavedSections; didMigrateJazzSplit: boolean } {
  const defaultBasic = DEFAULT_BASIC_PROGRESSIONS.map(normalizeProgressionString);
  const defaultJazz = DEFAULT_JAZZ_PROGRESSIONS.map(normalizeProgressionString);
  const defaultDark = DEFAULT_SAVED_PROGRESSIONS.map(normalizeProgressionString);

  if (!rawSections || !Array.isArray(rawSections.basic) || !Array.isArray(rawSections.dark)) {
    return {
      sections: {
        basic: dedupeProgressions(defaultBasic),
        jazz: dedupeProgressions(defaultJazz),
        dark: dedupeProgressions(defaultDark)
      },
      didMigrateJazzSplit: false
    };
  }

  const incomingBasic = dedupeProgressions(rawSections.basic);
  const incomingDark = dedupeProgressions(rawSections.dark);
  const hasJazzArray = Array.isArray(rawSections.jazz) && rawSections.jazz.length > 0;

  if (!hasJazzArray) {
    // Migrate legacy 2-category vault (Basic + Dark) -> 3-category vault (Basic + Jazz + Dark):
    // Move legacy jazz defaults out of Basic into Jazz, preserve any user-added progressions in Basic,
    // and populate Basic and Jazz with all new non-duplicate progressions.
    const userAddedBasic = incomingBasic.filter(p => !LEGACY_JAZZ_FROM_BASIC_SET.has(p));
    const movedJazz = incomingBasic.filter(p => LEGACY_JAZZ_FROM_BASIC_SET.has(p));

    return {
      sections: {
        basic: dedupeProgressions([...userAddedBasic, ...defaultBasic]),
        jazz: dedupeProgressions([...defaultJazz, ...movedJazz]),
        dark: incomingDark.length > 0 ? incomingDark : dedupeProgressions(defaultDark)
      },
      didMigrateJazzSplit: true
    };
  }

  const incomingJazz = dedupeProgressions(rawSections.jazz || []);
  // Ensure if any legacy jazz defaults were still stranded in basic without the new basic defaults, clean them up
  const stillHasLegacyOnlyBasic =
    incomingBasic.length > 0 &&
    incomingBasic.every(p => LEGACY_JAZZ_FROM_BASIC_SET.has(p));

  if (stillHasLegacyOnlyBasic) {
    return {
      sections: {
        basic: dedupeProgressions(defaultBasic),
        jazz: dedupeProgressions([...incomingJazz, ...defaultJazz]),
        dark: incomingDark
      },
      didMigrateJazzSplit: true
    };
  }

  return {
    sections: {
      basic: incomingBasic.includes('C | Am | Dm | G')
        ? incomingBasic
        : ['C | Am | Dm | G', ...incomingBasic],
      jazz: incomingJazz,
      dark: incomingDark
    },
    didMigrateJazzSplit: false
  };
}

function migrateBaseProgressionsPool(rawPool: unknown[] | undefined, didMigrateJazzSplit: boolean): string[] {
  const defaultPool = dedupeProgressions(DEFAULT_PROGRESSIONS);
  if (!Array.isArray(rawPool) || rawPool.length === 0) {
    return defaultPool;
  }
  const cleaned = dedupeProgressions(rawPool.map(p => String(p)));
  if (didMigrateJazzSplit) {
    return dedupeProgressions([...cleaned, ...defaultPool]);
  }
  return cleaned.length > 0 ? cleaned : defaultPool;
}

function loadInitialVaultSync(): VaultPayload {
  const defaultPayload: VaultPayload = {
    updatedAt: 0,
    theme: 'dark',
    savedSections: {
      basic: dedupeProgressions(DEFAULT_BASIC_PROGRESSIONS),
      jazz: dedupeProgressions(DEFAULT_JAZZ_PROGRESSIONS),
      dark: dedupeProgressions(DEFAULT_SAVED_PROGRESSIONS)
    },
    baseProgressionsPool: dedupeProgressions(DEFAULT_PROGRESSIONS)
  };

  try {
    const rawVault = localStorage.getItem(VAULT_LS_KEY);
    if (rawVault) {
      const parsed = JSON.parse(rawVault) as Partial<VaultPayload>;
      if (
        parsed &&
        parsed.savedSections &&
        Array.isArray(parsed.savedSections.basic) &&
        Array.isArray(parsed.savedSections.dark) &&
        Array.isArray(parsed.baseProgressionsPool)
      ) {
        const { sections, didMigrateJazzSplit } = migrateSavedSections(parsed.savedSections);
        const migratedPool = migrateBaseProgressionsPool(parsed.baseProgressionsPool, didMigrateJazzSplit);
        const payload: VaultPayload = {
          updatedAt: didMigrateJazzSplit
            ? Date.now()
            : (typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now()),
          theme: parsed.theme === 'light' ? 'light' : 'dark',
          savedSections: sections,
          baseProgressionsPool: migratedPool
        };
        if (didMigrateJazzSplit) {
          localStorage.setItem(VAULT_LS_KEY, JSON.stringify(payload));
        }
        return payload;
      }
    }

    // Migrate legacy keys if present
    const legacySaved = localStorage.getItem('reharmpro_saved_sections_v3');
    const legacyPool = localStorage.getItem('reharmpro_base_pool_v2');
    if (legacySaved || legacyPool) {
      let didMigrate = false;
      if (legacySaved) {
        const pSaved = JSON.parse(legacySaved);
        if (pSaved && Array.isArray(pSaved.basic) && Array.isArray(pSaved.dark)) {
          const { sections, didMigrateJazzSplit } = migrateSavedSections(pSaved);
          defaultPayload.savedSections = sections;
          didMigrate = didMigrateJazzSplit;
        }
      }
      if (legacyPool) {
        const pPool = JSON.parse(legacyPool);
        if (Array.isArray(pPool) && pPool.length > 0) {
          defaultPayload.baseProgressionsPool = migrateBaseProgressionsPool(pPool, didMigrate);
        }
      }
      defaultPayload.updatedAt = Date.now();
      localStorage.setItem(VAULT_LS_KEY, JSON.stringify(defaultPayload));
    }
  } catch {}

  return defaultPayload;
}

const initialVault = loadInitialVaultSync();

const DEFAULT_START_PROGRESSION = 'C | Am | Dm | G';

const state = {
  currentScreen: 'generator' as 'generator' | 'saved',
  // Clean base progression initialized to C | Am | Dm | G
  baseProgression: DEFAULT_START_PROGRESSION,
  userChangedBaseProgression: false,
  meter: 4,
  manualMeterOverride: false,
  reharmSet: 'basic' as 'basic' | 'dark',
  selectedTechnique: 'default',
  selectedStrategy: 'strategy1',
  reharmMode: 'HYBRID' as ReharmMode,
  reharmDensity: 'BALANCED' as ReharmDensity,
  targetMeasureIdx: null as number | null,
  lockedMeasures: [] as number[],
  reharmActive: false,
  strategyCycleIndex: 0,
  editingBaseIdx: null as number | null,
  editingSavedKey: null as string | null,
  activeSavedSection: null as SavedSectionKey | null,
  lastFormattedOutput: '',
  theme: initialVault.theme,
  vaultUpdatedAt: initialVault.updatedAt,
  savedSections: initialVault.savedSections,
  baseProgressionsPool: initialVault.baseProgressionsPool
};

function getDefaultBaseProgression(): string {
  return DEFAULT_START_PROGRESSION;
}

function syncDefaultProgressionInputUI() {
  const defaultProg = getDefaultBaseProgression();
  const input = document.getElementById('singleProgInput') as HTMLInputElement | null;
  if (input) {
    input.placeholder = defaultProg;
  }
  const savedInput = document.getElementById('savedProgInput') as HTMLInputElement | null;
  if (savedInput) {
    savedInput.placeholder = defaultProg;
  }
  const modalInput = document.getElementById('newBaseProgInput') as HTMLInputElement | null;
  if (modalInput) {
    modalInput.placeholder = defaultProg;
  }
}

function persistVault() {
  state.vaultUpdatedAt = Date.now();
  const payload: VaultPayload = {
    updatedAt: state.vaultUpdatedAt,
    theme: state.theme,
    savedSections: state.savedSections,
    baseProgressionsPool: state.baseProgressionsPool
  };

  try {
    localStorage.setItem(VAULT_LS_KEY, JSON.stringify(payload));
  } catch {}

  writeVaultToIDB(payload);
  writeVaultToCache(payload);
}

async function syncAndHealVault() {
  requestPersistentBrowserStorage();
  const [idbData, cacheData] = await Promise.all([readVaultFromIDB(), readVaultFromCache()]);

  let newest: VaultPayload | null = null;
  let maxTime = state.vaultUpdatedAt;

  for (const candidate of [idbData, cacheData]) {
    if (
      candidate &&
      typeof candidate.updatedAt === 'number' &&
      candidate.updatedAt > maxTime &&
      candidate.savedSections &&
      Array.isArray(candidate.savedSections.basic) &&
      Array.isArray(candidate.savedSections.dark) &&
      Array.isArray(candidate.baseProgressionsPool)
    ) {
      newest = candidate;
      maxTime = candidate.updatedAt;
    }
  }

  if (newest) {
    // Self-heal state from IndexedDB or Cache Storage after browser localStorage reset
    const { sections, didMigrateJazzSplit } = migrateSavedSections(newest.savedSections);
    state.vaultUpdatedAt = didMigrateJazzSplit ? Date.now() : newest.updatedAt;
    state.theme = newest.theme === 'light' ? 'light' : 'dark';
    state.savedSections = sections;
    state.baseProgressionsPool = migrateBaseProgressionsPool(newest.baseProgressionsPool, didMigrateJazzSplit);
    if (!state.userChangedBaseProgression) {
      state.baseProgression = getDefaultBaseProgression();
      const input = document.getElementById('singleProgInput') as HTMLInputElement | null;
      if (input) input.value = state.baseProgression;
    }
    syncDefaultProgressionInputUI();
    applyThemeToDOM();
    renderOutput();
    renderSavedProgressionsList();
    renderBaseProgressionsList();
  }

  // Ensure all 3 storage layers have the latest copy
  const currentPayload: VaultPayload = {
    updatedAt: state.vaultUpdatedAt || Date.now(),
    theme: state.theme,
    savedSections: state.savedSections,
    baseProgressionsPool: state.baseProgressionsPool
  };
  try {
    localStorage.setItem(VAULT_LS_KEY, JSON.stringify(currentPayload));
  } catch {}
  await Promise.all([writeVaultToIDB(currentPayload), writeVaultToCache(currentPayload)]);
}

function isProgressionSavedAnywhere(normProg: string): boolean {
  if (!normProg) return false;
  return (
    state.savedSections.basic.includes(normProg) ||
    state.savedSections.jazz.includes(normProg) ||
    state.savedSections.dark.includes(normProg)
  );
}

function applySmartInputShortcuts(inputEl: HTMLInputElement | null) {
  if (!inputEl) return;
  const raw = inputEl.value;
  const cursor = inputEl.selectionStart ?? raw.length;
  const beforeCursor = raw.slice(0, cursor);
  const afterCursor = raw.slice(cursor);

  const transformSegment = (seg: string) =>
    seg
      .replace(/\s*(?:->|→)\s*/g, ' | ')
      .replace(/\s+[-–—]\s+/g, ' | ')
      .replace(/\s*[.;]+\s*/g, ' | ')
      .replace(/([^\s|])\s{2,}/g, '$1 | ')
      .replace(/\s*,+\s*/g, ' / ')
      .replace(/\|\s*\|+/g, '|')
      .replace(/(^|[\s|/])([a-g])/g, (_, prefix: string, letter: string) => prefix + letter.toUpperCase());

  const newBefore = transformSegment(beforeCursor);
  const newAfter = transformSegment(afterCursor);
  const nextVal = newBefore + newAfter;

  if (nextVal !== raw) {
    inputEl.value = nextVal;
    const newCursor = newBefore.length;
    try {
      inputEl.setSelectionRange(newCursor, newCursor);
    } catch {}
  }
}

function detectMeterFromInput(str: string, fallbackMeter = 3): number {
  if (!str || !str.trim()) return fallbackMeter;
  const rawBars = str.split('|').map(s => s.trim()).filter(Boolean);
  let hasExplicitSlashes = false;
  let maxExplicitBeats = 0;
  let maxChordCount = 0;

  rawBars.forEach(barStr => {
    const tokens = barStr.split(/\s+/).filter(Boolean);
    let beats = 0;
    let chords = 0;
    tokens.forEach(tok => {
      if (/^\/+$/.test(tok)) {
        hasExplicitSlashes = true;
        beats += tok.length;
      } else {
        const trailing = tok.match(/^(.*?)(\/+)$/);
        if (trailing && trailing[1]) {
          hasExplicitSlashes = true;
          beats += 1 + trailing[2].length;
          chords += 1;
        } else {
          beats += 1;
          chords += 1;
        }
      }
    });
    if (beats > maxExplicitBeats) maxExplicitBeats = beats;
    if (chords > maxChordCount) maxChordCount = chords;
  });

  if (hasExplicitSlashes) {
    if (maxExplicitBeats === 4) return 4;
    if (maxExplicitBeats === 3) return 3;
  }
  if (maxChordCount === 4) return 4;
  if (maxChordCount === 3 && rawBars.length >= 2 && rawBars.some(b => b.split(/\s+/).filter(Boolean).length === 1)) {
    return 3;
  }
  return fallbackMeter;
}

function updateMeterBadgeUI() {
  const btn = document.getElementById('meterToggleBtn');
  if (btn) {
    btn.textContent = `${state.meter}/4`;
  }
}

function parseInputByMeasures(str: string): ChordBeatItem[][] {
  if (!str || !str.trim()) return [];

  let cleanStr = str.trim();
  if (cleanStr.includes(':')) {
    const afterColon = cleanStr.split(':').slice(1).join(':').trim();
    if (afterColon && !/^\d+$/.test(afterColon)) {
      cleanStr = afterColon;
    }
  }

  cleanStr = cleanStr
    .replace(/\s*(?:->|→)\s*/g, ' | ')
    .replace(/\s+[-–—]\s+/g, ' | ')
    .replace(/\s*[.;]+\s*/g, ' | ')
    .replace(/\s*,+\s*/g, ' / ');

  if (!cleanStr.includes('|') && /[-–—]/.test(cleanStr)) {
    cleanStr = cleanStr.replace(/[-–—]/g, ' | ');
  }

  if (!state.manualMeterOverride) {
    state.meter = detectMeterFromInput(cleanStr, state.meter);
    updateMeterBadgeUI();
  }
  const activeMeter = state.meter || 4;

  const rawMeasures = cleanStr.split('|');
  const measures: ChordBeatItem[][] = [];
  const measureHasExplicitSlash: boolean[] = [];

  rawMeasures.forEach(mStr => {
    const trimmed = mStr.trim();
    if (!trimmed) return;

    const tokens = trimmed.split(/\s+/).filter(Boolean);
    const chords: ChordBeatItem[] = [];
    let hasSlashInBar = false;

    tokens.forEach(tok => {
      if (/^\/+$/.test(tok)) {
        hasSlashInBar = true;
        const slashCount = tok.length;
        if (chords.length > 0) {
          chords[chords.length - 1].beats += slashCount;
        } else if (measures.length > 0) {
          const prevBar = measures[measures.length - 1];
          const prevChord = prevBar[prevBar.length - 1].chord;
          chords.push({ chord: prevChord, beats: slashCount });
        }
        return;
      }

      const trailingSlashMatch = tok.match(/^(.*?)(\/+)$/);
      if (trailingSlashMatch && trailingSlashMatch[1]) {
        hasSlashInBar = true;
        const baseName = normalizeChordSymbol(trailingSlashMatch[1].trim());
        const extraBeats = trailingSlashMatch[2].length;
        chords.push({ chord: baseName, beats: 1 + extraBeats });
        return;
      }

      const match = tok.match(/^([^:]+?)(?::(\d+))?$/);
      const rawName = match ? match[1].trim() : tok;
      const chordName = normalizeChordSymbol(rawName);
      const explicitBeats = match && match[2] ? parseInt(match[2], 10) : null;

      if (explicitBeats && !isNaN(explicitBeats) && explicitBeats >= 1) {
        hasSlashInBar = true;
        chords.push({ chord: chordName, beats: explicitBeats });
        return;
      }

      if (chords.length > 0 && chords[chords.length - 1].chord === chordName) {
        hasSlashInBar = true;
        chords[chords.length - 1].beats += 1;
      } else {
        chords.push({ chord: chordName, beats: 1 });
      }
    });

    if (chords.length > 0) {
      measures.push(chords);
      measureHasExplicitSlash.push(hasSlashInBar);
    }
  });

  if (!cleanStr.includes('|') && measures.length === 1) {
    const singleBar = measures[0];
    const totalStreamBeats = singleBar.reduce((s, c) => s + c.beats, 0);
    if (totalStreamBeats > activeMeter) {
      const expandedBeats: string[] = [];
      singleBar.forEach(item => {
        for (let b = 0; b < item.beats; b++) {
          expandedBeats.push(item.chord);
        }
      });
      const chunkedMeasures: ChordBeatItem[][] = [];
      for (let i = 0; i < expandedBeats.length; i += activeMeter) {
        const slice = expandedBeats.slice(i, i + activeMeter);
        const compressed: ChordBeatItem[] = [];
        slice.forEach(ch => {
          if (compressed.length > 0 && compressed[compressed.length - 1].chord === ch) {
            compressed[compressed.length - 1].beats += 1;
          } else {
            compressed.push({ chord: ch, beats: 1 });
          }
        });
        if (compressed.length === 1 && compressed[0].beats < activeMeter) {
          compressed[0].beats = activeMeter;
        }
        chunkedMeasures.push(compressed);
      }
      return chunkedMeasures;
    }
  }

  if (measures.length > 0) {
    measures.forEach((m, idx) => {
      const total = m.reduce((sum, c) => sum + c.beats, 0);
      const hasSlash = measureHasExplicitSlash[idx];

      if (m.length === 1) {
        if (!hasSlash || total < activeMeter || state.manualMeterOverride) {
          m[0].beats = activeMeter;
        }
      } else if (m.length === 2 && total < activeMeter) {
        if (activeMeter === 4) {
          if (!hasSlash) {
            m[0].beats = 2;
            m[1].beats = 2;
          } else {
            m[1].beats += 4 - total;
          }
        } else if (activeMeter === 3) {
          m[0].beats = 2;
          m[1].beats = 1;
        }
      } else if (m.length === 3 && total < activeMeter && activeMeter === 4) {
        m[0].beats = 2;
        m[1].beats = 1;
        m[2].beats = 1;
      }
    });
  }

  return measures;
}

function formatChordHtml(str: string): string {
  if (!str) return '';
  return str.replace(
    /\(maj7\)|7\(b5\)|\(b5\)|7alt|add2|add9|maj7|7b5|m11|dim7|dim|9sus4|7\(b9,b13\)|7\(b9\)|7\(#9\)|7\(#11\)|7\+|°7|Δ|ø|\+|7|9|11|13|6/g,
    m => `<sup>${m}</sup>`
  );
}

function formatMeasuresToString(measuresList: ChordBeatItem[][]): string {
  if (!measuresList || measuresList.length === 0) return '';
  return measuresList
    .map(meas => {
      if (meas.length === 1) {
        return meas[0].chord;
      }
      const tokens: string[] = [];
      meas.forEach(item => {
        tokens.push(item.chord);
        for (let i = 1; i < item.beats; i++) {
          tokens.push('/');
        }
      });
      return tokens.join(' ');
    })
    .join(' | ');
}

function formatProgressionCardHtml(progStr: string): string {
  if (!progStr) return '';
  const norm = normalizeProgressionString(progStr);
  const measures = norm.split('|').map(s => s.trim()).filter(Boolean);
  return measures
    .map(m => {
      const tokens = m
        .split(/\s+/)
        .filter(Boolean)
        .map(tok => {
          if (tok === '/') {
            return `<span class="text-slate-400 dark:text-[#38bdf8]/60 font-bold">/</span>`;
          }
          return `<span class="text-slate-900 dark:text-white">${formatChordHtml(tok)}</span>`;
        })
        .join(' ');
      return `<span class="inline-flex items-center gap-1">${tokens}</span>`;
    })
    .join(`<span class="text-slate-300 dark:text-[#38bdf8]/40 font-normal mx-1.5">|</span>`);
}

function updateSaveButtonUI() {
  const btn = document.getElementById('saveCurrentProgBtn');
  const iconSpan = document.getElementById('saveProgIcon');
  if (!btn || !iconSpan) return;

  const normOut = normalizeProgressionString(state.lastFormattedOutput);
  const isSaved = isProgressionSavedAnywhere(normOut);
  if (isSaved) {
    btn.classList.add('text-sky-600', 'dark:text-[#38bdf8]');
    iconSpan.innerHTML = `<svg class="w-4 h-4 fill-current text-sky-600 dark:text-[#38bdf8]" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>`;
  } else {
    btn.classList.remove('text-sky-600', 'dark:text-[#38bdf8]');
    iconSpan.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>`;
  }
}

function updateReharmSetUI() {
  const techPopover = document.getElementById('reharmTechniquePopover');
  const badge = document.getElementById('reharmIconBadge');
  const setBtnBasic = document.getElementById('setBtnBasic');
  const setBtnDark = document.getElementById('setBtnDark');
  const visualBtn = document.getElementById('reharmVisualBtn');

  const activeList = REHARM_SETS[state.reharmSet] || REHARM_SETS.basic;
  if (!activeList.some(t => t.id === state.selectedTechnique)) {
    state.selectedTechnique = activeList[0].id;
  }

  if (techPopover) {
    techPopover.innerHTML = activeList
      .map(t => {
        const isSelected = t.id === state.selectedTechnique;
        const cls = isSelected
          ? 'bg-sky-600 text-white dark:bg-[#0c4a6e] dark:text-[#38bdf8]'
          : 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#0c4a6e]/40';
        return `
          <button type="button" onclick="window.ReharmEngine.setReharmTechnique('${t.id}')" class="w-full px-3 py-2 rounded-[7px] flex items-center justify-between gap-3 text-xs font-mono-tabular font-extrabold transition-colors cursor-pointer text-left ${cls}">
            <span class="truncate">${t.name}</span>
            <span class="text-[12px] font-black shrink-0">${t.icon}</span>
          </button>
        `;
      })
      .join('');
  }

  if (badge) {
    const tech =
      activeList.find(t => t.id === state.selectedTechnique) ||
      ALL_TECHNIQUES.find(t => t.id === state.selectedTechnique) ||
      activeList[0];
    badge.textContent = tech.icon;
  }

  if (visualBtn) {
    if (state.reharmSet === 'dark') {
      visualBtn.classList.add('border-sky-500', 'dark:border-[#38bdf8]/70');
    } else {
      visualBtn.classList.remove('border-sky-500', 'dark:border-[#38bdf8]/70');
    }
  }

  if (setBtnBasic && setBtnDark) {
    const activeCls = 'bg-sky-600 text-white dark:bg-[#0c4a6e] dark:text-[#38bdf8]';
    const inactiveCls = 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-[#0c4a6e]/40';
    setBtnBasic.className = `w-full px-3 py-2 rounded-[7px] flex items-center justify-between text-xs font-mono-tabular font-extrabold transition-colors cursor-pointer ${state.reharmSet === 'basic' ? activeCls : inactiveCls}`;
    setBtnDark.className = `w-full px-3 py-2 rounded-[7px] flex items-center justify-between text-xs font-mono-tabular font-extrabold transition-colors cursor-pointer ${state.reharmSet === 'dark' ? activeCls : inactiveCls}`;
  }
}

// ============================================================================
// RENDER MAIN OUTPUT CHORDS (ALWAYS COMPUTED PURELY FROM state.baseProgression)
// ============================================================================
function renderOutput() {
  const outputContainer = document.getElementById('reharmOutputContainer');
  if (!outputContainer) return;

  // Always parse a fresh copy from the unmodified base progression
  const baseMeasures = parseInputByMeasures(state.baseProgression);

  if (!baseMeasures || baseMeasures.length === 0) {
    state.lastFormattedOutput = '';
    updateSaveButtonUI();
    outputContainer.innerHTML = `
      <div class="flex flex-col items-center justify-center py-8 text-slate-500 dark:text-slate-400">
        <span class="text-xs font-mono-tabular">${getDefaultBaseProgression()}</span>
      </div>
    `;
    return;
  }

  const displayedMeasures = state.reharmActive && state.selectedTechnique !== 'default'
    ? TargetBackwardEngine.executeReharm(
        baseMeasures,
        state.selectedTechnique,
        state.selectedStrategy,
        getReharmOptions()
      )
    : baseMeasures;

  state.lastFormattedOutput = formatMeasuresToString(displayedMeasures);
  updateSaveButtonUI();

  if (audioEngine.getIsPlaying()) {
    audioEngine.updatePlayingMeasures(displayedMeasures, state.meter);
  }

  const measureEntries = displayedMeasures.map((measChords, mIdx) => {
    const mList: { type: 'chord' | 'slash'; val: string; beats?: number; measureIdx: number; chordIdx?: number }[] = [];
    measChords.forEach((item, cIdx) => {
      mList.push({ type: 'chord', val: item.chord, beats: item.beats, measureIdx: mIdx, chordIdx: cIdx });
      for (let i = 1; i < item.beats; i++) {
        mList.push({ type: 'slash', val: '/', measureIdx: mIdx });
      }
    });
    return mList;
  });

  const rowsOfMeasures = [];
  for (let i = 0; i < measureEntries.length; i += 2) {
    rowsOfMeasures.push(measureEntries.slice(i, i + 2));
  }

  const leadSheetRowsHtml = rowsOfMeasures
    .map(rowMeasures => {
      const measBoxesHtml = rowMeasures
        .map(measTokens => {
          const mIdx = measTokens[0]?.measureIdx ?? 0;
          const chordCount = measTokens.filter(t => t.type === 'chord').length;
          const chordSizeCls =
            chordCount >= 4
              ? 'text-base sm:text-xl'
              : chordCount === 3
                ? 'text-lg sm:text-2xl'
                : 'text-2xl sm:text-3xl';
          const slashSizeCls =
            chordCount >= 3 ? 'text-base sm:text-xl' : 'text-xl sm:text-3xl';
          const measContent = measTokens
            .map(tok => {
              if (tok.type === 'slash') {
                return `<span class="text-slate-400 dark:text-[#38bdf8]/60 font-mono-tabular ${slashSizeCls} font-bold select-none">/</span>`;
              }
              const formattedName = formatChordHtml(tok.val);
              return `<span data-chord-token="1" data-measure-idx="${tok.measureIdx}" data-chord-idx="${tok.chordIdx ?? 0}" onclick="window.ReharmEngine.playChordString('${tok.val}', ${tok.beats || 2})" class="${chordSizeCls} font-black font-mono-tabular tracking-tight text-slate-900 dark:text-white hover:text-sky-600 dark:hover:text-[#38bdf8] transition-all duration-150 cursor-pointer active:scale-95 select-none inline-block">${formattedName}</span>`;
            })
            .join(' ');

          return `
            <div data-measure-box="${mIdx}" class="relative flex items-center justify-between gap-1.5 sm:gap-2 px-3.5 py-3.5 sm:px-4 sm:py-4 bg-white dark:bg-[#071d2c] border border-slate-300 dark:border-[#0c4a6e] rounded-[10px] shadow-sm w-full text-left transition-all duration-150">
              ${measContent}
            </div>
          `;
        })
        .join('');

      return `
        <div class="grid grid-cols-2 gap-2.5 sm:gap-3 w-full">
          ${measBoxesHtml}
        </div>
      `;
    })
    .join('');

  outputContainer.innerHTML = `
    <div class="flex flex-col gap-3 w-full my-auto">
      ${leadSheetRowsHtml}
    </div>
  `;
}

function renderSavedProgressionsList() {
  const container = document.getElementById('savedProgressionsList');
  if (!container) return;

  const currentNorm = normalizeProgressionString(state.baseProgression);

  if (!state.activeSavedSection) {
    const sections: { key: SavedSectionKey; title: string; list: string[] }[] = [
      { key: 'basic', title: 'Basic', list: state.savedSections.basic },
      { key: 'jazz', title: 'Jazz', list: state.savedSections.jazz },
      { key: 'dark', title: 'Dark', list: state.savedSections.dark }
    ];

    const squareCardsHtml = sections
      .map(sec => {
        const hasActiveProg = sec.list.some(p => normalizeProgressionString(p) === currentNorm);
        const borderClass = hasActiveProg
          ? 'border-sky-500 bg-sky-50 dark:border-[#38bdf8] dark:bg-[#0c3b59]'
          : 'border-slate-300 dark:border-[#0c4a6e] bg-white dark:bg-[#071d2c] hover:border-sky-500/70 dark:hover:border-[#38bdf8]/60';

        return `
          <button type="button" onclick="window.ReharmEngine.openSavedSection('${sec.key}')" class="aspect-square w-full p-4 border ${borderClass} rounded-[14px] flex flex-col items-center justify-center text-center cursor-pointer active:scale-[0.98] transition-all select-none shadow-sm group">
            <span class="font-mono-tabular text-xl sm:text-2xl font-black tracking-tight text-slate-900 dark:text-white group-hover:text-sky-600 dark:group-hover:text-[#38bdf8] transition-colors">${sec.title}</span>
          </button>
        `;
      })
      .join('');

    container.innerHTML = `
      <div class="grid grid-cols-2 gap-3.5 w-full my-auto">
        ${squareCardsHtml}
      </div>
    `;
    return;
  }

  const secKey: SavedSectionKey =
    state.activeSavedSection === 'dark'
      ? 'dark'
      : state.activeSavedSection === 'jazz'
        ? 'jazz'
        : 'basic';
  const sectionTitles: Record<SavedSectionKey, string> = {
    basic: 'Basic',
    jazz: 'Jazz',
    dark: 'Dark'
  };
  const secTitle = sectionTitles[secKey];
  const otherKeys = (['basic', 'jazz', 'dark'] as SavedSectionKey[]).filter(k => k !== secKey);
  const list = state.savedSections[secKey] || [];

  const otherButtonsHtml = otherKeys
    .map(
      k => `
      <button type="button" onclick="window.ReharmEngine.openSavedSection('${k}')" class="py-1 px-2 rounded-[6px] text-xs font-mono-tabular font-bold text-slate-500 dark:text-slate-400 hover:text-sky-600 dark:hover:text-[#38bdf8] cursor-pointer transition-colors">
        ${sectionTitles[k]}
      </button>
    `
    )
    .join('');

  const headerHtml = `
    <div class="flex items-center justify-between pb-1 shrink-0">
      <button type="button" onclick="window.ReharmEngine.closeSavedSection()" class="inline-flex items-center gap-1.5 py-1 px-1.5 -ml-1.5 rounded-[6px] text-slate-700 dark:text-slate-200 hover:text-sky-600 dark:hover:text-[#38bdf8] font-mono-tabular text-sm font-black tracking-tight cursor-pointer transition-colors">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        <span>${secTitle}</span>
      </button>
      <div class="flex items-center gap-1">
        ${otherButtonsHtml}
      </div>
    </div>
  `;

  const cardsHtml = list
    .map((progStr, idx) => {
      const normProg = normalizeProgressionString(progStr);
      const editKey = `${secKey}:${idx}`;

      if (state.editingSavedKey === editKey) {
        return `
          <div onclick="event.stopPropagation()" class="p-2.5 border border-sky-500 dark:border-[#38bdf8] bg-white dark:bg-[#071d2c] rounded-[10px] flex items-center gap-2 shadow-sm shrink-0">
            <input id="editSavedInput_${secKey}_${idx}" type="text" value="${normProg.replace(/"/g, '&quot;')}" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" oninput="window.ReharmEngine.handleModalInputFormat(this)" onkeydown="if(event.key === 'Enter') window.ReharmEngine.saveEditSavedProgression('${secKey}', ${idx}); else if(event.key === 'Escape') window.ReharmEngine.cancelEditSavedProgression();" class="flex-1 min-w-0 py-1.5 px-2.5 bg-slate-50 dark:bg-[#030d17] border border-slate-300 dark:border-[#0c4a6e] rounded-[6px] text-[13px] font-mono-tabular font-extrabold text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-sky-500/40 dark:focus:ring-[#38bdf8]/40" />
            <button type="button" onclick="event.stopPropagation(); window.ReharmEngine.saveEditSavedProgression('${secKey}', ${idx})" class="p-1.5 text-sky-600 dark:text-[#38bdf8] hover:bg-slate-100 dark:hover:bg-[#0c4a6e]/40 rounded-[6px] transition-colors cursor-pointer shrink-0" title="Save">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
            </button>
            <button type="button" onclick="event.stopPropagation(); window.ReharmEngine.cancelEditSavedProgression()" class="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-white rounded-[6px] transition-colors cursor-pointer shrink-0" title="Cancel">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            </button>
          </div>
        `;
      }

      const isActive = normProg === currentNorm;
      const borderClass = isActive
        ? 'border-sky-500 bg-sky-50 dark:border-[#38bdf8] dark:bg-[#0c3b59]'
        : 'border-slate-300 dark:border-[#0c4a6e] bg-white dark:bg-[#071d2c] hover:border-sky-500/60 dark:hover:border-[#38bdf8]/60';
      const isFirst = idx === 0;
      const isLast = idx === list.length - 1;

      return `
        <div onclick="window.ReharmEngine.loadSavedProgression('${secKey}', ${idx})" class="group px-3.5 py-3 border ${borderClass} rounded-[10px] flex items-center justify-between gap-2 cursor-pointer active:scale-[0.99] transition-all select-none shadow-sm shrink-0">
          <div class="font-mono-tabular text-[14px] font-extrabold leading-relaxed text-left flex-1 flex flex-wrap items-center gap-y-1">
            ${formatProgressionCardHtml(normProg)}
          </div>
          <div class="flex items-center gap-0.5 shrink-0">
            <button type="button" ${isFirst ? 'disabled' : ''} onclick="event.stopPropagation(); window.ReharmEngine.moveSavedProgression('${secKey}', ${idx}, -1)" class="p-1.5 text-slate-400 hover:text-sky-600 dark:hover:text-[#38bdf8] transition-colors cursor-pointer ${isFirst ? 'opacity-25 pointer-events-none' : ''}" title="Move Up">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>
            </button>
            <button type="button" ${isLast ? 'disabled' : ''} onclick="event.stopPropagation(); window.ReharmEngine.moveSavedProgression('${secKey}', ${idx}, 1)" class="p-1.5 text-slate-400 hover:text-sky-600 dark:hover:text-[#38bdf8] transition-colors cursor-pointer ${isLast ? 'opacity-25 pointer-events-none' : ''}" title="Move Down">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
            </button>
            <button type="button" onclick="event.stopPropagation(); window.ReharmEngine.startEditSavedProgression('${secKey}', ${idx})" class="p-1.5 text-slate-400 hover:text-sky-600 dark:hover:text-[#38bdf8] transition-colors cursor-pointer" title="Edit">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
            </button>
            <button type="button" onclick="event.stopPropagation(); window.ReharmEngine.deleteSavedProgression('${secKey}', ${idx})" class="p-1.5 text-slate-400 hover:text-red-500 dark:hover:text-red-400 transition-colors cursor-pointer" title="Delete">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            </button>
          </div>
        </div>
      `;
    })
    .join('');

  container.innerHTML = headerHtml + `<div class="flex flex-col gap-2.5 pb-1">${cardsHtml}</div>`;
}

function renderBaseProgressionsList() {
  const container = document.getElementById('baseProgressionsList');
  if (!container) return;

  if (!state.baseProgressionsPool || state.baseProgressionsPool.length === 0) {
    container.innerHTML = '';
    return;
  }

  const currentNorm = normalizeProgressionString(state.baseProgression);
  const total = state.baseProgressionsPool.length;

  container.innerHTML = state.baseProgressionsPool
    .map((progStr, idx) => {
      const normProg = normalizeProgressionString(progStr) || progStr;

      if (state.editingBaseIdx === idx) {
        return `
          <div onclick="event.stopPropagation()" class="p-2 border border-sky-500 dark:border-[#38bdf8] bg-white dark:bg-[#030d17] rounded-[8px] flex items-center gap-1.5">
            <input id="editBaseProgInput_${idx}" type="text" value="${normProg.replace(/"/g, '&quot;')}" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" oninput="window.ReharmEngine.handleModalInputFormat(this)" onkeydown="if(event.key === 'Enter') window.ReharmEngine.saveEditBaseProgression(${idx}); else if(event.key === 'Escape') window.ReharmEngine.cancelEditBaseProgression();" class="flex-1 min-w-0 py-1.5 px-2 bg-slate-50 dark:bg-[#071d2c] border border-slate-300 dark:border-[#0c4a6e] rounded-[6px] text-xs font-mono-tabular font-extrabold text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-sky-500/40 dark:focus:ring-[#38bdf8]/40" />
            <button type="button" onclick="event.stopPropagation(); window.ReharmEngine.saveEditBaseProgression(${idx})" class="p-1.5 text-sky-600 dark:text-[#38bdf8] hover:bg-slate-100 dark:hover:bg-[#0c4a6e]/40 rounded-[6px] transition-colors cursor-pointer shrink-0" title="Save">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
            </button>
            <button type="button" onclick="event.stopPropagation(); window.ReharmEngine.cancelEditBaseProgression()" class="p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-white rounded-[6px] transition-colors cursor-pointer shrink-0" title="Cancel">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            </button>
          </div>
        `;
      }

      const isActive = normProg === currentNorm;
      const borderClass = isActive
        ? 'border-sky-500 bg-sky-50 dark:border-[#38bdf8] dark:bg-[#0c3b59]'
        : 'border-slate-200 dark:border-[#0c4a6e]/70 bg-slate-50 dark:bg-[#030d17] hover:border-sky-500/60 dark:hover:border-[#38bdf8]/60';
      const isFirst = idx === 0;
      const isLast = idx === total - 1;

      return `
        <div onclick="window.ReharmEngine.selectBaseProgression(${idx})" class="group p-2.5 border ${borderClass} rounded-[8px] flex items-center justify-between gap-2 cursor-pointer active:scale-[0.99] transition-all select-none" title="Tap to fill randomizer">
          <div class="font-mono-tabular text-xs font-extrabold text-slate-900 dark:text-white leading-relaxed break-words flex-1 flex flex-wrap items-center gap-y-0.5">
            ${formatProgressionCardHtml(normProg)}
          </div>
          <div class="flex items-center gap-0.5 shrink-0">
            <button type="button" ${isFirst ? 'disabled' : ''} onclick="event.stopPropagation(); window.ReharmEngine.moveBaseProgression(${idx}, -1)" class="p-1 text-slate-400 hover:text-sky-600 dark:hover:text-[#38bdf8] transition-colors cursor-pointer ${isFirst ? 'opacity-25 pointer-events-none' : ''}" title="Move Up">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>
            </button>
            <button type="button" ${isLast ? 'disabled' : ''} onclick="event.stopPropagation(); window.ReharmEngine.moveBaseProgression(${idx}, 1)" class="p-1 text-slate-400 hover:text-sky-600 dark:hover:text-[#38bdf8] transition-colors cursor-pointer ${isLast ? 'opacity-25 pointer-events-none' : ''}" title="Move Down">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
            </button>
            <button type="button" onclick="event.stopPropagation(); window.ReharmEngine.startEditBaseProgression(${idx})" class="p-1 text-slate-400 hover:text-sky-600 dark:hover:text-[#38bdf8] transition-colors cursor-pointer" title="Edit">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
            </button>
            <button type="button" onclick="event.stopPropagation(); window.ReharmEngine.deleteBaseProgression(${idx})" class="p-1 text-slate-400 hover:text-red-500 dark:hover:text-red-400 transition-colors cursor-pointer" title="Delete">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
            </button>
          </div>
        </div>
      `;
    })
    .join('');
}

let justSwipedUntil = 0;

function insertSymbolIntoInputEl(input: HTMLInputElement | null, symbol: string) {
  if (!input) return;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);

  let nextBefore = before;
  if (symbol === '|') {
    const trimmedBefore = before.replace(/\s+$/, '');
    if (trimmedBefore && !trimmedBefore.endsWith('|')) {
      nextBefore = trimmedBefore + ' | ';
    }
  } else if (symbol === '/') {
    if (!before || /\s$/.test(before)) {
      nextBefore = before + '/ ';
    } else {
      nextBefore = before + '/';
    }
  }

  const nextAfter = after.replace(/^\s+/, '');
  input.value = nextBefore + (nextAfter ? ' ' + nextAfter : '');
  const newPos = nextBefore.length;
  try {
    input.setSelectionRange(newPos, newPos);
  } catch {}
}

function applyThemeToDOM() {
  const html = document.documentElement;
  const body = document.body;
  const icon = document.getElementById('themeIcon');
  const themeMeta = document.querySelector('meta[name="theme-color"]');

  if (state.theme === 'light') {
    html.classList.remove('dark');
    html.classList.add('light');
    if (body) {
      body.classList.remove('dark');
      body.classList.add('light');
    }
    if (themeMeta) {
      themeMeta.setAttribute('content', '#f1f5f9');
    }
    if (icon) {
      icon.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v2.25m0 13.5V21m8.966-8.966h-2.25m-13.5 0H3m15.364 6.364l-1.591-1.591M6.758 6.758L5.167 5.167m12.728 0l-1.591 1.591M6.758 17.242l-1.591 1.591M12 18a6 6 0 100-12 6 6 0 000 12z"/></svg>`;
    }
  } else {
    html.classList.remove('light');
    html.classList.add('dark');
    if (body) {
      body.classList.remove('light');
      body.classList.add('dark');
    }
    if (themeMeta) {
      themeMeta.setAttribute('content', '#030d17');
    }
    if (icon) {
      icon.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`;
    }
  }
}

// ============================================================================
// PWA INSTALL PROMPT HANDLING
// ============================================================================
let deferredInstallPrompt: BeforeInstallPromptEvent | null = null;

function setupPWAInstallUI() {
  const installBtn = document.getElementById('pwaInstallBtn');
  if (!installBtn) return;

  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true;

  if (isStandalone) {
    installBtn.classList.add('hidden');
    return;
  }

  const isIOS = /iphone|ipad|ipod/.test(window.navigator.userAgent.toLowerCase());
  if (isIOS) {
    installBtn.classList.remove('hidden');
  }

  window.addEventListener('beforeinstallprompt', (e: Event) => {
    e.preventDefault();
    deferredInstallPrompt = e as BeforeInstallPromptEvent;
    installBtn.classList.remove('hidden');
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    installBtn.classList.add('hidden');
  });
}

function setupInteractions() {
  const wrapper = document.getElementById('reharmBtnWrapper');
  const visualBtn = document.getElementById('reharmVisualBtn');
  const setPopover = document.getElementById('reharmSetPopover');
  const techPopover = document.getElementById('reharmTechniquePopover');

  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let holdTriggered = false;
  let isPointerDown = false;

  const clearHold = () => {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    if (visualBtn) {
      visualBtn.classList.remove('scale-95', 'ring-2', 'ring-sky-500', 'dark:ring-[#38bdf8]');
    }
  };

  const startHold = (e: PointerEvent) => {
    requestPersistentBrowserStorage();
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    isPointerDown = true;
    holdTriggered = false;
    if (visualBtn) {
      visualBtn.classList.add('scale-95', 'ring-2', 'ring-sky-500', 'dark:ring-[#38bdf8]');
    }
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      if (!isPointerDown) return;
      holdTriggered = true;
      if (visualBtn) {
        visualBtn.classList.remove('scale-95');
      }
      if (techPopover) {
        techPopover.classList.add('hidden');
      }
      if (setPopover) {
        setPopover.classList.remove('hidden');
      }
    }, 250);
  };

  const endHold = (e: PointerEvent) => {
    if (!isPointerDown) return;
    isPointerDown = false;
    clearHold();

    if (holdTriggered) {
      if (e && e.cancelable) e.preventDefault();
      return;
    }

    if (setPopover && !setPopover.classList.contains('hidden')) {
      setPopover.classList.add('hidden');
      return;
    }

    if (techPopover) {
      updateReharmSetUI();
      techPopover.classList.toggle('hidden');
    }
  };

  const cancelHold = () => {
    isPointerDown = false;
    clearHold();
  };

  if (visualBtn) {
    visualBtn.addEventListener('pointerdown', startHold);
    visualBtn.addEventListener('pointerup', endHold);
    visualBtn.addEventListener('pointerleave', cancelHold);
    visualBtn.addEventListener('pointercancel', cancelHold);
  }

  document.addEventListener('pointerdown', e => {
    const target = e.target as Node | null;
    const insideWrapper = wrapper && target && wrapper.contains(target);
    const insideSet = setPopover && target && setPopover.contains(target);
    const insideTech = techPopover && target && techPopover.contains(target);

    if (!insideWrapper && !insideSet && setPopover && !setPopover.classList.contains('hidden')) {
      setPopover.classList.add('hidden');
    }
    if (!insideWrapper && !insideTech && techPopover && !techPopover.classList.contains('hidden')) {
      techPopover.classList.add('hidden');
    }
  });

  // Horizontal Swipe Gesture Navigation
  let swipeStartX: number | null = null;
  let swipeStartY: number | null = null;
  let swipeLastX: number | null = null;
  let swipeLastY: number | null = null;

  const onSwipeStart = (x: number, y: number, target: EventTarget | null) => {
    const modal = document.getElementById('presetsModal');
    if (modal && !modal.classList.contains('hidden')) return;
    const iosModal = document.getElementById('iosInstallModal');
    if (iosModal && !iosModal.classList.contains('hidden')) return;
    const el = target as Element | null;
    if (el && el.closest && el.closest('input, select, textarea, #reharmSetPopover, #reharmTechniquePopover, #reharmBtnWrapper, #transportControls, #reharmModeBar')) return;
    swipeStartX = x;
    swipeStartY = y;
    swipeLastX = x;
    swipeLastY = y;
  };

  const onSwipeMove = (x: number, y: number) => {
    if (swipeStartX === null || swipeStartY === null) return;
    swipeLastX = x;
    swipeLastY = y;
  };

  const onSwipeEnd = (x: number | null, y: number | null) => {
    if (swipeStartX === null || swipeStartY === null) return;
    const endX = x !== null ? x : (swipeLastX ?? swipeStartX);
    const endY = y !== null ? y : (swipeLastY ?? swipeStartY);
    const dx = endX - swipeStartX;
    const dy = endY - swipeStartY;
    swipeStartX = null;
    swipeStartY = null;
    swipeLastX = null;
    swipeLastY = null;

    if (Math.abs(dx) > 35 && Math.abs(dx) > Math.abs(dy) * 1.1) {
      justSwipedUntil = Date.now() + 350;
      if (dx < 0 && state.currentScreen === 'generator') {
        ReharmEngine.switchScreen('saved');
      } else if (dx > 0 && state.currentScreen === 'saved') {
        ReharmEngine.switchScreen('generator');
      }
    }
  };

  document.addEventListener('touchstart', e => {
    if (e.touches && e.touches.length === 1) {
      onSwipeStart(e.touches[0].clientX, e.touches[0].clientY, e.target);
    }
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (e.touches && e.touches.length === 1) {
      onSwipeMove(e.touches[0].clientX, e.touches[0].clientY);
    }
  }, { passive: true });

  document.addEventListener('touchend', e => {
    if (e.changedTouches && e.changedTouches.length === 1) {
      onSwipeEnd(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
    } else {
      onSwipeEnd(null, null);
    }
  }, { passive: true });

  document.addEventListener('touchcancel', () => {
    onSwipeEnd(null, null);
  }, { passive: true });

  document.addEventListener('mousedown', e => {
    if (e.button === 0) onSwipeStart(e.clientX, e.clientY, e.target);
  });

  document.addEventListener('mousemove', e => {
    if (swipeStartX !== null) onSwipeMove(e.clientX, e.clientY);
  });

  document.addEventListener('mouseup', e => {
    if (e.button === 0) onSwipeEnd(e.clientX, e.clientY);
  });

  let wheelCooldownUntil = 0;
  document.addEventListener('wheel', e => {
    if (Date.now() < wheelCooldownUntil) return;
    const modal = document.getElementById('presetsModal');
    if (modal && !modal.classList.contains('hidden')) return;
    if (Math.abs(e.deltaX) > 35 && Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.4) {
      wheelCooldownUntil = Date.now() + 450;
      if (e.deltaX > 0 && state.currentScreen === 'generator') {
        ReharmEngine.switchScreen('saved');
      } else if (e.deltaX < 0 && state.currentScreen === 'saved') {
        ReharmEngine.switchScreen('generator');
      }
    }
  }, { passive: true });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      persistVault();
    } else if (document.visibilityState === 'visible') {
      syncAndHealVault();
    }
  });

  window.addEventListener('pagehide', () => {
    persistVault();
  });
}

const ReharmEngine = {
  Chord,
  TargetBackwardEngine,

  init() {
    applyThemeToDOM();
    state.baseProgression = getDefaultBaseProgression();
    const input = document.getElementById('singleProgInput') as HTMLInputElement | null;
    if (input) input.value = state.baseProgression;
    syncDefaultProgressionInputUI();
    updateReharmSetUI();
    updateMeterBadgeUI();
    updateTransportUI(false);
    setupInteractions();
    setupPWAInstallUI();
    renderOutput();
    renderSavedProgressionsList();
    syncAndHealVault();
  },

  togglePlayback() {
    if (audioEngine.getIsPlaying()) {
      audioEngine.stop();
      return;
    }
    const measures = getDisplayedMeasures();
    if (measures.length === 0) return;
    audioEngine.startProgression(measures, {
      meter: state.meter,
      onHighlight: (mIdx, cIdx) => highlightPlayingStep(mIdx, cIdx),
      onStateChange: (playing) => updateTransportUI(playing)
    });
  },

  toggleBpmPopover(e?: Event) {
    if (e) e.stopPropagation();
    const pop = document.getElementById('bpmPopover');
    if (pop) {
      updateTransportUI();
      pop.classList.toggle('hidden');
    }
  },

  setBpm(val: string | number) {
    const num = typeof val === 'number' ? val : parseInt(val, 10);
    if (!isNaN(num)) {
      audioEngine.setBpm(num);
      updateTransportUI();
    }
  },

  toggleLoop() {
    audioEngine.setIsLooping(!audioEngine.getIsLooping());
    updateTransportUI();
  },

  async triggerPWAInstall() {
    if (deferredInstallPrompt) {
      await deferredInstallPrompt.prompt();
      const { outcome } = await deferredInstallPrompt.userChoice;
      if (outcome === 'accepted') {
        deferredInstallPrompt = null;
        const btn = document.getElementById('pwaInstallBtn');
        if (btn) btn.classList.add('hidden');
      }
      return;
    }
    const iosModal = document.getElementById('iosInstallModal');
    if (iosModal) iosModal.classList.remove('hidden');
  },

  closeIOSInstallModal() {
    const iosModal = document.getElementById('iosInstallModal');
    if (iosModal) iosModal.classList.add('hidden');
  },

  switchScreen(screenName: 'generator' | 'saved') {
    state.currentScreen = screenName === 'saved' ? 'saved' : 'generator';
    const track = document.getElementById('screenTrack');
    const saveBtn = document.getElementById('saveCurrentProgBtn');

    if (state.currentScreen === 'saved') {
      if (audioEngine.getIsPlaying()) {
        audioEngine.stop();
      }
      state.activeSavedSection = null;
      state.editingSavedKey = null;
      if (track) {
        track.classList.remove('translate-x-0');
        track.classList.add('-translate-x-1/2');
      }
      if (saveBtn) saveBtn.classList.add('invisible');
      renderSavedProgressionsList();
    } else {
      if (track) {
        track.classList.remove('-translate-x-1/2');
        track.classList.add('translate-x-0');
      }
      if (saveBtn) saveBtn.classList.remove('invisible');
      renderOutput();
    }
  },

  selectReharmSet(setName: 'basic' | 'dark') {
    state.reharmSet = setName === 'dark' ? 'dark' : 'basic';
    const list = REHARM_SETS[state.reharmSet];
    const firstNonDefault = list.find(t => t.id !== 'default') || list[0];
    state.selectedTechnique = firstNonDefault.id;
    state.selectedStrategy = 'strategy1';
    state.reharmActive = state.selectedTechnique !== 'default';
    const popover = document.getElementById('reharmSetPopover');
    if (popover) popover.classList.add('hidden');
    const techPopover = document.getElementById('reharmTechniquePopover');
    if (techPopover) techPopover.classList.add('hidden');
    updateReharmSetUI();
    renderOutput();
  },

  toggleSaveCurrentProgression() {
    const normOut = normalizeProgressionString(state.lastFormattedOutput);
    if (!normOut) return;
    const inBasicIdx = state.savedSections.basic.indexOf(normOut);
    const inJazzIdx = state.savedSections.jazz.indexOf(normOut);
    const inDarkIdx = state.savedSections.dark.indexOf(normOut);

    if (inBasicIdx !== -1 || inJazzIdx !== -1 || inDarkIdx !== -1) {
      if (inBasicIdx !== -1) state.savedSections.basic.splice(inBasicIdx, 1);
      if (inJazzIdx !== -1) state.savedSections.jazz.splice(inJazzIdx, 1);
      if (inDarkIdx !== -1) state.savedSections.dark.splice(inDarkIdx, 1);
    } else {
      const targetSec: SavedSectionKey =
        state.activeSavedSection ||
        (state.reharmSet === 'dark' ? 'dark' : inferProgressionCategory(normOut));
      state.savedSections[targetSec].unshift(normOut);
    }
    persistVault();
    updateSaveButtonUI();
    renderSavedProgressionsList();
  },

  openSavedSection(secKey: SavedSectionKey) {
    if (Date.now() < justSwipedUntil) return;
    state.activeSavedSection =
      secKey === 'dark' ? 'dark' : secKey === 'jazz' ? 'jazz' : 'basic';
    state.editingSavedKey = null;
    renderSavedProgressionsList();
  },

  closeSavedSection() {
    state.activeSavedSection = null;
    state.editingSavedKey = null;
    renderSavedProgressionsList();
  },

  addSavedProgressionFromInput() {
    const input = document.getElementById('savedProgInput') as HTMLInputElement | null;
    if (!input || !input.value.trim()) return;
    applySmartInputShortcuts(input);
    const parsed = parseInputByMeasures(input.value.trim());
    const formatted = parsed.length > 0
      ? formatMeasuresToString(parsed)
      : normalizeProgressionString(input.value.trim());
    if (formatted) {
      const targetSec: SavedSectionKey =
        state.activeSavedSection ||
        (state.reharmSet === 'dark' ? 'dark' : inferProgressionCategory(formatted));
      if (!state.savedSections[targetSec].includes(formatted)) {
        state.savedSections[targetSec].unshift(formatted);
        persistVault();
      }
      state.activeSavedSection = targetSec;
    }
    input.value = '';
    renderSavedProgressionsList();
    updateSaveButtonUI();
  },

  insertSavedInputSymbol(symbol: string) {
    const input = document.getElementById('savedProgInput') as HTMLInputElement | null;
    if (!input) return;
    insertSymbolIntoInputEl(input, symbol);
    applySmartInputShortcuts(input);
  },

  loadSavedProgression(secKey: SavedSectionKey, idx: number) {
    if (Date.now() < justSwipedUntil) return;
    const sectionList = state.savedSections[secKey];
    if (!sectionList) return;
    const rawProg = sectionList[idx];
    if (!rawProg) return;
    const prog = normalizeProgressionString(rawProg);
    state.baseProgression = prog;
    state.userChangedBaseProgression = true;
    state.manualMeterOverride = false;
    state.targetMeasureIdx = null;
    state.lockedMeasures = [];
    state.selectedStrategy = 'strategy1';
    state.reharmActive = false;
    state.selectedTechnique = 'default';
    const input = document.getElementById('singleProgInput') as HTMLInputElement | null;
    if (input) input.value = prog;
    updateReharmSetUI();
    this.switchScreen('generator');
  },

  moveSavedProgression(secKey: SavedSectionKey, idx: number, direction: -1 | 1) {
    if (Date.now() < justSwipedUntil) return;
    const list = state.savedSections[secKey];
    if (!list) return;
    const targetIdx = idx + direction;
    if (targetIdx < 0 || targetIdx >= list.length) return;
    const temp = list[idx];
    list[idx] = list[targetIdx];
    list[targetIdx] = temp;
    state.editingSavedKey = null;
    persistVault();
    renderSavedProgressionsList();
  },

  startEditSavedProgression(secKey: SavedSectionKey, idx: number) {
    if (Date.now() < justSwipedUntil) return;
    state.editingSavedKey = `${secKey}:${idx}`;
    renderSavedProgressionsList();
    setTimeout(() => {
      const input = document.getElementById(`editSavedInput_${secKey}_${idx}`) as HTMLInputElement | null;
      if (input) {
        input.focus();
        const len = input.value.length;
        try {
          input.setSelectionRange(len, len);
        } catch {}
      }
    }, 10);
  },

  saveEditSavedProgression(secKey: SavedSectionKey, idx: number) {
    const input = document.getElementById(`editSavedInput_${secKey}_${idx}`) as HTMLInputElement | null;
    if (input && input.value.trim()) {
      applySmartInputShortcuts(input);
      const oldProg = state.savedSections[secKey]?.[idx];
      const parsed = parseInputByMeasures(input.value.trim());
      const formatted = parsed.length > 0
        ? formatMeasuresToString(parsed)
        : normalizeProgressionString(input.value.trim());
      if (formatted && state.savedSections[secKey]) {
        state.savedSections[secKey][idx] = formatted;
        if (oldProg) {
          const poolIdx = state.baseProgressionsPool.indexOf(oldProg);
          if (poolIdx !== -1) {
            state.baseProgressionsPool[poolIdx] = formatted;
          }
        }
        persistVault();
      }
    }
    state.editingSavedKey = null;
    renderSavedProgressionsList();
    updateSaveButtonUI();
  },

  cancelEditSavedProgression() {
    state.editingSavedKey = null;
    renderSavedProgressionsList();
  },

  deleteSavedProgression(secKey: SavedSectionKey, idx: number) {
    if (Date.now() < justSwipedUntil) return;
    if (!state.savedSections[secKey]) return;
    state.savedSections[secKey].splice(idx, 1);
    persistVault();
    renderSavedProgressionsList();
    updateSaveButtonUI();
  },

  toggleMeter() {
    state.meter = state.meter === 3 ? 4 : 3;
    state.manualMeterOverride = true;
    updateMeterBadgeUI();
    renderOutput();
  },

  insertInputSymbol(symbol: string) {
    const input = document.getElementById('singleProgInput') as HTMLInputElement | null;
    if (!input) return;
    insertSymbolIntoInputEl(input, symbol);
    this.handleInputChange();
  },

  handleModalInputFormat(inputEl: HTMLInputElement) {
    applySmartInputShortcuts(inputEl);
  },

  // Selecting a reharm category ALWAYS replaces any previous reharm and applies ONLY to state.baseProgression
  setReharmTechnique(techId: string) {
    state.selectedTechnique = techId;
    state.selectedStrategy = 'strategy1';
    state.reharmActive = techId !== 'default';
    const techPopover = document.getElementById('reharmTechniquePopover');
    if (techPopover) techPopover.classList.add('hidden');
    updateReharmSetUI();
    renderOutput();
  },

  openPresetsModal() {
    state.editingBaseIdx = null;
    renderBaseProgressionsList();
    const modal = document.getElementById('presetsModal');
    if (modal) modal.classList.remove('hidden');
  },

  closePresetsModal() {
    state.editingBaseIdx = null;
    const modal = document.getElementById('presetsModal');
    if (modal) modal.classList.add('hidden');
  },

  addBaseProgression() {
    const input = document.getElementById('newBaseProgInput') as HTMLInputElement | null;
    if (!input || !input.value.trim()) return;
    applySmartInputShortcuts(input);
    const newProg = normalizeProgressionString(input.value.trim()) || input.value.trim();
    const prevDefault = getDefaultBaseProgression();
    state.baseProgressionsPool.unshift(newProg);
    const targetSec = inferProgressionCategory(newProg);
    if (!state.savedSections[targetSec].includes(newProg)) {
      state.savedSections[targetSec].unshift(newProg);
    }
    if (!state.userChangedBaseProgression || normalizeProgressionString(state.baseProgression) === prevDefault) {
      state.baseProgression = getDefaultBaseProgression();
      const mainInput = document.getElementById('singleProgInput') as HTMLInputElement | null;
      if (mainInput) mainInput.value = state.baseProgression;
    }
    syncDefaultProgressionInputUI();
    persistVault();
    input.value = '';
    renderOutput();
    renderBaseProgressionsList();
    renderSavedProgressionsList();
  },

  moveBaseProgression(idx: number, direction: -1 | 1) {
    const targetIdx = idx + direction;
    if (targetIdx < 0 || targetIdx >= state.baseProgressionsPool.length) return;
    const temp = state.baseProgressionsPool[idx];
    state.baseProgressionsPool[idx] = state.baseProgressionsPool[targetIdx];
    state.baseProgressionsPool[targetIdx] = temp;
    state.editingBaseIdx = null;

    if (idx === 0 || targetIdx === 0) {
      state.baseProgression = getDefaultBaseProgression();
      const mainInput = document.getElementById('singleProgInput') as HTMLInputElement | null;
      if (mainInput) mainInput.value = state.baseProgression;
      syncDefaultProgressionInputUI();
      renderOutput();
    }

    persistVault();
    renderBaseProgressionsList();
    renderSavedProgressionsList();
  },

  deleteBaseProgression(idx: number) {
    if (state.baseProgressionsPool.length <= 1) return;
    const wasFirst = idx === 0;
    state.baseProgressionsPool.splice(idx, 1);
    if (wasFirst) {
      state.baseProgression = getDefaultBaseProgression();
      const mainInput = document.getElementById('singleProgInput') as HTMLInputElement | null;
      if (mainInput) mainInput.value = state.baseProgression;
      syncDefaultProgressionInputUI();
      renderOutput();
    }
    persistVault();
    renderBaseProgressionsList();
  },

  selectBaseProgression(idx: number) {
    const rawProg = state.baseProgressionsPool[idx];
    if (!rawProg) return;
    const prog = normalizeProgressionString(rawProg) || rawProg;
    state.baseProgression = prog;
    state.userChangedBaseProgression = idx !== 0;
    state.manualMeterOverride = false;
    state.targetMeasureIdx = null;
    state.lockedMeasures = [];
    state.selectedStrategy = 'strategy1';
    state.reharmActive = false;
    state.selectedTechnique = 'default';
    const input = document.getElementById('singleProgInput') as HTMLInputElement | null;
    if (input) input.value = prog;
    updateReharmSetUI();
    renderOutput();
    renderSavedProgressionsList();
    this.closePresetsModal();
  },

  startEditBaseProgression(idx: number) {
    state.editingBaseIdx = idx;
    renderBaseProgressionsList();
    setTimeout(() => {
      const input = document.getElementById(`editBaseProgInput_${idx}`) as HTMLInputElement | null;
      if (input) {
        input.focus();
        const len = input.value.length;
        try {
          input.setSelectionRange(len, len);
        } catch {}
      }
    }, 10);
  },

  saveEditBaseProgression(idx: number) {
    const input = document.getElementById(`editBaseProgInput_${idx}`) as HTMLInputElement | null;
    if (input && input.value.trim()) {
      applySmartInputShortcuts(input);
      const oldProg = state.baseProgressionsPool[idx];
      const parsed = parseInputByMeasures(input.value.trim());
      const formatted = parsed.length > 0
        ? formatMeasuresToString(parsed)
        : normalizeProgressionString(input.value.trim());
      if (formatted) {
        state.baseProgressionsPool[idx] = formatted;
        (['basic', 'jazz', 'dark'] as SavedSectionKey[]).forEach(sec => {
          const secIdx = state.savedSections[sec].indexOf(oldProg);
          if (secIdx !== -1) {
            state.savedSections[sec][secIdx] = formatted;
          }
        });
        if (idx === 0 || normalizeProgressionString(state.baseProgression) === normalizeProgressionString(oldProg)) {
          state.baseProgression = formatted;
          const mainInput = document.getElementById('singleProgInput') as HTMLInputElement | null;
          if (mainInput) mainInput.value = formatted;
          syncDefaultProgressionInputUI();
          renderOutput();
        }
        persistVault();
      }
    }
    state.editingBaseIdx = null;
    renderBaseProgressionsList();
    renderSavedProgressionsList();
  },

  cancelEditBaseProgression() {
    state.editingBaseIdx = null;
    renderBaseProgressionsList();
  },

  handleInputChange() {
    const input = document.getElementById('singleProgInput') as HTMLInputElement | null;
    if (input) {
      applySmartInputShortcuts(input);
      state.baseProgression = input.value;
      state.userChangedBaseProgression = true;
      state.manualMeterOverride = false;
      state.targetMeasureIdx = null;
      state.lockedMeasures = [];
      state.selectedStrategy = 'strategy1';
      state.reharmActive = false;
      state.selectedTechnique = 'default';
      updateReharmSetUI();
      renderOutput();
    }
  },

  // Randomize ALWAYS reharmonizes from a fresh parse of state.baseProgression
  randomize() {
    const baseMeasures = parseInputByMeasures(state.baseProgression);
    if (!baseMeasures || baseMeasures.length === 0) return;

    // If user is on Default ('default') and taps Randomize, activate the first reharm technique of the current set
    if (state.selectedTechnique === 'default') {
      const activeList = REHARM_SETS[state.reharmSet] || REHARM_SETS.basic;
      const firstTech = activeList.find(t => t.id !== 'default') || activeList[0];
      state.selectedTechnique = firstTech.id;
      updateReharmSetUI();
    }

    const allStrategies = [
      'strategy1',
      'strategy2',
      'strategy3',
      'strategy4',
      'strategy5',
      'strategy6',
      'strategy7',
      'strategy8'
    ];

    const serializeMeasures = (mList: ChordBeatItem[][]) =>
      mList.map(m => m.map(c => `${c.chord}:${c.beats}:${c.isTurnaround ? 1 : 0}`).join(',')).join('|');

    const opts = getReharmOptions();
    const currentDisplayed = state.reharmActive
      ? TargetBackwardEngine.executeReharm(
          parseInputByMeasures(state.baseProgression),
          state.selectedTechnique,
          state.selectedStrategy,
          opts
        )
      : baseMeasures;
    const currentSig = serializeMeasures(currentDisplayed);

    state.reharmActive = true;

    const uniqueMap = new Map<string, string>();
    allStrategies.forEach(strat => {
      const freshBase = parseInputByMeasures(state.baseProgression);
      const out = TargetBackwardEngine.executeReharm(
        freshBase,
        state.selectedTechnique,
        strat,
        opts
      );
      const sig = serializeMeasures(out);
      if (sig !== currentSig && !uniqueMap.has(sig)) {
        uniqueMap.set(sig, strat);
      }
    });

    const candidateStrategies = Array.from(uniqueMap.values());
    if (candidateStrategies.length > 0) {
      const picked = candidateStrategies[Math.floor(Math.random() * candidateStrategies.length)];
      state.selectedStrategy = picked;
    } else {
      state.strategyCycleIndex = (state.strategyCycleIndex + 1) % allStrategies.length;
      state.selectedStrategy = allStrategies[state.strategyCycleIndex];
    }

    renderOutput();
  },

  playChordString(chordStr: string, beats = 2) {
    if (Date.now() < justSwipedUntil) return;
    if (!chordStr) return;
    const chord = chordStr.split('→')[0].trim();
    audioEngine.playSingleChord(chord, beats, state.meter);
  },

  toggleTheme() {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    applyThemeToDOM();
    persistVault();
  }
};

declare global {
  interface Window {
    ReharmEngine: typeof ReharmEngine;
  }
}

window.ReharmEngine = ReharmEngine;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => ReharmEngine.init());
} else {
  ReharmEngine.init();
}
