# Functional Harmonic Analysis & Adaptive Target Accommodation in ReharmPro

## Overview
The ReharmPro reharmonization engine has been extended with a two-part architectural enhancement:
1. **Functional Key & Harmonic Analysis & Substitution Engine**: Identifies key centers, assigns harmonic functions (Tonic, Subdominant, Dominant), and introduces creative functional substitutions (~35% probability).
2. **Adaptive Target & Runway Accommodation Layer**: Enables landing target chords to dynamically adapt their voicings, color extensions, and chord qualities to incoming cadence runway cells.

---

## 1. Functional Key & Harmonic Analysis Module
- **`TargetBackwardEngine.inferKeyCenter(measures)`**: Analyzes chord frequencies, durations, and qualities across the phrase to deduce tonic root and mode (major vs. minor).
- **`TargetBackwardEngine.getHarmonicFunction(chord, tonicRoot, isMinorKey)`**:
  - **Tonic Family**: $I, i, vi, vi^7, iii, iii^7, \flat III, \flat VI$
  - **Subdominant Family**: $IV, iv, ii, ii^7, ii^{\emptyset 7}, iv^{m6}$
  - **Dominant Family**: $V, V^7, vii^\circ, vii^{\emptyset 7}, \flat II^7$ (Tritone sub), $V^{7\text{alt}}$

---

## 2. Functional Substitution Engine (35% Creative Probability)
- **`TargetBackwardEngine.getFunctionalSubstitutions(chord, tonicRoot, isMinorKey)`**:
  - **Tonic Substitutions**: Swapping bright $I$ major chords for relative minor ($vi^7$), mediant minor ($iii^7$), warm $6/9$, or lush $\Delta 9$.
  - **Subdominant Substitutions**: Swapping $IV$ major for relative supertonic ($ii^7$ or $ii^9$), or borrowed minor subdominant ($iv^{m6}$).
  - **Dominant Substitutions**: Swapping standard $V^7$ for tritone substitutions ($\flat II^7$), leading-tone diminished ($vii^{\circ 7}$), or altered dominants ($V^{7\text{alt}}, V^{7\sharp 9}$).
- **`TargetBackwardEngine.applyFunctionalSubstitutions(measures, lockedMeasures, maxSwaps = 1)`**:
  - Runs with a **35% probability check** during randomization on uncrowded bars, preserving locked measures and providing fresh structural starting points before passing chords are woven.

---

## 3. Adaptive Target & Runway Accommodation Layer
- **`TargetBackwardEngine.adaptTargetChord(targetChord, approachTechnique)`**:
  - Runway approaches and target chords talk to each other to guarantee maximum voice-leading cohesion:
    - **Backdoor Approach ($\flat VII^7$)**: Target chord adapts to $6/9$ or $\Delta 9$ (or $m^9$) for a silky, classic soul/fusion resolution.
    - **Tritone Sub Approach ($\flat II^7$)**: Target chord adapts to $\Delta 7$ or $6/9$ (or $m^9$) for smooth semitone voice resolution.
    - **Altered Dominant Expansion ($V^{7\text{alt}}$ / $V^{7\sharp 9}$)**: Target chord adapts to clean, resonant major 7th / minor 7th extensions.
    - **Lydian & Dark Chromatic Mediants**: Target chord adapts to $\Delta\sharp 11$ or $m^6$.
  - Injected directly into `reharmonizeProgressionBackward()` to update target beat slots seamlessly.

---

## 4. Balanced Integration with 5-Tier Neighborhoods
- Randomizer rolls now produce a rich spectrum:
  - **Additive Rolls (~65%)**: Keep user chords 100% intact, embroidering passing chords, stepping stones, and color extensions.
  - **Functional Swap Rolls (~35%)**: Creatively substitute a base chord for a functional alternative (e.g., $IV \to ii^7$ or $I \to vi^7$) before weaving passing lines.
  - **Target Adaptation (~50% of approach rolls)**: Landing target chord subtly adjusts extensions to match incoming approach cells.
