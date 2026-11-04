# ReharmPro Engine Refactoring: Harmonic Embroidery, Stepping Stones, 3/4 Meter & Randomization

## Summary of Accomplishments

1. **Non-Destructive Harmonic Embroidery ("Keep & Weave" Rule)**:
   - Updated `reharmonizeProgressionBackward()` to treat original user chords as immovable structural pillars across additive modes (`strategy1`, `strategy4`, `strategy5`).
   - Early bars and internal bars ring out across their full durations rather than being arbitrarily chopped up into unplayable fragments.
   - Introduced upper-structure color overlays and subtle runway padding where chords ring out fully, only filling the authentic approach runway space leading to cadences.

2. **Creative & Rhythmic Variety In Between Beats**:
   - Implemented `TargetBackwardEngine.getSteppingStoneBridge(fromChord, toChord, techniqueId)`:
     - Organic interval calculation (semitone deltas) connecting any pair of chords.
     - Supports diatonic scalar passing bass (e.g., $C/B$ connecting $C \to Am$), chromatic diminished stepping stones (e.g., $C^\circ 7$ / $C\sharp^\circ 7$ connecting $C \to Dm$), secondary dominants ($V^7$), backdoor cadences ($\flat VII^7$), and minor subdominant variants ($iv^{m6}$).
     - Injected into beat grids via late pickups (Beat 4 in 4/4, Beat 3 in 3/4) and syncopated upbeat anticipation.

3. **Native 3/4 Waltz Meter Support**:
   - **`fillBarBeats()`**:
     - Single passing additions occupy Beat 3 (Beats 1-2 anchored to the base chord).
     - 3-chord passing cells map cleanly 1-to-1 to each beat (Beat 1, Beat 2, Beat 3) with full attack flags, removing former 4/4 truncation rules.
   - **`insertPassingIntoBar()`**:
     - For 3/4 runway measures, ii-V cells map to Beat 1 (base chord), Beat 2 (ii7), Beat 3 (V7), resolving cleanly to the downbeat of the subsequent measure.
   - **`applyTurnaroundToFinalBar()`**:
     - Explicit 3/4 turnaround support mapping Beat 1 (held chord), Beat 2 (ii7), Beat 3 (V7) back to the phrase start.
   - **`reharmonizeProgressionBasic()`**:
     - Updated `mu_major`, `mu_inversion`, `inner_sus`, `stepwise_inversion`, and `add9_triad` to permit 2+1 beat divisions in 3-beat measures.
   - **`parseInputByMeasures()`**:
     - Formats 3 chords in 3/4 measures to exactly 1 beat each.

4. **Balanced Randomization Pool (`ReharmMasterEngine`)**:
   - Randomization weighted 85–90% toward non-destructive additive strategies (`strategy1` through `strategy6`), and 10–15% toward dramatic substitutions/overhauls (`strategy7`, `strategy8`).
   - Ensures users frequently see inspiring, subtle harmonic embroidery (add9, mu major, pedal points, scalar bass, stepping stones) while retaining access to bold harmonic transformations.
   - Duplication filter guard continuously ensures that successive randomizations yield distinct, playable harmonic ideas.
