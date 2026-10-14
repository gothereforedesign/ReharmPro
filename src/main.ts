import './index.css';
import { audioEngine, ElectricPianoModel, EP_MODELS, EP_MODEL_ORDER } from './audioEngine';

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
  selectedEPModel?: ElectricPianoModel;
  barsPerRow?: 1 | 2;
  isBeatActive?: boolean;
  bpm?: number;
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
    this.root = (root === 'B#' || root === 'E#' || root === 'Cb' || root === 'Fb')
      ? root
      : (useSharp ? PITCH_TO_NOTE_SHARP[pitch] : PITCH_TO_NOTE_FLAT[pitch]);
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
    } else if (rawQual.includes('m11') || rawQual.includes('min11')) {
      quality = 'm11';
    } else if (rawQual.includes('m9') || rawQual.includes('min9')) {
      quality = 'm9';
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
      this.quality === 'm9' ||
      this.quality === 'm11' ||
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

  static isCoreTwoFiveTech(techId: string): boolean {
    return (
      techId === 'standard_two_five' ||
      techId === 'tritone_two_five' ||
      techId === 'side_step_two_five' ||
      techId === 'two_five_mix_std_tri' ||
      techId === 'two_five_mix_tri_std' ||
      techId === 'two_five_mix_ss_tri'
    );
  }

  static isSideStepTwoFiveTech(techId: string): boolean {
    return (
      techId === 'side_step_two_five' ||
      techId === 'two_five_mix_ss_tri'
    );
  }

  static isTwoFiveFamilyTech(techId: string): boolean {
    return (
      this.isCoreTwoFiveTech(techId) ||
      techId === 'dorian_dark' ||
      techId === 'gothic_dominant'
    );
  }

  static isPassingBeatTech(techId: string): boolean {
    return (
      techId === 'diminished_pivot' ||
      techId === 'side_step' ||
      techId === 'side_step_above' ||
      techId === 'side_step_below' ||
      techId === 'ss_mix_ab' ||
      techId === 'ss_mix_ba' ||
      techId === 'chromatic_bass' ||
      techId === 'diminished_axis'
    );
  }

  static getSubVariantsForTechnique(techniqueId: string): string[] {
    if (techniqueId === 'tonicize' || techniqueId === 'tritone_sub') {
      return ['tonicize', 'tritone_sub', 'dom_mix_v7_bii7', 'dom_mix_bii7_v7'];
    }
    if (
      techniqueId === 'standard_two_five' ||
      techniqueId === 'tritone_two_five' ||
      techniqueId === 'side_step_two_five'
    ) {
      return [
        'standard_two_five',
        'tritone_two_five',
        'side_step_two_five',
        'two_five_mix_std_tri',
        'two_five_mix_tri_std',
        'two_five_mix_ss_tri'
      ];
    }
    if (techniqueId === 'side_step_above' || techniqueId === 'side_step_below') {
      return ['side_step_above', 'side_step_below', 'ss_mix_ab', 'ss_mix_ba'];
    }
    return [techniqueId];
  }

  static resolveSlotTechniques(techniqueId: string, rawSubVariant?: string): {
    runwayTech: string;
    turnaroundTech: string;
    phrase2SubVariant: string;
  } {
    const sv = rawSubVariant || techniqueId;
    switch (sv) {
      case 'dom_mix_v7_bii7':
        return {
          runwayTech: 'dom_mix_v7_bii7',
          turnaroundTech: 'tritone_sub',
          phrase2SubVariant: 'dom_mix_bii7_v7'
        };
      case 'dom_mix_bii7_v7':
        return {
          runwayTech: 'dom_mix_bii7_v7',
          turnaroundTech: 'tonicize',
          phrase2SubVariant: 'dom_mix_v7_bii7'
        };
      case 'two_five_mix_std_tri':
        return {
          runwayTech: 'two_five_mix_std_tri',
          turnaroundTech: 'tritone_two_five',
          phrase2SubVariant: 'two_five_mix_tri_std'
        };
      case 'two_five_mix_tri_std':
        return {
          runwayTech: 'tritone_two_five',
          turnaroundTech: 'standard_two_five',
          phrase2SubVariant: 'two_five_mix_std_tri'
        };
      case 'two_five_mix_ss_tri':
        return {
          runwayTech: 'two_five_mix_ss_tri',
          turnaroundTech: 'tritone_two_five',
          phrase2SubVariant: 'side_step_two_five'
        };
      case 'ss_mix_ab':
        return {
          runwayTech: 'ss_mix_ab',
          turnaroundTech: 'side_step_below',
          phrase2SubVariant: 'ss_mix_ba'
        };
      case 'ss_mix_ba':
        return {
          runwayTech: 'ss_mix_ba',
          turnaroundTech: 'side_step_above',
          phrase2SubVariant: 'ss_mix_ab'
        };
      default:
        return {
          runwayTech: sv,
          turnaroundTech: sv,
          phrase2SubVariant: sv
        };
    }
  }

  // --- APPROACH CELLS PER REHARM TECHNIQUE & COMBINED VARIANT ---
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
        // Pure V7 secondary dominant chain
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
        // Pure bII7 tritone substitution chain
        step1 = this.tritone_sub(targetChordX);
        step2 = this.tritone_sub(step1);
        step3 = this.tritone_sub(step2);
        step4 = this.tritone_sub(step3);
        twoChordCell = [step2, step1];
        threeChordCell = [step3, step2, step1];
        fourChordCell = [step4, step3, step2, step1];
        break;
      }

      case 'dom_mix_v7_bii7': {
        // Simultaneous Tonicization (V7) + Tritone Sub (bII7)
        const v7 = this.tonicize(targetChordX);
        const bii7 = this.tritone_sub(targetChordX);
        const v7OfBii = this.tonicize(bii7);
        const biiOfV7 = this.tritone_sub(v7);
        step1 = v7;
        step2 = biiOfV7;
        step3 = v7OfBii;
        step4 = this.tonicize(v7OfBii);
        twoChordCell = [v7OfBii, bii7];
        threeChordCell = [biiOfV7, v7OfBii, bii7];
        fourChordCell = [step4, biiOfV7, v7OfBii, bii7];
        break;
      }

      case 'dom_mix_bii7_v7': {
        // Simultaneous Tritone Sub (bII7) + Tonicization (V7)
        const v7 = this.tonicize(targetChordX);
        const bii7 = this.tritone_sub(targetChordX);
        const biiOfV7 = this.tritone_sub(v7);
        const v7OfBii = this.tonicize(bii7);
        step1 = bii7;
        step2 = v7OfBii;
        step3 = biiOfV7;
        step4 = this.tritone_sub(biiOfV7);
        twoChordCell = [biiOfV7, v7];
        threeChordCell = [v7OfBii, biiOfV7, v7];
        fourChordCell = [step4, v7OfBii, biiOfV7, v7];
        break;
      }

      case 'standard_two_five': {
        // Pure diatonic/secondary ii-V cells
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
        // Pure tritone bii7 - bII7 cells
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

      case 'two_five_mix_std_tri': {
        // Simultaneous Standard ii7 + Tritone bII7 (ii7 - bII7 & tritone ii-V -> standard ii-V)
        const v7 = this.tonicize(targetChordX);
        const ii7 = this.add_related_two(v7, isMin);
        const bII7 = this.tritone_sub(targetChordX);
        const bII7OfIi = this.tritone_sub(ii7);
        const biiOfIi = this.add_related_two(bII7OfIi, false);
        step1 = bII7;
        step2 = ii7;
        step3 = bII7OfIi;
        step4 = biiOfIi;
        twoChordCell = [ii7, bII7];
        threeChordCell = [bII7OfIi, ii7, bII7];
        fourChordCell = [biiOfIi, bII7OfIi, ii7, v7];
        break;
      }

      case 'two_five_mix_tri_std': {
        // Simultaneous Tritone bii7 + Standard V7 (bii7 - V7 & standard ii-V -> tritone ii-V)
        const v7 = this.tonicize(targetChordX);
        const bII7 = this.tritone_sub(targetChordX);
        const bii7 = this.add_related_two(bII7, false);
        const v7OfBii = this.tonicize(bii7);
        const iiOfBii = this.add_related_two(v7OfBii, true);
        step1 = v7;
        step2 = bii7;
        step3 = v7OfBii;
        step4 = iiOfBii;
        twoChordCell = [bii7, v7];
        threeChordCell = [v7OfBii, bii7, bII7];
        fourChordCell = [iiOfBii, v7OfBii, bii7, bII7];
        break;
      }

      case 'two_five_mix_ss_tri': {
        // Simultaneous Side-Step ii-V + Tritone ii-V
        const v7 = this.tonicize(targetChordX);
        const ii7 = this.add_related_two(v7, isMin);
        const bII7 = this.tritone_sub(targetChordX);
        const bii7 = this.add_related_two(bII7, false);
        const ssV = this.side_step_above(v7);
        const ssII = this.side_step_above(ii7);
        step1 = bII7;
        step2 = ii7;
        step3 = ssV;
        step4 = ssII;
        twoChordCell = [ii7, bII7];
        threeChordCell = [ssV, bii7, bII7];
        fourChordCell = [ssII, ssV, bii7, bII7];
        break;
      }

      case 'side_step_above': {
        // Pure upper chromatic side-step of identical quality
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
        // Pure lower chromatic side-step of identical quality
        step1 = this.side_step_below(targetChordX);
        step2 = this.side_step_below(step1);
        step3 = this.side_step_below(step2);
        step4 = this.side_step_below(step3);
        twoChordCell = [step2, step1];
        threeChordCell = [step3, step2, step1];
        fourChordCell = [step4, step3, step2, step1];
        break;
      }

      case 'ss_mix_ab': {
        // Simultaneous Side-Step Above + Below chromatic enclosure
        const above1 = this.side_step_above(targetChordX);
        const below1 = this.side_step_below(targetChordX);
        const above2 = this.side_step_above(above1);
        const below2 = this.side_step_below(below1);
        step1 = above1;
        step2 = below1;
        step3 = above2;
        step4 = below2;
        twoChordCell = [above1, below1];
        threeChordCell = [above2, above1, below1];
        fourChordCell = [above2, below2, above1, below1];
        break;
      }

      case 'ss_mix_ba': {
        // Simultaneous Side-Step Below + Above chromatic enclosure
        const above1 = this.side_step_above(targetChordX);
        const below1 = this.side_step_below(targetChordX);
        const above2 = this.side_step_above(above1);
        const below2 = this.side_step_below(below1);
        step1 = below1;
        step2 = above1;
        step3 = below2;
        step4 = above2;
        twoChordCell = [below1, above1];
        threeChordCell = [below2, below1, above1];
        fourChordCell = [below2, above2, below1, above1];
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
    const isTwoFiveTech = this.isCoreTwoFiveTech(techniqueId);

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
        if (this.isSideStepTwoFiveTech(techniqueId) && subStyle === 'beats234_walk') {
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
    const isPassingBeatTechnique = this.isPassingBeatTech(techniqueId);
    const isTwoFiveFamily =
      this.isTwoFiveFamilyTech(techniqueId) ||
      techniqueId === 'circle_of_fifths' ||
      techniqueId === 'backdoor' ||
      techniqueId === 'neapolitan_slide' ||
      techniqueId === 'chromatic_mediant';

    const isCoreTwoFive = this.isCoreTwoFiveTech(techniqueId);

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
    const [baseStrategy, rawSubVariant] = (strategy || 'strategy1').split('@');
    const { runwayTech, turnaroundTech } = this.resolveSlotTechniques(techniqueId, rawSubVariant);
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

    const isTwoFiveFamily = this.isTwoFiveFamilyTech(runwayTech);

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
        if (baseStrategy === 'strategy2') subStyle = 'beat4_pickup';
        else if (baseStrategy === 'strategy3') subStyle = 'beats34_two_chord';
        else if (baseStrategy === 'strategy4') subStyle = 'beats234_walk';
      } else {
        switch (baseStrategy) {
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
        const barTech = (mIdx === numMeasures - 1 || mIdx % 2 === 1) ? turnaroundTech : runwayTech;
        if (mIdx === numMeasures - 1 && !options.disableTurnaround) {
          this.applyTurnaroundToFinalBar(
            measureBeatGrids[mIdx],
            measures[mIdx],
            options.loopTargetChord || nextChord,
            barTech,
            subStyle === 'beat4_pickup' ? 'beat4_pickup' : 'auto'
          );
        } else {
          this.insertPassingIntoBar(
            measureBeatGrids[mIdx],
            measures[mIdx],
            nextChord,
            barTech,
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

    const [baseStrategy, rawSubVariant] = (strategy || 'strategy1').split('@');
    const { runwayTech, turnaroundTech } = this.resolveSlotTechniques(techniqueId, rawSubVariant);

    // Default to autonomous HYBRID arrangement (combines Passing Chords on static bars + Approach Chains before Target X)
    const mode: ReharmMode = options.mode || 'HYBRID';
    const density: ReharmDensity = options.density || 'BALANCED';
    const lockedSet = new Set(options.lockedMeasures || []);

    if (mode === 'PASSING_ONLY') {
      return this.reharmonizePassingMode(measures, techniqueId, strategy, options);
    }

    // Strategy 4 in autonomous HYBRID mode acts as "Card 1 (Subtle Passing)":
    // Keeps the ending as-is and adds light internal passing chords on Beats 3-4 before changes
    if (mode === 'HYBRID' && !options.targetIndex && baseStrategy === 'strategy4') {
      const passStrategy = rawSubVariant ? `strategy1@${rawSubVariant}` : 'strategy1';
      return this.reharmonizePassingMode(measures, techniqueId, passStrategy, options);
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
      (baseStrategy === 'strategy2' || baseStrategy === 'strategy5')
    ) {
      const isPassingBeatTechnique = this.isPassingBeatTech(turnaroundTech);
      if (baseStrategy === 'strategy5' && numMeasures >= 3 && !lockedSet.has(0)) {
        const bar1Target = measureBeatGrids[1]?.[0]?.chord;
        if (bar1Target) {
          this.insertPassingIntoBar(
            measureBeatGrids[0],
            measures[0],
            bar1Target,
            runwayTech,
            'beats34_two_chord'
          );
        }
      }
      const turnStyle =
        baseStrategy === 'strategy2'
          ? 'auto'
          : (isPassingBeatTechnique ? 'two_chord' : 'beat4_pickup');
      this.applyTurnaroundToFinalBar(
        measureBeatGrids[finalMIdx],
        measures[finalMIdx],
        loopDestinationChord,
        baseStrategy === 'strategy2' ? runwayTech : turnaroundTech,
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
      baseStrategy === 'strategy8'
    ) {
      targetMIdx = numMeasures - 1;
    }

    const targetGrid = measureBeatGrids[targetMIdx];
    if (!targetGrid || targetGrid.length === 0) return measures;

    const targetChordX = targetGrid[0].chord;
    const approach = this.getApproachChords(targetChordX, runwayTech);
    const { step1, step2, step3, step4, twoChordCell, threeChordCell, fourChordCell } = approach;
    const isTwoFiveFamily = this.isTwoFiveFamilyTech(runwayTech);

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
            runwayTech,
            baseStrategy === 'strategy2' ? 'beat4_pickup' : 'auto'
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
        runwayTech,
        subMap[baseStrategy] || 'beats34_two_chord'
      );

      // On 2-bar loops, include turnaround in Bar 2 back to Bar 1 on turnaround strategies
      if (
        numMeasures === 2 &&
        canTurnaroundFinalBar &&
        (baseStrategy === 'strategy1' || baseStrategy === 'strategy6' || baseStrategy === 'strategy8')
      ) {
        this.applyTurnaroundToFinalBar(
          measureBeatGrids[1],
          measures[1],
          loopDestinationChord,
          turnaroundTech,
          baseStrategy === 'strategy6' ? 'beat4_pickup' : 'auto'
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
      const isSideStepTwoFive = this.isSideStepTwoFiveTech(runwayTech);

      // Determine if this strategy is in the 20% limited replacement tier
      const isReplacementStrategy = baseStrategy === 'strategy7' || baseStrategy === 'strategy8';

      const applyOneBarRunway = (strat: string) => {
        // --- 20% LIMITED REPLACEMENT TIER (strategy7 & strategy8) ---
        if (isReplacementStrategy) {
          if (strat === 'strategy7') {
            // Replace the single runway chord with the cadence approach cell
            this.fillBarBeats(
              barR1,
              isSideStepTwoFive
                ? fourChordCell
                : (isTwoFiveFamily || runwayTech === 'circle_of_fifths' ? twoChordCell : singleStepCell),
              'standard'
            );
          } else {
            // Strategy 8: Full cadence walk replacement
            this.fillBarBeats(barR1, barR1.length === 3 ? threeChordCell : fourChordCell, 'standard');
          }
          return;
        }

        // --- 80% CHORD-PRESERVED TIER (strategy1..strategy6) ---
        // Every chord listed in the input is preserved in its measure!
        // The beats change around it to fit passing and in-between chords.
        if (origR1Chord && barR1.length >= 4) {
          if (strat === 'strategy1') {
            // Preserved base chord on Beats 1 & 2, approach on Beats 3 & 4
            this.fillBarBeats(
              barR1,
              isTwoFiveFamily
                ? [origR1Chord, twoChordCell[0], twoChordCell[1]]
                : [origR1Chord, step1],
              'standard'
            );
          } else if (strat === 'strategy2') {
            // Preserved base chord on Beats 1..3, approach pickup on Beat 4
            this.fillBarBeats(barR1, [origR1Chord, step1], 'late');
          } else if (strat === 'strategy3') {
            // Preserved base chord on Beats 1 & 2, 2-chord approach cell on Beats 3 & 4
            this.fillBarBeats(barR1, [origR1Chord, twoChordCell[0], twoChordCell[1]], 'standard');
          } else if (strat === 'strategy4') {
            // Preserved base chord on Beats 1..3, late pickup on Beat 4
            this.fillBarBeats(barR1, [origR1Chord, step1], 'late');
          } else if (strat === 'strategy5') {
            // Preserved base chord on Beats 1 & 2, approach on Beats 3 & 4
            this.fillBarBeats(barR1, [origR1Chord, step1], 'standard');
          } else {
            // Strategy 6: Preserved base chord on Beat 1, 3-step passing walk on Beats 2, 3, 4
            this.fillBarBeats(barR1, [origR1Chord, step3, step2, step1], 'standard');
          }
        } else if (origR1Chord && barR1.length === 3) {
          // 3/4 meter: base chord on Beats 1 & 2, passing pickup on Beat 3
          this.fillBarBeats(barR1, [origR1Chord, step1], 'late');
        } else {
          this.fillBarBeats(barR1, twoChordCell, 'standard');
        }
      };

      // In earlier measures (r2Idx, r3Idx):
      // ALWAYS keep original chords! Insert passing movement into next bar.
      if (r2Idx >= 0 && !lockedSet.has(r2Idx)) {
        const barR2 = measureBeatGrids[r2Idx];
        if (barR2 && barR2.length >= 2) {
          this.insertPassingIntoBar(
            barR2,
            measures[r2Idx],
            origR1Chord,
            turnaroundTech,
            baseStrategy === 'strategy2' || baseStrategy === 'strategy4' ? 'beat4_pickup' : 'beats34_two_chord'
          );
        }
      }
      if (r3Idx >= 0 && !lockedSet.has(r3Idx)) {
        const barR3 = measureBeatGrids[r3Idx];
        const nextChordR2 = measureBeatGrids[r2Idx]?.[0]?.chord;
        if (barR3 && barR3.length >= 2 && nextChordR2) {
          this.insertPassingIntoBar(
            barR3,
            measures[r3Idx],
            nextChordR2,
            runwayTech,
            'beat4_pickup'
          );
        }
      }

      // Apply runway approach to r1Idx
      applyOneBarRunway(baseStrategy);
    }

    // =========================================================================
    // RULE 3: AUTONOMOUS PASSING CHORDS ON INTERNAL / STATIC HELD BARS
    // Changes the beats around the existing chords by inserting passing and
    // in-between chords leading into the next chord
    // =========================================================================
    if (mode === 'HYBRID') {
      for (let mIdx = 0; mIdx < numMeasures - 1; mIdx++) {
        if (mIdx === targetMIdx || mIdx === r1Idx || mIdx === r2Idx || mIdx === r3Idx || lockedSet.has(mIdx)) continue;

        const nextMIdx = mIdx + 1;
        const nextChord = measureBeatGrids[nextMIdx]?.[0]?.chord;
        const curChord = measureBeatGrids[mIdx]?.[0]?.chord;
        if (!nextChord || !curChord) continue;

        // Skip awkward diminished resolution chords, otherwise insert passing movement
        if (nextChord.quality === 'm7b5' || nextChord.quality === '°7') {
          continue;
        }

        const hybridSubStyle: 'beat4_pickup' | 'beats34_single' | 'beats34_two_chord' =
          baseStrategy === 'strategy2' || baseStrategy === 'strategy4'
            ? 'beat4_pickup'
            : isTwoFiveFamily
              ? 'beats34_two_chord'
              : density === 'SPARSE'
                ? 'beat4_pickup'
                : 'beats34_two_chord';

        this.insertPassingIntoBar(
          measureBeatGrids[mIdx],
          measures[mIdx],
          nextChord,
          turnaroundTech,
          hybridSubStyle
        );
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
      (baseStrategy === 'strategy1' || baseStrategy === 'strategy6' || baseStrategy === 'strategy8')
    ) {
      const turnStyle = baseStrategy === 'strategy6' ? 'two_chord' : 'auto';
      this.applyTurnaroundToFinalBar(
        measureBeatGrids[finalMIdx],
        measures[finalMIdx],
        loopDestinationChord,
        turnaroundTech,
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

  /**
   * Adapts a progression to minor specifically for dark reharmonization techniques:
   * "For the dark reharm techniques, I understand if a major progression is being altered,
   * the key needs be minor. Those progressions can have their base chords altered to fit
   * the correct chord quality for this reharm techniques specifically"
   */
  static adaptProgressionForDarkTechnique(
    measures: ChordBeatItem[][],
    techniqueId: string
  ): ChordBeatItem[][] {
    if (!measures || measures.length === 0) return measures;

    const firstItem = measures[0]?.[0];
    if (!firstItem || !firstItem.chord) return measures;

    const firstChord = Chord.fromSymbol(firstItem.chord);
    const tonicRoot = firstChord.root;

    // Palettes for the tonic key
    const pal = this.buildDarkPalette(tonicRoot);

    return measures.map((meas, mIdx) => {
      return meas.map((item, cIdx) => {
        if (!item.chord) return { ...item };
        const cObj = Chord.fromSymbol(item.chord);
        const pitchDiff = ((NOTE_TO_PITCH[cObj.root] ?? 0) - (NOTE_TO_PITCH[tonicRoot] ?? 0) + 12) % 12;

        let adaptedChord: Chord = cObj;

        switch (techniqueId) {
          case 'dorian_dark': {
            // Dorian: 1 (i), 2 (ii), b3 (bIII), 4 (IV), 5 (v), 6 (vi°), b7 (bVII)
            // Hallmark: Minor tonic (im, im7, im6), Major/Dominant IV chord (IV, IV7)
            if (pitchDiff === 0) {
              adaptedChord = mIdx === 0 && cIdx === 0 ? pal.im7 : pal.i;
            } else if (pitchDiff === 2) {
              adaptedChord = pal.ii7;
            } else if (pitchDiff === 4) {
              const b3Root = this.transpose(tonicRoot, 3, false);
              adaptedChord = new Chord(b3Root, 'maj7', null, false);
            } else if (pitchDiff === 5) {
              // Hallmark Dorian IV is Major / Dominant 7th due to the natural 6th!
              adaptedChord = cObj.quality.includes('7') ? pal.IV7 : pal.IV;
            } else if (pitchDiff === 7) {
              // Minor v7
              const vRoot = this.transpose(tonicRoot, 7, false);
              adaptedChord = new Chord(vRoot, 'm7', null, false);
            } else if (pitchDiff === 9) {
              // Degree 6: Dorian bVII (F in G) or ii7
              const b7Root = this.transpose(tonicRoot, 10, false);
              adaptedChord = new Chord(b7Root, 'maj', null, false);
            } else if (pitchDiff === 11) {
              // Degree 7: Dorian bVII7
              const b7Root = this.transpose(tonicRoot, 10, false);
              adaptedChord = new Chord(b7Root, '7', null, false);
            } else if (!cObj.isMinorTarget() && pitchDiff !== 5) {
              adaptedChord = new Chord(cObj.root, 'm', null, cObj.preferSharps);
            }
            break;
          }

          case 'chromatic_mediant': {
            // Strictly Chromatic Mediants (i, bvi, biii, bVI, bVI+)
            if (pitchDiff === 0) {
              adaptedChord = pal.i;
            } else if (pitchDiff === 7) {
              adaptedChord = pal.bvi;
            } else if (pitchDiff === 9 || pitchDiff === 8) {
              adaptedChord = pal.bVI;
            } else if (pitchDiff === 5) {
              adaptedChord = new Chord(cObj.root, 'm', null, false);
            } else if (pitchDiff === 2 || pitchDiff === 3 || pitchDiff === 4) {
              adaptedChord = pal.biii;
            } else if (!cObj.isMinorTarget()) {
              adaptedChord = new Chord(cObj.root, 'm', null, cObj.preferSharps);
            }
            break;
          }

          case 'gothic_dominant': {
            // Strictly Harmonic Minor & Altered Gothic Dominants (i, im(maj7), ivm6, iiø, bVI+, V7(b9), V7+)
            if (pitchDiff === 0) {
              adaptedChord = mIdx === 0 && cIdx === 0 ? pal.imMaj7 : pal.i;
            } else if (pitchDiff === 7) {
              adaptedChord = pal.V7b9;
            } else if (pitchDiff === 5) {
              adaptedChord = pal.ivMin6;
            } else if (pitchDiff === 2) {
              adaptedChord = pal.iiHalf;
            } else if (pitchDiff === 9 || pitchDiff === 8) {
              adaptedChord = pal.bVIaug;
            } else if (pitchDiff === 11) {
              adaptedChord = pal.viiDim7;
            } else if (pitchDiff === 4 || pitchDiff === 3) {
              const b3Root = this.transpose(tonicRoot, 3, false);
              adaptedChord = new Chord(b3Root, 'maj', null, false);
            } else if (!cObj.isMinorTarget()) {
              adaptedChord = new Chord(cObj.root, 'm', null, cObj.preferSharps);
            }
            break;
          }

          case 'neapolitan_slide': {
            // Strictly Phrygian / Neapolitan half-step motion (i, bII, biim, bII7)
            if (pitchDiff === 0) {
              adaptedChord = pal.i;
            } else if (pitchDiff === 1) {
              adaptedChord = pal.bII;
            } else if (pitchDiff === 7) {
              adaptedChord = pal.bII7;
            } else if (pitchDiff === 5) {
              adaptedChord = new Chord(cObj.root, 'm', null, false);
            } else if (pitchDiff === 9 || pitchDiff === 8) {
              adaptedChord = pal.bII;
            } else if (pitchDiff === 2) {
              adaptedChord = pal.biim;
            } else if (!cObj.isMinorTarget()) {
              adaptedChord = new Chord(cObj.root, 'm', null, cObj.preferSharps);
            }
            break;
          }

          case 'diminished_axis': {
            // Strictly Diminished 7th & Augmented Axis (#i°7, #iv°7, vii°7, V+, i)
            if (pitchDiff === 0) {
              adaptedChord = pal.i;
            } else if (pitchDiff === 7) {
              adaptedChord = pal.Vaug;
            } else if (pitchDiff === 5 || pitchDiff === 6) {
              adaptedChord = pal.sh4Dim7;
            } else if (pitchDiff === 2 || pitchDiff === 1) {
              adaptedChord = pal.sh1Dim7;
            } else if (pitchDiff === 11) {
              adaptedChord = pal.viiDim7;
            } else if (pitchDiff === 9 || pitchDiff === 8) {
              adaptedChord = pal.sh4Dim7;
            } else if (!cObj.isMinorTarget()) {
              adaptedChord = new Chord(cObj.root, 'm', null, cObj.preferSharps);
            }
            break;
          }

          case 'elfman_modulation':
          default: {
            // Strictly Restless Key Modulations & Minor Line Cliché (m -> m(maj7) -> m7 -> m6)
            if (pitchDiff === 0) {
              adaptedChord = pal.imMaj7;
            } else if (pitchDiff === 5) {
              adaptedChord = pal.i6;
            } else if (pitchDiff === 7) {
              const vRoot = this.transpose(tonicRoot, 7, false);
              adaptedChord = new Chord(vRoot, 'm7', null, false);
            } else if (pitchDiff === 9 || pitchDiff === 8) {
              adaptedChord = pal.im7;
            } else if (pitchDiff === 2 || pitchDiff === 3) {
              const b3Root = this.transpose(tonicRoot, 3, false);
              adaptedChord = new Chord(b3Root, 'm(maj7)', null, false);
            } else if (!cObj.isMinorTarget()) {
              adaptedChord = new Chord(cObj.root, 'm', null, cObj.preferSharps);
            }
            break;
          }
        }

        if (cObj.bass) {
          adaptedChord = new Chord(adaptedChord.root, adaptedChord.quality, cObj.bass, adaptedChord.preferSharps);
        }

        return {
          ...item,
          chord: adaptedChord.toString()
        };
      });
    });
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

    const isReplacementStrategy = strategy === 'strategy7' || strategy === 'strategy8';
    const b0Seq = bar0Choices[strategy] || bar0Choices.strategy1;
    const b1Seq = bar1Choices[strategy] || bar1Choices.strategy1;
    const b2Seq = bar2Choices[strategy] || bar2Choices.strategy1;

    const fillBarWithDark = (grid: BeatSlot[], mIdx: number, seq: Chord[]) => {
      const origSym = measures[mIdx]?.[0]?.chord;
      if (!isReplacementStrategy && origSym && grid.length >= 4) {
        const origChord = Chord.fromSymbol(origSym);
        this.fillBarBeats(grid, [origChord, ...seq.slice(-2)], 'standard');
      } else if (!isReplacementStrategy && origSym && grid.length === 3) {
        const origChord = Chord.fromSymbol(origSym);
        this.fillBarBeats(grid, [origChord, seq[seq.length - 1]], 'late');
      } else {
        this.fillBarBeats(grid, seq, 'standard');
      }
    };

    if (targetMIdx >= 3) {
      if (!lockedSet.has(targetMIdx - 3)) fillBarWithDark(measureBeatGrids[targetMIdx - 3], targetMIdx - 3, b0Seq);
      if (!lockedSet.has(targetMIdx - 2)) fillBarWithDark(measureBeatGrids[targetMIdx - 2], targetMIdx - 2, b1Seq);
      if (!lockedSet.has(targetMIdx - 1)) fillBarWithDark(measureBeatGrids[targetMIdx - 1], targetMIdx - 1, b2Seq);
      if (!lockedSet.has(targetMIdx)) {
        if (!isReplacementStrategy && measures[targetMIdx]?.[0]?.chord) {
          const origTarg = Chord.fromSymbol(measures[targetMIdx][0].chord);
          this.fillBarBeats(measureBeatGrids[targetMIdx], [origTarg, pal.imMaj7], 'standard');
        } else {
          this.fillDarkTargetBar(measureBeatGrids[targetMIdx], H, techniqueId, strategy);
        }
      }
    } else if (targetMIdx === 2) {
      if (!lockedSet.has(0)) fillBarWithDark(measureBeatGrids[0], 0, b0Seq);
      if (!lockedSet.has(1)) fillBarWithDark(measureBeatGrids[1], 1, b2Seq);
      if (!lockedSet.has(2)) {
        if (!isReplacementStrategy && measures[2]?.[0]?.chord) {
          const origTarg = Chord.fromSymbol(measures[2][0].chord);
          this.fillBarBeats(measureBeatGrids[2], [origTarg, pal.imMaj7], 'standard');
        } else {
          this.fillDarkTargetBar(measureBeatGrids[2], H, techniqueId, strategy);
        }
      }
    } else if (targetMIdx === 1) {
      const combinedBar0 = b0Seq.length === 1 && b1Seq.length >= 1
        ? [b0Seq[0], b1Seq[0], ...(b2Seq.slice(-1))]
        : b2Seq;
      if (!lockedSet.has(0)) fillBarWithDark(measureBeatGrids[0], 0, combinedBar0);
      if (!lockedSet.has(1)) {
        if (!isReplacementStrategy && measures[1]?.[0]?.chord) {
          const origTarg = Chord.fromSymbol(measures[1][0].chord);
          this.fillBarBeats(measureBeatGrids[1], [origTarg, pal.imMaj7], 'standard');
        } else {
          this.fillDarkTargetBar(measureBeatGrids[1], H, techniqueId, strategy);
        }
      }
    } else {
      if (!lockedSet.has(0)) fillBarWithDark(measureBeatGrids[0], 0, [b0Seq[0], ...b2Seq.slice(-2)]);
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
    if (this.isDarkTechnique(techniqueId)) {
      const lockedSet = new Set(options.lockedMeasures || []);
      const targetMIdx = this.resolveTargetMeasureIndex(measures.length, options.targetIndex);
      if (mode === 'FULL_REFRAME') {
        return this.reharmonizeProgressionDarkWithLocks(measures, techniqueId, strategy, lockedSet, targetMIdx);
      }
      return this.reharmonizeProgressionBackward(measures, techniqueId, strategy, options);
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

    // Adapt major progressions to minor specifically for dark reharm techniques
    const effectiveMeasures = this.isDarkTechnique(techniqueId)
      ? this.adaptProgressionForDarkTechnique(measures, techniqueId)
      : measures;

    const hasExplicitTarget =
      options.targetIndex !== undefined &&
      options.targetIndex !== null &&
      options.targetIndex >= 0 &&
      options.targetIndex < effectiveMeasures.length;

    if (!hasExplicitTarget && effectiveMeasures.length > 4) {
      let splitIdx = Math.ceil(effectiveMeasures.length / 2);
      if (effectiveMeasures.length === 9) {
        splitIdx = 3;
      } else if (effectiveMeasures.length % 4 === 0) {
        splitIdx = 4;
      } else if (effectiveMeasures.length > 8) {
        splitIdx = 4;
      }

      const [baseStrat, rawSubVariant] = (strategy || 'strategy1').split('@');
      const { phrase2SubVariant } = this.resolveSlotTechniques(techniqueId, rawSubVariant);
      const restStrategy = rawSubVariant ? `${baseStrat}@${phrase2SubVariant}` : strategy;

      const locked = options.lockedMeasures || [];
      const firstLocks = locked.filter(m => m < splitIdx);
      const restLocks = locked.filter(m => m >= splitIdx).map(m => m - splitIdx);
      const rootHomeChord = options.loopTargetChord || Chord.fromSymbol(effectiveMeasures[0][0].chord);

      const firstPart = this.executeReharm(
        effectiveMeasures.slice(0, splitIdx),
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
        effectiveMeasures.slice(splitIdx),
        techniqueId,
        restStrategy,
        {
          ...options,
          targetIndex: null,
          lockedMeasures: restLocks,
          loopTargetChord: rootHomeChord
        }
      );
      return [...firstPart, ...restPart];
    }
    return this.executeSinglePhraseReharm(effectiveMeasures, techniqueId, strategy, options);
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

const DEFAULT_BASIC_PROGRESSIONS = [
  "G | D | Em | C",
  "F | Gm | C | F",
  "Bb7 | Eb7 | Bb7 | F7",
  "C | Bb | F | Ab",
  "D | Em | F#m | G | A | Bm | C#dim | C#dim",
  "Am | Bdim | C | Dm | Em | F | G | G",
  "Dm | C | Bb | A7",
  "D | A | Bm | F#m | G | D | G | A",
  "F | F/A | Bb | Bdim7 | F/C | C7 | F | F"
];

const DEFAULT_JAZZ_PROGRESSIONS = [
  "Fm7 | Bb7 | Ebmaj7 | Ebmaj7",
  "Abmaj7 | Fm7 | Bbm7 | Eb7",
  "Emaj7 | Gmaj7 | Bbmaj7 | Dbmaj7",
  "Amaj7 | A#dim7 | Bm7 | B#dim7 | C#m7 | C#m7",
  "Cm | Cm(maj7) | Cm7 | Cm6",
  "Dbmaj7 | Gbm7 | B7 | Dbmaj7",
  "F#m11 | Em11 | F#m11 | Em11",
  "Ebmaj7 | Abmaj7 | Dm7b5 | Gm7 | Cm7 | Fm7 | Bb7 | Ebmaj7"
];

const DEFAULT_SAVED_PROGRESSIONS = [
  "Em | F | Em | F",
  "C#m | Ebm | C#m | C#m",
  "Dm | C | Bb | A7",
  "Fm | Ab+ | Bbm | C7",
  "Gm | C | Gm | Gm",
  "Bm | F | Bm | F",
  "C | Ab | Eb | Bb"
];

const DEFAULT_PROGRESSIONS = [
  ...DEFAULT_BASIC_PROGRESSIONS,
  ...DEFAULT_JAZZ_PROGRESSIONS,
  ...DEFAULT_SAVED_PROGRESSIONS
];

// Maps odd-measure default progressions to their even-measure versions
const LEGACY_DEFAULT_ODD_TO_EVEN_MAP: Record<string, string> = {
  "D | Em | F#m | G | A | Bm | C#dim": "D | Em | F#m | G | A | Bm | C#dim | C#dim",
  "Am | Bdim | C | Dm | Em | F | G": "Am | Bdim | C | Dm | Em | F | G | G",
  "Fm7 | Bb7 | Ebmaj7": "Fm7 | Bb7 | Ebmaj7 | Ebmaj7",
  "Amaj7 | A#dim7 | Bm7 | B#dim7 | C#m7": "Amaj7 | A#dim7 | Bm7 | B#dim7 | C#m7 | C#m7",
  "F | F/A | Bb | Bdim7 | F/C | C7": "F | F/A | Bb | Bdim7 | F/C | C7 | F | F"
};

// ============================================================================
// 3-LAYER SELF-HEALING PERSISTENT STORAGE VAULT
// Simultaneously persists across:
//   1. localStorage ('reharmpro_vault_v2')
//   2. IndexedDB ('ReharmProVaultDB_v2' -> 'vault')
//   3. Cache Storage ('reharmpro-vault-cache-v2' -> '/__reharmpro_vault_v2__.json')
// plus navigator.storage.persist() so the browser never evicts or resets user data.
// ============================================================================
const VAULT_LS_KEY = 'reharmpro_vault_v2';
const VAULT_IDB_NAME = 'ReharmProVaultDB_v2';
const VAULT_IDB_STORE = 'vault';
const VAULT_CACHE_NAME = 'reharmpro-vault-cache-v2';
const VAULT_CACHE_URL = '/__reharmpro_vault_v2__.json';

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

function updateEPPopoverUI() {
  const popover = document.getElementById('epPopover');
  if (!popover) return;

  const currentModel = state.selectedEPModel || audioEngine.getModel();

  popover.innerHTML = EP_MODEL_ORDER.map(modelKey => {
    const info = EP_MODELS[modelKey];
    const isSelected = modelKey === currentModel;
    const itemCls = isSelected
      ? 'bg-sky-600 text-white dark:bg-[#0c4a6e] dark:text-[#38bdf8]'
      : 'text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#0c4a6e]/40';

    return `
      <button type="button" onclick="window.ReharmEngine.selectEPModel('${modelKey}')" class="w-full px-3 py-2 rounded-[7px] flex items-center justify-between gap-2 text-xs font-mono-tabular font-extrabold transition-colors cursor-pointer text-left ${itemCls}">
        <div class="flex flex-col min-w-0">
          <span class="truncate font-black">${info.name}</span>
          <span class="text-[10px] opacity-80 truncate font-normal">${info.description}</span>
        </div>
        <span class="text-[11px] font-black uppercase tracking-wider shrink-0 px-1.5 py-0.5 rounded bg-black/10 dark:bg-white/10">${info.badge}</span>
      </button>
    `;
  }).join('');
}

function updateTransportUI(isPlaying = audioEngine.getIsPlaying()) {
  const playBtn = document.getElementById('playProgBtn');
  const playIcon = document.getElementById('playProgIcon');
  const playLabel = document.getElementById('playProgLabel');
  const tempoBtn = document.getElementById('tempoCycleBtn');
  const tempoBadge = document.getElementById('tempoBadgeText');
  const loopBtn = document.getElementById('loopToggleBtn');
  const epBtn = document.getElementById('epSelectorBtn');
  const epBadge = document.getElementById('epBadgeText');
  const beatBtn = document.getElementById('beatToggleBtn');

  if (playBtn && playIcon) {
    if (isPlaying) {
      playBtn.className = 'col-span-1 py-3 px-2 bg-sky-50 dark:bg-[#0c4a6e]/80 border border-sky-500/40 dark:border-[#38bdf8]/50 rounded-[8px] text-sky-600 dark:text-[#38bdf8] shadow-sm transition-all cursor-pointer active:scale-95 flex items-center justify-center gap-1 font-mono-tabular text-xs font-black select-none';
      playIcon.innerHTML = `<svg class="w-4 h-4 fill-current" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;
      if (playLabel) playLabel.textContent = 'Stop';
      playBtn.setAttribute('title', 'Stop playback (Space)');
    } else {
      playBtn.className = 'col-span-1 py-3 px-2 bg-white dark:bg-[#071d2c] hover:bg-slate-50 dark:hover:bg-[#0c4a6e]/50 border border-slate-300/90 dark:border-[#0c4a6e]/70 rounded-[8px] text-slate-700 dark:text-slate-200 hover:text-sky-600 dark:hover:text-[#38bdf8] shadow-sm transition-all cursor-pointer active:scale-95 flex items-center justify-center gap-1 font-mono-tabular text-xs font-black select-none';
      playIcon.innerHTML = `<svg class="w-4 h-4 fill-current" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`;
      if (playLabel) playLabel.textContent = 'Play';
      playBtn.setAttribute('title', 'Play progression (Space)');
    }
  }

  const bpm = audioEngine.getBpm();
  if (tempoBadge) {
    tempoBadge.textContent = `${bpm} BPM`;
  }
  if (tempoBtn) {
    tempoBtn.setAttribute('title', `Tempo: ${bpm} BPM (Tap to cycle: 60, 70, 80, 90, 100, 110, 120 | Press T)`);
  }

  const currentModel = state.selectedEPModel || audioEngine.getModel();
  const epInfo = EP_MODELS[currentModel] || EP_MODELS.rhodes;

  if (epBadge) {
    epBadge.textContent = epInfo.badge;
  }
  if (epBtn) {
    epBtn.title = `Keys: ${epInfo.name} (${epInfo.description}) — Tap to cycle | Hold for styles | Press K`;
  }

  if (loopBtn) {
    if (audioEngine.getIsLooping()) {
      loopBtn.className = 'w-full py-2.5 px-1 sm:px-2 cursor-pointer active:scale-95 transition-all flex items-center justify-center gap-1 select-none text-sky-600 dark:text-[#38bdf8] bg-sky-500/10 dark:bg-[#0c4a6e]/60';
      loopBtn.title = 'Repeat: ON (Tap to toggle loop | Press L)';
    } else {
      loopBtn.className = 'w-full py-2.5 px-1 sm:px-2 cursor-pointer active:scale-95 transition-all flex items-center justify-center gap-1 select-none text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-300 hover:bg-slate-100/50 dark:hover:bg-[#0c4a6e]/20';
      loopBtn.title = 'Repeat: OFF (Tap to toggle loop | Press L)';
    }
  }

  if (beatBtn) {
    if (audioEngine.isBeatEnabled()) {
      beatBtn.className = 'w-full py-2.5 px-1 sm:px-2 cursor-pointer active:scale-95 transition-all flex items-center justify-center gap-1 select-none text-sky-600 dark:text-[#38bdf8] bg-sky-500/10 dark:bg-[#0c4a6e]/60';
      beatBtn.title = 'Drums: ACTIVE (Tap to mute | Press B)';
    } else {
      beatBtn.className = 'w-full py-2.5 px-1 sm:px-2 cursor-pointer active:scale-95 transition-all flex items-center justify-center gap-1 select-none text-slate-400 hover:text-slate-700 dark:text-slate-500 dark:hover:text-slate-300 hover:bg-slate-100/50 dark:hover:bg-[#0c4a6e]/20';
      beatBtn.title = 'Drums: MUTED (Tap to activate | Press B)';
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
    { id: 'tonicize', name: 'Tonicization / Tritone Sub', icon: 'V⁷/♭II⁷' },
    { id: 'standard_two_five', name: 'ii-V (Std / Tritone / SS)', icon: 'ii-V⁷' },
    { id: 'side_step_above', name: 'Side-Step (Above / Below)', icon: '↑↓' },
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

  if (
    !rawSections ||
    !Array.isArray(rawSections.basic) ||
    !Array.isArray(rawSections.jazz) ||
    !Array.isArray(rawSections.dark)
  ) {
    return {
      sections: {
        basic: dedupeProgressions(defaultBasic),
        jazz: dedupeProgressions(defaultJazz),
        dark: dedupeProgressions(defaultDark)
      },
      didMigrateJazzSplit: false
    };
  }

  const churchProgNew = "F | F/A | Bb | Bdim7 | F/C | C7 | F | F";
  const churchProgOld = "F | F/A | Bb | Bdim7 | F/C | C7";
  let basicList = dedupeProgressions(rawSections.basic);
  const jazzList = dedupeProgressions(rawSections.jazz);
  let darkList = dedupeProgressions(rawSections.dark);
  let didMigrateChurchToBasic = false;

  if (darkList.includes(churchProgNew) || darkList.includes(churchProgOld)) {
    darkList = darkList.filter(p => p !== churchProgNew && p !== churchProgOld);
    if (!basicList.includes(churchProgNew)) {
      basicList = [...basicList, churchProgNew];
    }
    didMigrateChurchToBasic = true;
  }

  return {
    sections: {
      basic: basicList,
      jazz: jazzList,
      dark: darkList
    },
    didMigrateJazzSplit: didMigrateChurchToBasic
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
    baseProgressionsPool: dedupeProgressions(DEFAULT_PROGRESSIONS),
    selectedEPModel: 'rhodes',
    barsPerRow: 2,
    isBeatActive: true,
    bpm: 80
  };

  try {
    const rawVault = localStorage.getItem(VAULT_LS_KEY);
    if (rawVault) {
      const parsed = JSON.parse(rawVault) as Partial<VaultPayload>;
      if (
        parsed &&
        parsed.savedSections &&
        Array.isArray(parsed.savedSections.basic) &&
        Array.isArray(parsed.savedSections.jazz) &&
        Array.isArray(parsed.savedSections.dark) &&
        Array.isArray(parsed.baseProgressionsPool)
      ) {
        const { sections, didMigrateJazzSplit } = migrateSavedSections(parsed.savedSections);
        const migratedPool = migrateBaseProgressionsPool(parsed.baseProgressionsPool, didMigrateJazzSplit);
        return {
          updatedAt: didMigrateJazzSplit ? Date.now() : (typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now()),
          theme: parsed.theme === 'light' ? 'light' : 'dark',
          savedSections: sections,
          baseProgressionsPool: migratedPool,
          selectedEPModel: parsed.selectedEPModel && EP_MODELS[parsed.selectedEPModel] ? parsed.selectedEPModel : 'rhodes',
          barsPerRow: parsed.barsPerRow === 1 ? 1 : 2,
          isBeatActive: parsed.isBeatActive !== undefined ? parsed.isBeatActive : true,
          bpm: typeof parsed.bpm === 'number' && parsed.bpm >= 50 && parsed.bpm <= 220 ? parsed.bpm : 80
        };
      }
    }
  } catch {}

  return defaultPayload;
}

const initialVault = loadInitialVaultSync();

const DEFAULT_START_PROGRESSION =
  initialVault.savedSections.basic[0] || DEFAULT_BASIC_PROGRESSIONS[0] || 'G | D | Em | C';

const state = {
  currentScreen: 'generator' as 'generator' | 'saved',
  // Default progression is whatever is first in the Basic category
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
  selectedEPModel: (initialVault.selectedEPModel || 'rhodes') as ElectricPianoModel,
  barsPerRow: (initialVault.barsPerRow === 1 ? 1 : 2) as 1 | 2,
  isBeatActive: initialVault.isBeatActive !== undefined ? initialVault.isBeatActive : true,
  bpm: initialVault.bpm || 80,
  theme: initialVault.theme,
  vaultUpdatedAt: initialVault.updatedAt,
  savedSections: initialVault.savedSections,
  baseProgressionsPool: initialVault.baseProgressionsPool
};

function getDefaultBaseProgression(): string {
  return state.savedSections.basic[0] || DEFAULT_BASIC_PROGRESSIONS[0] || 'G | D | Em | C';
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
    baseProgressionsPool: state.baseProgressionsPool,
    selectedEPModel: state.selectedEPModel,
    barsPerRow: state.barsPerRow,
    isBeatActive: state.isBeatActive,
    bpm: state.bpm
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
    if (newest.selectedEPModel && EP_MODELS[newest.selectedEPModel]) {
      state.selectedEPModel = newest.selectedEPModel;
      audioEngine.setModel(state.selectedEPModel);
      updateTransportUI();
    }
    if (newest.barsPerRow === 1 || newest.barsPerRow === 2) {
      state.barsPerRow = newest.barsPerRow;
      updateLayoutToggleUI();
    }
    if (newest.isBeatActive !== undefined) {
      state.isBeatActive = newest.isBeatActive;
      audioEngine.setBeatActive(state.isBeatActive);
      updateTransportUI();
    }
    if (typeof newest.bpm === 'number' && newest.bpm >= 50 && newest.bpm <= 220) {
      state.bpm = newest.bpm;
      audioEngine.setBpm(state.bpm);
      updateTransportUI();
    }
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
    baseProgressionsPool: state.baseProgressionsPool,
    selectedEPModel: state.selectedEPModel,
    barsPerRow: state.barsPerRow,
    isBeatActive: state.isBeatActive,
    bpm: state.bpm
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

function updateLayoutToggleUI() {
  const btn = document.getElementById('layoutToggleBtn');
  const icon = document.getElementById('layoutToggleIcon');
  if (!btn || !icon) return;

  const isOneBar = state.barsPerRow === 1;

  if (isOneBar) {
    btn.setAttribute('title', 'Current: 1 bar per row (1fr) · Tap to switch to 2 bars (1fr 1fr)');
    btn.setAttribute('aria-label', 'Switch to two bars per row');
    btn.className = 'p-2 rounded-[6px] text-sky-600 dark:text-[#38bdf8] bg-sky-50 dark:bg-[#0c4a6e]/40 transition-colors cursor-pointer';
    icon.innerHTML = `
      <svg class="w-4 h-4 fill-none stroke-current" viewBox="0 0 24 24" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="4" width="18" height="6.5" rx="1.5" />
        <rect x="3" y="13.5" width="18" height="6.5" rx="1.5" />
      </svg>
    `;
  } else {
    btn.setAttribute('title', 'Current: 2 bars per row (1fr 1fr) · Tap to switch to 1 bar (1fr)');
    btn.setAttribute('aria-label', 'Switch to one bar per row');
    btn.className = 'p-2 rounded-[6px] text-slate-500 hover:text-sky-600 dark:text-[#38bdf8]/70 dark:hover:text-[#38bdf8] hover:bg-slate-100 dark:hover:bg-[#0c4a6e]/40 transition-colors cursor-pointer';
    icon.innerHTML = `
      <svg class="w-4 h-4 fill-none stroke-current" viewBox="0 0 24 24" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="4" width="8" height="16" rx="1.5" />
        <rect x="13" y="4" width="8" height="16" rx="1.5" />
      </svg>
    `;
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
    badge.className = `font-mono-tabular font-black ${tech.icon.length > 4 ? 'text-[13px] sm:text-[14px]' : 'text-[16px]'} leading-none text-sky-600 dark:text-[#38bdf8] tracking-tight select-none pointer-events-none`;
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

  const chunkSize = state.barsPerRow === 1 ? 1 : 2;
  const isSingleCol = state.barsPerRow === 1;

  const rowsOfMeasures = [];
  for (let i = 0; i < measureEntries.length; i += chunkSize) {
    rowsOfMeasures.push(measureEntries.slice(i, i + chunkSize));
  }

  const leadSheetRowsHtml = rowsOfMeasures
    .map(rowMeasures => {
      const measBoxesHtml = rowMeasures
        .map(measTokens => {
          const mIdx = measTokens[0]?.measureIdx ?? 0;
          const chordCount = measTokens.filter(t => t.type === 'chord').length;
          const totalChars = measTokens.reduce((sum, t) => sum + t.val.length, 0);
          const isUltraDense = totalChars >= 16 || (chordCount >= 4 && totalChars >= 15);
          const isVeryDense = !isUltraDense && (chordCount >= 4 || totalChars >= 12);
          const isModerateDense = !isUltraDense && !isVeryDense && (chordCount === 3 || totalChars >= 8);

          const chordSizeCls = isSingleCol
            ? (isUltraDense
                ? 'text-[17px] sm:text-[20px]'
                : isVeryDense
                  ? 'text-[19px] sm:text-[23px]'
                  : isModerateDense
                    ? 'text-[22px] sm:text-[26px]'
                    : 'text-[24px] sm:text-[29px]')
            : (isUltraDense
                ? 'text-[13px] sm:text-[16px]'
                : isVeryDense
                  ? 'text-[15px] sm:text-[19px]'
                  : isModerateDense
                    ? 'text-[17px] sm:text-[21px]'
                    : 'text-[21px] sm:text-[25px]');
          const slashSizeCls = isSingleCol
            ? (isUltraDense
                ? 'text-[17px] sm:text-[20px]'
                : isVeryDense
                  ? 'text-[19px] sm:text-[23px]'
                  : isModerateDense
                    ? 'text-[22px] sm:text-[26px]'
                    : 'text-[22px] sm:text-[28px]')
            : (isUltraDense
                ? 'text-[13px] sm:text-[16px]'
                : isVeryDense
                  ? 'text-[15px] sm:text-[19px]'
                  : isModerateDense
                    ? 'text-[17px] sm:text-[21px]'
                    : 'text-[19px] sm:text-[25px]');
          const boxPaddingCls = isSingleCol
            ? 'px-3.5 py-3.5 sm:px-4 sm:py-4 gap-2 sm:gap-3'
            : (isUltraDense
                ? 'px-1.5 py-3.5 sm:px-2 sm:py-4 gap-0.5 sm:gap-1'
                : isVeryDense
                  ? 'px-2 py-3.5 sm:px-2.5 sm:py-4 gap-1 sm:gap-1.5'
                  : isModerateDense
                    ? 'px-2.5 py-3.5 sm:px-3 sm:py-4 gap-1 sm:gap-1.5'
                    : 'px-2.5 py-3.5 sm:px-3.5 sm:py-4 gap-1.5 sm:gap-2');

          const measContent = measTokens
            .map(tok => {
              if (tok.type === 'slash') {
                return `<span class="text-slate-400 dark:text-[#38bdf8]/60 font-mono-tabular ${slashSizeCls} font-bold select-none shrink-0">/</span>`;
              }
              const formattedName = formatChordHtml(tok.val);
              return `<span data-chord-token="1" data-measure-idx="${tok.measureIdx}" data-chord-idx="${tok.chordIdx ?? 0}" onclick="event.stopPropagation(); window.ReharmEngine.playChordString('${tok.val}', ${tok.beats || 2})" class="${chordSizeCls} font-black font-mono-tabular tracking-tight leading-normal py-0.5 px-[1px] text-slate-900 dark:text-white hover:text-sky-600 dark:hover:text-[#38bdf8] transition-all duration-150 cursor-pointer active:scale-95 select-none inline-block whitespace-nowrap shrink-0">${formattedName}</span>`;
            })
            .join(' ');

          return `
            <div data-measure-box="${mIdx}" onclick="window.ReharmEngine.togglePlayback()" class="relative flex items-center justify-between ${boxPaddingCls} bg-white dark:bg-[#071d2c] border border-slate-300 dark:border-[#0c4a6e] rounded-[10px] shadow-sm w-full min-w-0 box-border text-left transition-all duration-150 cursor-pointer" title="Click measure to Play / Stop | Click chord to preview">
              ${measContent}
            </div>
          `;
        })
        .join('');

      const gridColsCls = isSingleCol
        ? 'grid grid-cols-1 w-full min-w-0 box-border'
        : 'grid grid-cols-2 gap-2 sm:gap-3 w-full min-w-0 box-border';

      return `
        <div class="${gridColsCls}">
          ${measBoxesHtml}
        </div>
      `;
    })
    .join('');

  outputContainer.innerHTML = `
    <div class="flex flex-col gap-2.5 sm:gap-3 w-full my-auto box-border">
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
          <div class="font-mono-tabular text-[15px] font-extrabold leading-relaxed text-left flex-1 flex flex-wrap items-center gap-y-1">
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

  const epBtn = document.getElementById('epSelectorBtn');
  if (epBtn) {
    let epTimer: ReturnType<typeof setTimeout> | null = null;
    epBtn.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (epTimer) clearTimeout(epTimer);
      epTimer = setTimeout(() => {
        ReharmEngine.toggleEPPopover();
      }, 250);
    });
    const clearEPTimer = () => {
      if (epTimer) {
        clearTimeout(epTimer);
        epTimer = null;
      }
    };
    epBtn.addEventListener('pointerup', clearEPTimer);
    epBtn.addEventListener('pointerleave', clearEPTimer);
    epBtn.addEventListener('pointercancel', clearEPTimer);
  }

  document.addEventListener('pointerdown', e => {
    const target = e.target as Node | null;
    const insideWrapper = wrapper && target && wrapper.contains(target);
    const insideSet = setPopover && target && setPopover.contains(target);
    const insideTech = techPopover && target && techPopover.contains(target);
    const epPopover = document.getElementById('epPopover');
    const insideEPPopover = epPopover && target && epPopover.contains(target);
    const insideEPBtn = epBtn && target && epBtn.contains(target);

    if (!insideWrapper && !insideSet && setPopover && !setPopover.classList.contains('hidden')) {
      setPopover.classList.add('hidden');
    }
    if (!insideWrapper && !insideTech && techPopover && !techPopover.classList.contains('hidden')) {
      techPopover.classList.add('hidden');
    }
    if (!insideEPBtn && !insideEPPopover && epPopover && !epPopover.classList.contains('hidden')) {
      epPopover.classList.add('hidden');
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

  // Global Keyboard Shortcuts (Space: Play/Stop, T: Cycle Tempo, K: Cycle Keys, B: Toggle Drums, L: Toggle Loop)
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
      ReharmEngine.togglePlayback();
    } else if (e.key === 't' || e.key === 'T') {
      e.preventDefault();
      ReharmEngine.cycleBpm();
    } else if (e.key === 'k' || e.key === 'K') {
      e.preventDefault();
      ReharmEngine.cycleEPModel();
    } else if (e.key === 'b' || e.key === 'B') {
      e.preventDefault();
      ReharmEngine.toggleBeat();
    } else if (e.key === 'l' || e.key === 'L') {
      e.preventDefault();
      ReharmEngine.toggleLoop();
    }
  });
}

const BPM_CYCLE_LIST = [60, 70, 80, 90, 100, 110, 120];

let keysHoldTimer: ReturnType<typeof setTimeout> | null = null;
let keysLongPressed = false;

let drumsHoldTimer: ReturnType<typeof setTimeout> | null = null;
let drumsLongPressed = false;

function updateUploadButtonStates() {
  updateTransportButtonActiveStates();
}

function updateTransportButtonActiveStates() {
  const epBtn = document.getElementById('epSelectorBtn');
  const beatBtn = document.getElementById('beatToggleBtn');

  const keysActive = audioEngine.getKeysActive();
  const drumsActive = audioEngine.getDrumsActive();

  if (epBtn) {
    if (keysActive) {
      epBtn.classList.remove('opacity-40');
    } else {
      epBtn.classList.add('opacity-40');
    }
  }

  if (beatBtn) {
    if (drumsActive) {
      beatBtn.classList.remove('opacity-40');
    } else {
      beatBtn.classList.add('opacity-40');
    }
  }
}

const ReharmEngine = {
  Chord,
  TargetBackwardEngine,

  init() {
    applyThemeToDOM();
    if (state.selectedEPModel) {
      audioEngine.setModel(state.selectedEPModel);
    }
    if (state.isBeatActive !== undefined) {
      audioEngine.setBeatActive(state.isBeatActive);
    }
    if (state.bpm) {
      audioEngine.setBpm(state.bpm);
    }
    state.baseProgression = getDefaultBaseProgression();
    const input = document.getElementById('singleProgInput') as HTMLInputElement | null;
    if (input) input.value = state.baseProgression;
    syncDefaultProgressionInputUI();
    updateReharmSetUI();
    updateMeterBadgeUI();
    updateTransportUI(false);
    updateEPPopoverUI();
    updateLayoutToggleUI();
    setupInteractions();
    setupPWAInstallUI();
    renderOutput();
    renderSavedProgressionsList();
    syncAndHealVault();
    updateUploadButtonStates();
    audioEngine.prefetch();
  },

  toggleEPPopover(e?: Event) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    const pop = document.getElementById('epPopover');
    if (pop) {
      updateEPPopoverUI();
      pop.classList.toggle('hidden');
    }
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

  cycleBpm() {
    const current = audioEngine.getBpm();
    const idx = BPM_CYCLE_LIST.indexOf(current);
    let nextBpm: number;
    if (idx === -1) {
      const nextVal = BPM_CYCLE_LIST.find(b => b > current);
      nextBpm = nextVal !== undefined ? nextVal : BPM_CYCLE_LIST[0];
    } else {
      nextBpm = BPM_CYCLE_LIST[(idx + 1) % BPM_CYCLE_LIST.length];
    }
    audioEngine.setBpm(nextBpm);
    state.bpm = nextBpm;
    updateTransportUI();
    persistVault();
    return nextBpm;
  },

  toggleLoop() {
    audioEngine.setIsLooping(!audioEngine.getIsLooping());
    updateTransportUI();
  },

  toggleAudioModal() {},

  startKeysPressHold() {
    keysLongPressed = false;
    keysHoldTimer = setTimeout(() => {
      keysLongPressed = true;
      ReharmEngine.openKeysModal();
    }, 500);
  },

  endKeysPressHold() {
    if (keysHoldTimer) {
      clearTimeout(keysHoldTimer);
      keysHoldTimer = null;
    }
    if (!keysLongPressed) {
      audioEngine.toggleKeysActive();
      updateTransportButtonActiveStates();
    }
    keysLongPressed = false;
  },

  cancelKeysPressHold() {
    if (keysHoldTimer) {
      clearTimeout(keysHoldTimer);
      keysHoldTimer = null;
    }
    keysLongPressed = false;
  },

  openKeysModal() {
    const modal = document.getElementById('keysSettingsModal');
    if (modal) {
      modal.classList.remove('hidden');
      ReharmEngine.syncKeysModalUI();
    }
  },

  closeKeysModal() {
    const modal = document.getElementById('keysSettingsModal');
    if (modal) modal.classList.add('hidden');
  },

  syncKeysModalUI() {
    const fileList = document.getElementById('keysModalFileList');
    const keyName = audioEngine.getSoundFontName() || audioEngine.getCustomInstrumentName();
    if (fileList) {
      if (keyName) {
        fileList.innerHTML = `
          <div class="flex items-center justify-between bg-slate-100 dark:bg-[#030d17] px-2 py-1 rounded text-[11px] font-mono">
            <span class="truncate text-slate-700 dark:text-slate-200">${keyName}</span>
            <button type="button" onclick="window.ReharmEngine.deleteKeysFile()" class="text-rose-500 hover:text-rose-700 font-bold px-1 cursor-pointer">×</button>
          </div>
        `;
      } else {
        fileList.innerHTML = `<span class="text-[11px] text-slate-400 dark:text-slate-500">No file uploaded</span>`;
      }
    }

    const lowSlider = document.getElementById('keysLowSlider') as HTMLInputElement;
    const highSlider = document.getElementById('keysHighSlider') as HTMLInputElement;
    const gainSlider = document.getElementById('keysGainSlider') as HTMLInputElement;

    const lowVal = audioEngine.getKeysLowEq();
    const highVal = audioEngine.getKeysHighEq();
    const gainVal = audioEngine.getKeysGain();

    if (lowSlider) lowSlider.value = String(lowVal);
    if (highSlider) highSlider.value = String(highVal);
    if (gainSlider) gainSlider.value = String(gainVal);

    const lowValSpan = document.getElementById('keysLowVal');
    const highValSpan = document.getElementById('keysHighVal');
    const gainValSpan = document.getElementById('keysGainVal');

    if (lowValSpan) lowValSpan.textContent = `${lowVal > 0 ? '+' : ''}${lowVal} dB`;
    if (highValSpan) highValSpan.textContent = `${highVal > 0 ? '+' : ''}${highVal} dB`;
    if (gainValSpan) gainValSpan.textContent = `${gainVal.toFixed(2)}x`;
  },

  async handleKeysUpload(e: Event) {
    const input = e.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    const isSf2 = file.name.toLowerCase().endsWith('.sf2') || file.type.includes('soundfont');
    try {
      const arrayBuffer = await file.arrayBuffer();
      if (isSf2) {
        await audioEngine.loadSoundFont(arrayBuffer, file.name);
      } else {
        await audioEngine.loadCustomInstrumentSample(arrayBuffer, file.name);
      }
      ReharmEngine.syncKeysModalUI();
      updateUploadButtonStates();
    } catch (err) {
      console.error('Failed to load keys file:', err);
    }
  },

  deleteKeysFile() {
    audioEngine.clearSoundFont();
    audioEngine.clearCustomInstrument();
    const input = document.getElementById('keysFileInput') as HTMLInputElement;
    if (input) input.value = '';
    ReharmEngine.syncKeysModalUI();
    updateUploadButtonStates();
  },

  updateKeysLow(val: string) {
    const num = parseFloat(val);
    if (!isNaN(num)) {
      audioEngine.setKeysLowEq(num);
      const span = document.getElementById('keysLowVal');
      if (span) span.textContent = `${num > 0 ? '+' : ''}${num} dB`;
    }
  },

  updateKeysHigh(val: string) {
    const num = parseFloat(val);
    if (!isNaN(num)) {
      audioEngine.setKeysHighEq(num);
      const span = document.getElementById('keysHighVal');
      if (span) span.textContent = `${num > 0 ? '+' : ''}${num} dB`;
    }
  },

  updateKeysGain(val: string) {
    const num = parseFloat(val);
    if (!isNaN(num)) {
      audioEngine.setKeysGain(num);
      const span = document.getElementById('keysGainVal');
      if (span) span.textContent = `${num.toFixed(2)}x`;
    }
  },

  startDrumsPressHold() {
    drumsLongPressed = false;
    drumsHoldTimer = setTimeout(() => {
      drumsLongPressed = true;
      ReharmEngine.openDrumsModal();
    }, 500);
  },

  endDrumsPressHold() {
    if (drumsHoldTimer) {
      clearTimeout(drumsHoldTimer);
      drumsHoldTimer = null;
    }
    if (!drumsLongPressed) {
      audioEngine.toggleDrumsActive();
      updateTransportButtonActiveStates();
    }
    drumsLongPressed = false;
  },

  cancelDrumsPressHold() {
    if (drumsHoldTimer) {
      clearTimeout(drumsHoldTimer);
      drumsHoldTimer = null;
    }
    drumsLongPressed = false;
  },

  openDrumsModal() {
    const modal = document.getElementById('drumsSettingsModal');
    if (modal) {
      modal.classList.remove('hidden');
      ReharmEngine.syncDrumsModalUI();
    }
  },

  closeDrumsModal() {
    const modal = document.getElementById('drumsSettingsModal');
    if (modal) modal.classList.add('hidden');
  },

  syncDrumsModalUI() {
    const fileList = document.getElementById('drumsModalFileList');
    const drumName = audioEngine.getCustomDrumLoopName();
    if (fileList) {
      if (drumName) {
        fileList.innerHTML = `
          <div class="flex items-center justify-between bg-slate-100 dark:bg-[#030d17] px-2 py-1 rounded text-[11px] font-mono">
            <span class="truncate text-slate-700 dark:text-slate-200">${drumName}</span>
            <button type="button" onclick="window.ReharmEngine.deleteDrumsFile()" class="text-rose-500 hover:text-rose-700 font-bold px-1 cursor-pointer">×</button>
          </div>
        `;
      } else {
        fileList.innerHTML = `<span class="text-[11px] text-slate-400 dark:text-slate-500">No file uploaded</span>`;
      }
    }

    const bpmInput = document.getElementById('drumsBaseBpmInput') as HTMLInputElement;
    if (bpmInput) bpmInput.value = String(audioEngine.getCustomDrumLoopBaseBpm());

    const lowSlider = document.getElementById('drumsLowSlider') as HTMLInputElement;
    const highSlider = document.getElementById('drumsHighSlider') as HTMLInputElement;
    const gainSlider = document.getElementById('drumsGainSlider') as HTMLInputElement;

    const lowVal = audioEngine.getDrumsLowEq();
    const highVal = audioEngine.getDrumsHighEq();
    const gainVal = audioEngine.getDrumsGain();

    if (lowSlider) lowSlider.value = String(lowVal);
    if (highSlider) highSlider.value = String(highVal);
    if (gainSlider) gainSlider.value = String(gainVal);

    const lowValSpan = document.getElementById('drumsLowVal');
    const highValSpan = document.getElementById('drumsHighVal');
    const gainValSpan = document.getElementById('drumsGainVal');

    if (lowValSpan) lowValSpan.textContent = `${lowVal > 0 ? '+' : ''}${lowVal} dB`;
    if (highValSpan) highValSpan.textContent = `${highVal > 0 ? '+' : ''}${highVal} dB`;
    if (gainValSpan) gainValSpan.textContent = `${gainVal.toFixed(2)}x`;
  },

  async handleDrumsUpload(e: Event) {
    const input = e.target as HTMLInputElement;
    const baseBpmInput = document.getElementById('drumsBaseBpmInput') as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    const baseBpm = baseBpmInput ? parseInt(baseBpmInput.value, 10) || 120 : 120;
    try {
      const arrayBuffer = await file.arrayBuffer();
      await audioEngine.loadCustomDrumLoop(arrayBuffer, baseBpm, file.name);
      ReharmEngine.syncDrumsModalUI();
      updateUploadButtonStates();
    } catch (err) {
      console.error('Failed to load drum loop:', err);
    }
  },

  deleteDrumsFile() {
    audioEngine.clearCustomDrumLoop();
    const input = document.getElementById('drumsFileInput') as HTMLInputElement;
    if (input) input.value = '';
    ReharmEngine.syncDrumsModalUI();
    updateUploadButtonStates();
  },

  updateDrumsBaseBpm(val: string | number) {
    const num = typeof val === 'number' ? val : parseInt(val, 10);
    if (!isNaN(num)) {
      audioEngine.setCustomDrumLoopBaseBpm(num);
    }
  },

  updateDrumsLow(val: string) {
    const num = parseFloat(val);
    if (!isNaN(num)) {
      audioEngine.setDrumsLowEq(num);
      const span = document.getElementById('drumsLowVal');
      if (span) span.textContent = `${num > 0 ? '+' : ''}${num} dB`;
    }
  },

  updateDrumsHigh(val: string) {
    const num = parseFloat(val);
    if (!isNaN(num)) {
      audioEngine.setDrumsHighEq(num);
      const span = document.getElementById('drumsHighVal');
      if (span) span.textContent = `${num > 0 ? '+' : ''}${num} dB`;
    }
  },

  updateDrumsGain(val: string) {
    const num = parseFloat(val);
    if (!isNaN(num)) {
      audioEngine.setDrumsGain(num);
      const span = document.getElementById('drumsGainVal');
      if (span) span.textContent = `${num.toFixed(2)}x`;
    }
  },

  switchScreen(screenName: 'generator' | 'saved') {
    state.currentScreen = screenName === 'saved' ? 'saved' : 'generator';
    const track = document.getElementById('screenTrack');
    const saveBtn = document.getElementById('saveCurrentProgBtn');
    const layoutBtn = document.getElementById('layoutToggleBtn');

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
      if (layoutBtn) layoutBtn.classList.add('invisible');
      renderSavedProgressionsList();
    } else {
      if (track) {
        track.classList.remove('-translate-x-1/2');
        track.classList.add('translate-x-0');
      }
      if (saveBtn) saveBtn.classList.remove('invisible');
      if (layoutBtn) layoutBtn.classList.remove('invisible');
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
      const prevDefault = getDefaultBaseProgression();
      const targetSec: SavedSectionKey =
        state.activeSavedSection ||
        (state.reharmSet === 'dark' ? 'dark' : inferProgressionCategory(formatted));
      if (!state.savedSections[targetSec].includes(formatted)) {
        state.savedSections[targetSec].unshift(formatted);
        if (
          targetSec === 'basic' &&
          (!state.userChangedBaseProgression || normalizeProgressionString(state.baseProgression) === prevDefault)
        ) {
          state.baseProgression = getDefaultBaseProgression();
          const mainInput = document.getElementById('singleProgInput') as HTMLInputElement | null;
          if (mainInput) mainInput.value = state.baseProgression;
        }
        syncDefaultProgressionInputUI();
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
    const prevDefault = getDefaultBaseProgression();
    const temp = list[idx];
    list[idx] = list[targetIdx];
    list[targetIdx] = temp;
    state.editingSavedKey = null;
    if (
      secKey === 'basic' &&
      (idx === 0 || targetIdx === 0)
    ) {
      if (!state.userChangedBaseProgression || normalizeProgressionString(state.baseProgression) === prevDefault) {
        state.baseProgression = getDefaultBaseProgression();
        const mainInput = document.getElementById('singleProgInput') as HTMLInputElement | null;
        if (mainInput) mainInput.value = state.baseProgression;
      }
      syncDefaultProgressionInputUI();
    }
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
      const prevDefault = getDefaultBaseProgression();
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
        if (
          (secKey === 'basic' && idx === 0 && (!state.userChangedBaseProgression || normalizeProgressionString(state.baseProgression) === prevDefault)) ||
          (oldProg && normalizeProgressionString(state.baseProgression) === normalizeProgressionString(oldProg))
        ) {
          state.baseProgression = formatted;
          const mainInput = document.getElementById('singleProgInput') as HTMLInputElement | null;
          if (mainInput) mainInput.value = formatted;
        }
        syncDefaultProgressionInputUI();
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
    const prevDefault = getDefaultBaseProgression();
    state.savedSections[secKey].splice(idx, 1);
    if (secKey === 'basic' && idx === 0) {
      if (!state.userChangedBaseProgression || normalizeProgressionString(state.baseProgression) === prevDefault) {
        state.baseProgression = getDefaultBaseProgression();
        const mainInput = document.getElementById('singleProgInput') as HTMLInputElement | null;
        if (mainInput) mainInput.value = state.baseProgression;
      }
      syncDefaultProgressionInputUI();
    }
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

    const preservedStrategies = [
      'strategy1',
      'strategy2',
      'strategy3',
      'strategy4',
      'strategy5',
      'strategy6'
    ];
    const replacementStrategies = [
      'strategy7',
      'strategy8'
    ];
    const allStrategies = [...preservedStrategies, ...replacementStrategies];

    const subVariants = TargetBackwardEngine.getSubVariantsForTechnique(state.selectedTechnique);

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

    // Group candidate sub-variants by base strategy (strategy1..strategy8)
    // so the structural rate at which reharms occur is 100% preserved!
    const validSubVariantsByBaseStrat = new Map<string, string[]>();
    allStrategies.forEach(baseStrat => {
      const seenSigsForStrat = new Set<string>();
      const validList: string[] = [];
      subVariants.forEach(sv => {
        const stratKey = subVariants.length > 1 ? `${baseStrat}@${sv}` : baseStrat;
        const freshBase = parseInputByMeasures(state.baseProgression);
        const out = TargetBackwardEngine.executeReharm(
          freshBase,
          state.selectedTechnique,
          stratKey,
          opts
        );
        const sig = serializeMeasures(out);
        if (sig !== currentSig && !seenSigsForStrat.has(sig)) {
          seenSigsForStrat.add(sig);
          validList.push(stratKey);
        }
      });
      if (validList.length > 0) {
        validSubVariantsByBaseStrat.set(baseStrat, validList);
      }
    });

    const candidateBaseStrats = Array.from(validSubVariantsByBaseStrat.keys());
    if (candidateBaseStrats.length > 0) {
      // 80/20 ratio: 80% preserved base chords with altered beats & passing chords; 20% limited replacement
      const wantsReplacement = Math.random() < 0.20;
      const preferredPool = wantsReplacement ? replacementStrategies : preservedStrategies;
      const matchedCandidates = candidateBaseStrats.filter(s => preferredPool.includes(s));
      const poolToPick = matchedCandidates.length > 0 ? matchedCandidates : candidateBaseStrats;

      const pickedBase = poolToPick[Math.floor(Math.random() * poolToPick.length)];
      const variantsForBase = validSubVariantsByBaseStrat.get(pickedBase)!;
      const pickedFullStrat = variantsForBase[Math.floor(Math.random() * variantsForBase.length)];
      state.selectedStrategy = pickedFullStrat;
    } else {
      const wantsReplacement = Math.random() < 0.20;
      const fallbackPool = wantsReplacement ? replacementStrategies : preservedStrategies;
      state.strategyCycleIndex = (state.strategyCycleIndex + 1) % fallbackPool.length;
      const fallbackBase = fallbackPool[state.strategyCycleIndex];
      const fallbackSv = subVariants[Math.floor(Math.random() * subVariants.length)];
      state.selectedStrategy = subVariants.length > 1 ? `${fallbackBase}@${fallbackSv}` : fallbackBase;
    }

    renderOutput();
  },

  playChordString(chordStr: string, beats = 2) {
    if (Date.now() < justSwipedUntil) return;
    if (!chordStr) return;
    const chord = chordStr.split('→')[0].trim();
    audioEngine.playSingleChord(chord, beats, state.meter);
  },

  toggleLayoutColumns() {
    state.barsPerRow = state.barsPerRow === 1 ? 2 : 1;
    updateLayoutToggleUI();
    renderOutput();
    persistVault();
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
