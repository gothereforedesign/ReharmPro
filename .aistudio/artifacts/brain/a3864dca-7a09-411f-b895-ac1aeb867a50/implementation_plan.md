# Implementation Plan - 45 Chord Progressions & Neo-Soul Category Incorporation

## Status: Completed & Verified

### Overview
Incorporated all 45 requested chord progressions into ReharmPro, added a dedicated **Neo-Soul** harmonic category to complement Basic, Jazz, and Dark, enhanced chord parsing and voicing for extended modern chords, and upgraded the Saved Progressions view into a balanced 2x2 grid.

### Details of Changes

1. **New Category Added: "Neo-Soul"**:
   - Accommodates extended and modern harmonies: minor 11ths, major 9ths, 6/9 chords, dominant altered/sus harmonies, and smooth voice-led cycles.
   - Screen 2's category overview now displays a balanced 2x2 grid:
     - `[ Basic ]` `[ Jazz ]`
     - `[ Dark  ]` `[ Neo-Soul ]`
   - In category detail view, the top header bar includes 1-tap quick switch buttons for the other three categories.

2. **Categorization of the 45 Progressions**:
   - **Basic** (Pop, Folk, Diatonic, Hymn):
     - `Cmaj7 | Fmaj7` (#4)
     - `Am | G | C | F` (#36)
     - `C | C/B | Am7 | Fmaj7` (#37)
     - `C | G | Am | F` (#38)
     - `C | C/B | C/A | C/F` (#42)
     - `C | Em | F | G` (#44)
     - `C | Am | F | G` (#45)
   - **Jazz** (Standards, Turnarounds, Cycles, Dominant Alterations):
     - `Cmaj7 | Am7 | Dm7 | G7` (#1)
     - `Dm7 | G7 | Cmaj7` (#3)
     - `Am7 | Dm7 | G7 | Cmaj7` (#6)
     - `Fmaj7 | Em7 | Am7 | Dm7` (#7)
     - `Cmaj7 | C#dim7 | Dm7 | G7alt` (#8)
     - `Cmaj7 | Fmaj7 | G7alt | Am7` (#10)
     - `Fmaj7 | E7 | Ebmaj7 | D7` (#13)
     - `Cmaj7 | C#dim7 | Dm7 | D#dim7` (#15)
     - `D7 | F#m7 | Am7b5` (#22)
     - `Dm7 | Abdim7 | Em7 | Bbdim7/A` (#27)
     - `G | F7 | Bb7 | D7` (#31)
     - `Fmaj7 | Ab7 | Gm7add2 | C7b9 - F#7` (#35)
   - **Dark** (Minor, Modal, Aeolian/Dorian, Andalusian):
     - `Cm7 | Fm7` (#2)
     - `Cm | Ab | Eb | Bb` (#5)
     - `Am11 | D7 | F7 | C7` (#18)
     - `Em9 | Bm9 | Dm9 | Am9` (#19)
     - `Cmaj7 - B7 | B | Em | G7` (#29)
     - `Am | Dm9 | Em7 | A#dim` (#33)
     - `Am | G | F | E7` (#39)
     - `Am | D | G | Am` (#43)
   - **Neo-Soul** (Rich Extended Harmony, Modern R&B, Lo-Fi, Planing):
     - `Dm7(add11) | Em7(add11) | Fmaj7` (#9)
     - `Dm11 | Ebmin11` (#11)
     - `Cm7 | Bmaj7 | Bbmin7 | Amaj7` (#12)
     - `Cm11 | Bm11 | Bbmin11 | Amin11` (#14)
     - `Cm9 | Dbmaj9 | F9 | Bmaj9` (#16)
     - `C9 | B7aug | Em7 | Dm7 | G13` (#17)
     - `Fm9 | Eb9 | Fm11 | C7b9` (#20)
     - `Cm9 | Cm11 | Bb9 | D7b9` (#21)
     - `Em11 | A13 | D9 | D#dim7` (#23)
     - `C6/9 | C6/9 | C6/9 | Bb9 | C9#11` (#24)
     - `C9 | Am9 | F9` (#25)
     - `Fm9 | Bb9sus4 | Bb/C | C7b9` (#26)
     - `Bb7 | Bb7/D | Eb7 | Eb9(#9)` (#28)
     - `Dm7 | C/E | Dm9 | Ab-6 | Am11 - Bb7sus | A7` (#30)
     - `Bbmaj7 | A7aug | Dm11 | Cm9 - F7add2` (#32)
     - `Am9 | Dm9 | G7sus2 | Cmaj9` (#34)

3. **Parser, Display & Audio Engine Enhancements**:
   - `Chord.fromSymbol`: Extended support for `6/9`, `maj9` (`Δ9`), `9#11`, `9sus4`, `7#9`, `7aug`, `m7(add11)`/`min11`, `m7add2`/`min9`, jazz `-6` (e.g., `Ab-6` -> `Abm6`), and slash chords vs. intra-bar splits.
   - `formatChordHtml`: Superscript formatting for `6/9`, `Δ9`, `maj9`, `9#11`, `9sus4`, `7sus4`, `7sus2`, `7aug`, `7#9`, `m7(add11)`, `m7add2`, `m11`, etc.
   - `audioEngine.ts`: Voicing intervals support `maj9`, `6/9`, `9#11`, `7#9`, and suspended dominants with authentic Rhodes upper structures.
   - `normalizeProgressionString`: Handles intra-bar chord cells, strips parentheses cleanly, and preserves multi-chord measure timing.
   - Self-healing storage migration ensures existing browser storage merges in all new defaults automatically.
