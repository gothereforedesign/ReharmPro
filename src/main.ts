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
}

interface BeatSlot {
  chord: Chord;
  isAttack: boolean;
}

interface SavedSections {
  basic: string[];
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

  // 3. Related ii7 Insertion: D + 5 semitones -> m7 (or m7b5)
  static add_related_two(dominantChord: Chord, resolveToMinor = false): Chord {
    const useSharp = dominantChord.preferSharps ?? SHARP_ROOTS.has(dominantChord.root);
    const iiRoot = this.transpose(dominantChord.root, 5, useSharp);
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
        // Pure side-stepped ii-V -> target ii-V
        const v7 = this.tonicize(targetChordX);
        const ii7 = this.add_related_two(v7, isMin);
        const ssV = this.side_step_above(v7);
        const ssII = this.side_step_above(ii7);
        step1 = v7;
        step2 = ii7;
        step3 = ssV;
        step4 = ssII;
        twoChordCell = [ssII, ssV];
        threeChordCell = [ssII, ssV, v7];
        fourChordCell = [ssII, ssV, ii7, v7];
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

  static reharmonizeProgressionBackward(
    measures: ChordBeatItem[][],
    techniqueId = 'tonicize',
    strategy = 'strategy1'
  ): ChordBeatItem[][] {
    if (!measures || measures.length === 0) return [];

    // Always build fresh beat grids from the base measures
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
    const targetMIdx = numMeasures - 1;
    const targetGrid = measureBeatGrids[targetMIdx];
    if (!targetGrid || targetGrid.length === 0) return measures;

    const targetChordX = targetGrid[0].chord;
    const approach = this.getApproachChords(targetChordX, techniqueId);
    const { step1, step2, step3, step4, twoChordCell, threeChordCell, fourChordCell } = approach;
    const isTwoFiveFamily = (
      techniqueId === 'standard_two_five' ||
      techniqueId === 'tritone_two_five' ||
      techniqueId === 'side_step_two_five'
    );

    // =========================================================================
    // CASE 1: 4 or more measures (Anchor = Bar 1 `home0`, Runway = Bars 2 & 3, Target = Bar 4)
    // =========================================================================
    if (targetMIdx >= 3) {
      const bar0 = measureBeatGrids[targetMIdx - 3];
      const bar1 = measureBeatGrids[targetMIdx - 2];
      const bar2 = measureBeatGrids[targetMIdx - 1];
      const home0 = bar0[0].chord;

      if (strategy === 'strategy2') {
        // Lock Bars 1 & 2 on Home Anchor, 2-chord approach in Bar 3
        this.fillBarBeats(bar0, [home0]);
        this.fillBarBeats(bar1, [home0]);
        this.fillBarBeats(bar2, isTwoFiveFamily ? [step2, step1] : twoChordCell, 'standard');

      } else if (strategy === 'strategy3') {
        // Lock Bars 1 & 2 on Home Anchor, late micro-target in Bar 3
        this.fillBarBeats(bar0, [home0]);
        this.fillBarBeats(bar1, [home0]);
        this.fillBarBeats(bar2, [home0, step1], 'standard');

      } else if (strategy === 'strategy4') {
        // Sustain Home Anchor into first half of Bar 2, pickup into Bar 3 approach
        this.fillBarBeats(bar0, [home0]);
        this.fillBarBeats(bar1, [home0, isTwoFiveFamily ? step3 : step2], 'standard');
        this.fillBarBeats(bar2, isTwoFiveFamily ? [step2, step1] : [step1], 'standard');

      } else if (strategy === 'strategy5') {
        // Lock Bars 1 & 2 on Home Anchor, accelerated multi-chord runway in Bar 3
        this.fillBarBeats(bar0, [home0]);
        this.fillBarBeats(bar1, [home0]);
        this.fillBarBeats(bar2, bar2.length === 3 ? threeChordCell : fourChordCell);

      } else if (strategy === 'strategy6') {
        // Extended Runway starting on late beat of Bar 1
        this.fillBarBeats(bar0, [home0, step3], 'late');
        this.fillBarBeats(bar1, [step2]);
        this.fillBarBeats(bar2, isTwoFiveFamily ? [step2, step1] : [step1], 'standard');

      } else if (strategy === 'strategy7') {
        // 2-Bar Runway with 3-chord cadence in Bar 3
        this.fillBarBeats(bar0, [home0]);
        this.fillBarBeats(bar1, [home0, step3], 'late');
        this.fillBarBeats(bar2, threeChordCell, 'standard');

      } else if (strategy === 'strategy8') {
        // Full 4-chord chain across Bars 2 & 3
        this.fillBarBeats(bar0, [home0]);
        this.fillBarBeats(bar1, [step4, step3], 'standard');
        this.fillBarBeats(bar2, [step2, step1], 'standard');

      } else {
        // Strategy 1 (Default): Lock Bar 1 Anchor, 2-Bar Runway across Bars 2 & 3
        this.fillBarBeats(bar0, [home0]);
        if (techniqueId === 'side_step_two_five') {
          this.fillBarBeats(bar1, [step4, step3], 'standard');
          this.fillBarBeats(bar2, [step2, step1], 'standard');
        } else if (isTwoFiveFamily) {
          this.fillBarBeats(bar1, [step2]);
          this.fillBarBeats(bar2, [step1]);
        } else if (techniqueId === 'circle_of_fifths') {
          this.fillBarBeats(bar1, [step3, step2], 'standard');
          this.fillBarBeats(bar2, [step1]);
        } else {
          this.fillBarBeats(bar1, [step2]);
          this.fillBarBeats(bar2, [step1]);
        }
      }

    // =========================================================================
    // CASE 2: 3 measures (Anchor = Bar 1 `home0`, Runway = Bar 2, Target = Bar 3)
    // Purely uses Anchor `home0` + active technique's approach cells (never retains old Bar 2 chord)
    // =========================================================================
    } else if (targetMIdx === 2) {
      const bar0 = measureBeatGrids[0];
      const bar1 = measureBeatGrids[1];
      const home0 = bar0[0].chord;

      if (strategy === 'strategy2') {
        // 2-chord cell in Bar 2 (or 1-chord if Default Strategy 1 used 2-chord)
        this.fillBarBeats(bar0, [home0]);
        if (isTwoFiveFamily || techniqueId === 'circle_of_fifths') {
          this.fillBarBeats(bar1, [step1]);
        } else {
          this.fillBarBeats(bar1, twoChordCell, 'standard');
        }
      } else if (strategy === 'strategy3') {
        // Micro-Target: Sustain Home Anchor into first half of Bar 2, approach in second half
        this.fillBarBeats(bar0, [home0]);
        this.fillBarBeats(bar1, [home0, step1], 'standard');
      } else if (strategy === 'strategy4') {
        // Late 1-beat pickup in Bar 2
        this.fillBarBeats(bar0, [home0]);
        this.fillBarBeats(bar1, [home0, step1], 'late');
      } else if (strategy === 'strategy5') {
        // 3-chord runway in Bar 2
        this.fillBarBeats(bar0, [home0]);
        this.fillBarBeats(bar1, threeChordCell, 'standard');
      } else if (strategy === 'strategy6') {
        // 4-chord (or 3-chord in 3/4) accelerated runway in Bar 2
        this.fillBarBeats(bar0, [home0]);
        this.fillBarBeats(bar1, bar1.length === 3 ? threeChordCell : fourChordCell);
      } else if (strategy === 'strategy7') {
        // Extended Runway starting on second half of Bar 1
        this.fillBarBeats(bar0, [home0, step2], 'standard');
        this.fillBarBeats(bar1, isTwoFiveFamily ? [step2, step1] : [step1], 'standard');
      } else if (strategy === 'strategy8') {
        // Extended 3-Step Runway starting on final beat of Bar 1
        this.fillBarBeats(bar0, [home0, step3], 'late');
        this.fillBarBeats(bar1, [step2, step1], 'standard');
      } else {
        // Strategy 1 (Default): Cleanest primary representation of the selected technique in Bar 2
        this.fillBarBeats(bar0, [home0]);
        if (techniqueId === 'side_step_two_five') {
          this.fillBarBeats(bar1, fourChordCell);
        } else if (isTwoFiveFamily || techniqueId === 'circle_of_fifths') {
          this.fillBarBeats(bar1, [step2, step1], 'standard');
        } else {
          this.fillBarBeats(bar1, [step1]);
        }
      }

    // =========================================================================
    // CASE 3: 2 measures (Anchor = Bar 1 Beat 1 `home0`, Target = Bar 2 `targetChordX`)
    // =========================================================================
    } else if (targetMIdx === 1) {
      const bar0 = measureBeatGrids[0];
      const bar1 = measureBeatGrids[1];
      const home0 = bar0[0].chord;
      const b0Len = bar0.length;

      if (strategy === 'strategy2') {
        this.fillBarBeats(bar0, [home0, step1], 'late');
      } else if (strategy === 'strategy3') {
        this.fillBarBeats(bar0, [home0, step2, step1], 'standard');
      } else if (strategy === 'strategy4') {
        this.fillBarBeats(
          bar0,
          b0Len === 3 ? [home0, step2, step1] : [home0, step3, step2, step1]
        );
      } else if (strategy === 'strategy5') {
        this.fillBarBeats(bar0, [home0, step1], 'early');
      } else if (strategy === 'strategy6') {
        const homeApproach = this.getApproachChords(home0, techniqueId);
        this.fillBarBeats(bar0, [home0, step1], 'standard');
        this.fillBarBeats(bar1, [targetChordX, homeApproach.step1], 'late');
      } else if (strategy === 'strategy7') {
        this.fillBarBeats(bar0, [step2, step1], 'standard');
      } else if (strategy === 'strategy8') {
        this.fillBarBeats(bar0, b0Len === 3 ? threeChordCell : fourChordCell);
      } else {
        if (isTwoFiveFamily || techniqueId === 'circle_of_fifths') {
          this.fillBarBeats(bar0, [home0, step2, step1], 'standard');
        } else {
          this.fillBarBeats(bar0, [home0, step1], 'standard');
        }
      }

    // =========================================================================
    // CASE 4: 1 single measure (targetMIdx === 0)
    // =========================================================================
    } else {
      const bar = measureBeatGrids[0];
      if (bar.length >= 2) {
        const homeChord = bar[0].chord;
        if (strategy === 'strategy2') {
          this.fillBarBeats(bar, [homeChord, step1], 'late');
        } else if (strategy === 'strategy3') {
          this.fillBarBeats(bar, [homeChord, step2, step1], 'standard');
        } else if (strategy === 'strategy4') {
          this.fillBarBeats(
            bar,
            bar.length === 3 ? [homeChord, step2, step1] : [homeChord, step3, step2, step1]
          );
        } else {
          this.fillBarBeats(bar, [homeChord, step1], 'standard');
        }
      }
    }

    return measureBeatGrids.map(grid => {
      const compressed: ChordBeatItem[] = [];
      grid.forEach(slot => {
        const sym = slot.chord.toString();
        if (compressed.length > 0 && compressed[compressed.length - 1].chord === sym) {
          compressed[compressed.length - 1].beats += 1;
        } else {
          compressed.push({ chord: sym, beats: 1 });
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
    const targetMIdx = numMeasures - 1;
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
      this.fillBarBeats(measureBeatGrids[targetMIdx - 3], b0Seq, 'standard');
      this.fillBarBeats(measureBeatGrids[targetMIdx - 2], b1Seq, 'standard');
      this.fillBarBeats(measureBeatGrids[targetMIdx - 1], b2Seq, 'standard');
      this.fillDarkTargetBar(measureBeatGrids[targetMIdx], H, techniqueId, strategy);
    } else if (targetMIdx === 2) {
      this.fillBarBeats(measureBeatGrids[0], b0Seq, 'standard');
      this.fillBarBeats(measureBeatGrids[1], b2Seq, 'standard');
      this.fillDarkTargetBar(measureBeatGrids[2], H, techniqueId, strategy);
    } else if (targetMIdx === 1) {
      const combinedBar0 = b0Seq.length === 1 && b1Seq.length >= 1
        ? [b0Seq[0], b1Seq[0], ...(b2Seq.slice(-1))]
        : b2Seq;
      this.fillBarBeats(measureBeatGrids[0], combinedBar0, 'standard');
      this.fillDarkTargetBar(measureBeatGrids[1], H, techniqueId, strategy);
    } else {
      this.fillBarBeats(measureBeatGrids[0], [b0Seq[0], ...b2Seq.slice(-2)], 'standard');
    }

    return measureBeatGrids.map(grid => {
      const compressed: ChordBeatItem[] = [];
      grid.forEach(slot => {
        const sym = slot.chord.toString();
        if (compressed.length > 0 && compressed[compressed.length - 1].chord === sym) {
          compressed[compressed.length - 1].beats += 1;
        } else {
          compressed.push({ chord: sym, beats: 1 });
        }
      });
      return compressed;
    });
  }

  static executeSinglePhraseReharm(
    measures: ChordBeatItem[][],
    techniqueId: string,
    strategy: string
  ): ChordBeatItem[][] {
    if (!techniqueId || techniqueId === 'default') {
      return measures.map(m => m.map(c => ({ ...c })));
    }
    if (this.isDarkTechnique(techniqueId)) {
      return this.reharmonizeProgressionDark(measures, techniqueId, strategy);
    }
    return this.reharmonizeProgressionBackward(measures, techniqueId, strategy);
  }

  static executeReharm(
    measures: ChordBeatItem[][],
    techniqueId: string,
    strategy: string
  ): ChordBeatItem[][] {
    if (!measures || measures.length === 0) return [];
    if (!techniqueId || techniqueId === 'default') {
      return measures.map(m => m.map(c => ({ ...c })));
    }
    if (measures.length > 4) {
      let splitIdx = Math.ceil(measures.length / 2);
      if (measures.length === 9) {
        splitIdx = 3;
      } else if (measures.length % 4 === 0) {
        splitIdx = 4;
      } else if (measures.length > 8) {
        splitIdx = 4;
      }
      const firstPart = this.executeReharm(measures.slice(0, splitIdx), techniqueId, strategy);
      const restPart = this.executeReharm(measures.slice(splitIdx), techniqueId, strategy);
      return [...firstPart, ...restPart];
    }
    return this.executeSinglePhraseReharm(measures, techniqueId, strategy);
  }
}

const DEFAULT_PROGRESSIONS = [
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
      box.classList.add('border-sky-500', 'dark:border-[#38bdf8]', 'ring-1', 'ring-sky-500/40', 'dark:ring-[#38bdf8]/40');
      box.classList.remove('border-slate-300', 'dark:border-[#0c4a6e]');
    } else {
      box.classList.remove('border-sky-500', 'dark:border-[#38bdf8]', 'ring-1', 'ring-sky-500/40', 'dark:ring-[#38bdf8]/40');
      box.classList.add('border-slate-300', 'dark:border-[#0c4a6e]');
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

function getDisplayedMeasures(): ChordBeatItem[][] {
  const baseMeasures = parseInputByMeasures(state.baseProgression);
  if (!baseMeasures || baseMeasures.length === 0) return [];
  return state.reharmActive && state.selectedTechnique !== 'default'
    ? TargetBackwardEngine.executeReharm(
        baseMeasures,
        state.selectedTechnique,
        state.selectedStrategy
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

function loadInitialVaultSync(): VaultPayload {
  const defaultPayload: VaultPayload = {
    updatedAt: 0,
    theme: 'dark',
    savedSections: {
      basic: DEFAULT_PROGRESSIONS.map(normalizeProgressionString),
      dark: DEFAULT_SAVED_PROGRESSIONS.map(normalizeProgressionString)
    },
    baseProgressionsPool: DEFAULT_PROGRESSIONS.map(normalizeProgressionString)
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
        return {
          updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
          theme: parsed.theme === 'light' ? 'light' : 'dark',
          savedSections: {
            basic: parsed.savedSections.basic.map(p => migrateLegacyDefaultProgression(String(p))).filter(Boolean),
            dark: parsed.savedSections.dark.map(p => migrateLegacyDefaultProgression(String(p))).filter(Boolean)
          },
          baseProgressionsPool: parsed.baseProgressionsPool.map(p => migrateLegacyDefaultProgression(String(p))).filter(Boolean)
        };
      }
    }

    // Migrate legacy keys if present
    const legacySaved = localStorage.getItem('reharmpro_saved_sections_v3');
    const legacyPool = localStorage.getItem('reharmpro_base_pool_v2');
    if (legacySaved || legacyPool) {
      if (legacySaved) {
        const pSaved = JSON.parse(legacySaved);
        if (pSaved && Array.isArray(pSaved.basic) && Array.isArray(pSaved.dark)) {
          defaultPayload.savedSections = {
            basic: pSaved.basic.map((p: unknown) => migrateLegacyDefaultProgression(String(p))).filter(Boolean),
            dark: pSaved.dark.map((p: unknown) => migrateLegacyDefaultProgression(String(p))).filter(Boolean)
          };
        }
      }
      if (legacyPool) {
        const pPool = JSON.parse(legacyPool);
        if (Array.isArray(pPool) && pPool.length > 0) {
          defaultPayload.baseProgressionsPool = pPool.map((p: unknown) => migrateLegacyDefaultProgression(String(p))).filter(Boolean);
        }
      }
      defaultPayload.updatedAt = Date.now();
      localStorage.setItem(VAULT_LS_KEY, JSON.stringify(defaultPayload));
    }
  } catch {}

  return defaultPayload;
}

const initialVault = loadInitialVaultSync();

const state = {
  currentScreen: 'generator' as 'generator' | 'saved',
  // Clean base progression initialized to the first progression in the randomizer's chord progression set
  baseProgression: initialVault.baseProgressionsPool[0] || DEFAULT_PROGRESSIONS[0],
  userChangedBaseProgression: false,
  meter: 4,
  manualMeterOverride: false,
  reharmSet: 'basic' as 'basic' | 'dark',
  selectedTechnique: 'default',
  selectedStrategy: 'strategy1',
  reharmActive: false,
  strategyCycleIndex: 0,
  editingBaseIdx: null as number | null,
  editingSavedKey: null as string | null,
  activeSavedSection: null as 'basic' | 'dark' | null,
  lastFormattedOutput: '',
  theme: initialVault.theme,
  vaultUpdatedAt: initialVault.updatedAt,
  savedSections: initialVault.savedSections,
  baseProgressionsPool: initialVault.baseProgressionsPool
};

function getDefaultBaseProgression(): string {
  return normalizeProgressionString(state.baseProgressionsPool[0] || DEFAULT_PROGRESSIONS[0]);
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
    state.vaultUpdatedAt = newest.updatedAt;
    state.theme = newest.theme === 'light' ? 'light' : 'dark';
    state.savedSections = {
      basic: newest.savedSections.basic.map(p => migrateLegacyDefaultProgression(String(p))).filter(Boolean),
      dark: newest.savedSections.dark.map(p => migrateLegacyDefaultProgression(String(p))).filter(Boolean)
    };
    state.baseProgressionsPool = newest.baseProgressionsPool.map(p => migrateLegacyDefaultProgression(String(p))).filter(Boolean);
    if (!state.userChangedBaseProgression && state.baseProgressionsPool.length > 0) {
      state.baseProgression = state.baseProgressionsPool[0];
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
  return state.savedSections.basic.includes(normProg) || state.savedSections.dark.includes(normProg);
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
    /\(maj7\)|7\(b5\)|\(b5\)|7alt|add2|add9|maj7|7b5|m11|dim7|9sus4|7\(b9,b13\)|7\(b9\)|7\(#9\)|7\(#11\)|7\+|°7|Δ|ø|\+|7|9|11|13|6/g,
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
        state.selectedStrategy
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
          const measContent = measTokens
            .map(tok => {
              if (tok.type === 'slash') {
                return `<span class="text-slate-400 dark:text-[#38bdf8]/60 font-mono-tabular text-xl sm:text-3xl font-bold select-none">/</span>`;
              }
              const formattedName = formatChordHtml(tok.val);
              return `<span data-chord-token="1" data-measure-idx="${tok.measureIdx}" data-chord-idx="${tok.chordIdx ?? 0}" onclick="window.ReharmEngine.playChordString('${tok.val}', ${tok.beats || 2})" class="text-2xl sm:text-3xl font-black font-mono-tabular tracking-tight text-slate-900 dark:text-white hover:text-sky-600 dark:hover:text-[#38bdf8] transition-all duration-150 cursor-pointer active:scale-95 select-none inline-block">${formattedName}</span>`;
            })
            .join(' ');

          return `
            <div data-measure-box="${mIdx}" class="flex items-center justify-center px-3 py-3 sm:px-4 sm:py-4 bg-white dark:bg-[#071d2c] border border-slate-300 dark:border-[#0c4a6e] rounded-[10px] shadow-sm w-full transition-all duration-150">
              <div class="flex-1 flex items-center justify-between gap-2 text-left">
                ${measContent}
              </div>
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
    const sections = [
      { key: 'basic', title: 'Basic', list: state.savedSections.basic },
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

  const secKey = state.activeSavedSection === 'dark' ? 'dark' : 'basic';
  const secTitle = secKey === 'dark' ? 'Dark' : 'Basic';
  const otherKey = secKey === 'dark' ? 'basic' : 'dark';
  const otherTitle = secKey === 'dark' ? 'Basic' : 'Dark';
  const list = state.savedSections[secKey] || [];

  const headerHtml = `
    <div class="flex items-center justify-between pb-1 shrink-0">
      <button type="button" onclick="window.ReharmEngine.closeSavedSection()" class="inline-flex items-center gap-1.5 py-1 px-1.5 -ml-1.5 rounded-[6px] text-slate-700 dark:text-slate-200 hover:text-sky-600 dark:hover:text-[#38bdf8] font-mono-tabular text-sm font-black tracking-tight cursor-pointer transition-colors">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        <span>${secTitle}</span>
      </button>
      <button type="button" onclick="window.ReharmEngine.openSavedSection('${otherKey}')" class="py-1 px-2 rounded-[6px] text-xs font-mono-tabular font-bold text-slate-500 dark:text-slate-400 hover:text-sky-600 dark:hover:text-[#38bdf8] cursor-pointer transition-colors">
        ${otherTitle}
      </button>
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
    if (el && el.closest && el.closest('input, select, textarea, #reharmSetPopover, #reharmTechniquePopover, #reharmBtnWrapper, #transportControls')) return;
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
    const inDarkIdx = state.savedSections.dark.indexOf(normOut);

    if (inBasicIdx !== -1 || inDarkIdx !== -1) {
      if (inBasicIdx !== -1) state.savedSections.basic.splice(inBasicIdx, 1);
      if (inDarkIdx !== -1) state.savedSections.dark.splice(inDarkIdx, 1);
    } else {
      const targetSec = state.reharmSet === 'dark' ? 'dark' : 'basic';
      state.savedSections[targetSec].unshift(normOut);
    }
    persistVault();
    updateSaveButtonUI();
    renderSavedProgressionsList();
  },

  openSavedSection(secKey: 'basic' | 'dark') {
    if (Date.now() < justSwipedUntil) return;
    state.activeSavedSection = secKey === 'dark' ? 'dark' : 'basic';
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
      const targetSec = state.activeSavedSection || (state.reharmSet === 'dark' ? 'dark' : 'basic');
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

  loadSavedProgression(secKey: 'basic' | 'dark', idx: number) {
    if (Date.now() < justSwipedUntil) return;
    const sectionList = state.savedSections[secKey];
    if (!sectionList) return;
    const rawProg = sectionList[idx];
    if (!rawProg) return;
    const prog = normalizeProgressionString(rawProg);
    state.baseProgression = prog;
    state.userChangedBaseProgression = true;
    state.manualMeterOverride = false;
    state.selectedStrategy = 'strategy1';
    state.reharmActive = false;
    state.selectedTechnique = 'default';
    const input = document.getElementById('singleProgInput') as HTMLInputElement | null;
    if (input) input.value = prog;
    updateReharmSetUI();
    this.switchScreen('generator');
  },

  moveSavedProgression(secKey: 'basic' | 'dark', idx: number, direction: -1 | 1) {
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

  startEditSavedProgression(secKey: 'basic' | 'dark', idx: number) {
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

  saveEditSavedProgression(secKey: 'basic' | 'dark', idx: number) {
    const input = document.getElementById(`editSavedInput_${secKey}_${idx}`) as HTMLInputElement | null;
    if (input && input.value.trim()) {
      applySmartInputShortcuts(input);
      const parsed = parseInputByMeasures(input.value.trim());
      const formatted = parsed.length > 0
        ? formatMeasuresToString(parsed)
        : normalizeProgressionString(input.value.trim());
      if (formatted && state.savedSections[secKey]) {
        state.savedSections[secKey][idx] = formatted;
        if (secKey === 'basic' && idx < state.baseProgressionsPool.length) {
          state.baseProgressionsPool[idx] = formatted;
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

  deleteSavedProgression(secKey: 'basic' | 'dark', idx: number) {
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
    if (!state.savedSections.basic.includes(newProg)) {
      state.savedSections.basic.unshift(newProg);
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
        const basicIdx = state.savedSections.basic.indexOf(oldProg);
        if (basicIdx !== -1) {
          state.savedSections.basic[basicIdx] = formatted;
        }
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
      mList.map(m => m.map(c => `${c.chord}:${c.beats}`).join(',')).join('|');

    const currentDisplayed = state.reharmActive
      ? TargetBackwardEngine.executeReharm(
          parseInputByMeasures(state.baseProgression),
          state.selectedTechnique,
          state.selectedStrategy
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
        strat
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
