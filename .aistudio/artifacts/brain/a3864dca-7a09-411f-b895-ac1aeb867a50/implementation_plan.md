# Electric Piano Suite (Distinct EP Styles & Vintage FX)

Upgrade ReharmPro's playback engine to feature four distinctly different, iconic electric piano styles—Rhodes, Wurlitzer, DX7 FM, and Clavinet/Pianet—coupled with deep lush analog chorus, warm tape saturation, and an integrated quick-tap sound selector inside the tempo transport controls.

## User Review & Critical Decisions

> [!IMPORTANT]
> The following user preferences were confirmed during clarification and govern the playback architecture:

- **Confirmed Electric Piano Styles**: One of each iconic, distinctly different EP category:
  1. **Rhodes Mk I (Tine-Based)**: Warm, woody low-end with sweet bell-like tine attack and smooth singing sustain (classic Neo-Soul / Jazz).
  2. **Wurlitzer 200A (Reed-Based)**: Punchy midrange bark, metallic reed grit on stronger velocities, and dry soul/funk presence.
  3. **Yamaha DX7 E-Piano (Digital FM)**: Crystalline, glassy tines with bright layered bell sparkle (classic 80s/90s ballad and R&B).
  4. **Clavinet D6 / Pianet (Plucked/Pad)**: Sharp percussive snap, tight funky bite, and direct articulation.
- **Confirmed UI Location**: Quick-tap selector embedded directly inside the tempo transport bar for seamless one-tap sound cycling or popup selection.
- **Confirmed FX Character**: Deep lush analog chorus (dual modulated BBD stereo ensemble) paired with warm analog tape soft-saturation and studio scoring stage room depth.

---

## 1. Overview & Core Concept

- **What It Delivers**: Replaces acoustic grand piano playback with four authentic electric piano voices. Tapping or playing progressions immediately channels the warm, vibrating character of vintage electro-acoustic and digital keys.
- **Instant Sonic Variety**: Users can switch instruments on the fly with a single tap inside the transport bar while chords are looping to hear how reharmonizations breathe in different keyboard timbres.
- **Zero Latency**: Real-time sound synthesis and high-performance Web Audio DSP ensure instantaneous voice triggering, smooth voice leading, and no download delays.

---

## 2. Distinct Electric Piano Sound Models

### 1. Rhodes Mk I (Tine Physics)
- **Acoustic Mechanism**: Rubber hammer striking a steel tine, resonated by a tonebar.
- **Timbre**: Deep grounded fundamental (triangle-sine core) + resonant 3rd and 7th tine chime harmonics on strike + smooth warm body decay.
- **Voice EQ**: Warm low-mid boost (280Hz +2.5dB), gentle roll-off above 4.5kHz.

### 2. Wurlitzer 200A (Steel Reed Physics)
- **Acoustic Mechanism**: Felt hammer striking a vibrating steel reed in an electrostatic pickup.
- **Timbre**: Hollow odd-harmonic reed structure (square/saw hybrid + bandpass peak at 1.4kHz) with dynamic "bark" saturation on accent velocities.
- **Voice EQ**: Focused punchy midrange (800Hz - 1.8kHz), tight bass floor.

### 3. Yamaha DX7 E-Piano (FM Digital Synthesis)
- **Synthesis Mechanism**: 2-operator FM (Frequency Modulation) with carrier:modulator frequency ratio 1:14 (bell tines) plus 1:1 carrier for glassy body.
- **Timbre**: Crystalline high tines, pristine metallic bell transient, bright chorus sparkle.
- **Voice EQ**: Crisp high-frequency sheen (5.5kHz +2dB), transparent bass.

### 4. Clavinet D6 (Plucked Reed Physics)
- **Acoustic Mechanism**: Yarn-damped strings struck against anvil pickups with sharp plectrum release.
- **Timbre**: Instant percussive attack (<2ms), biting mid-range harmonics, short tight decay.
- **Voice EQ**: Slanted treble bite (2.2kHz +3dB), quick envelope damping.

---

## 3. Vintage FX Processing Chain

```
┌────────────────────────────────────────────────────────┐
│             Active Polyphonic EP Voice Engine          │
│   (Rhodes Tines | Wurli Reeds | DX7 FM | Clavinet)     │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│             Analog Tape Soft-Saturation Stage          │
│   - Tanh soft-clipping transfer curve                  │
│   - Warm tube preamp harmonic overdrive                │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│             Deep Lush Stereo Chorus / Ensemble         │
│   - Dual modulated BBD delays (L: 12ms / R: 16ms)      │
│   - Multi-phase LFO (0.42Hz sine / 0.55Hz triangle)    │
│   - Wide stereo dimension and rich movement            │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│             Studio Scoring Stage Room & Limiter        │
│   - Natural wooden room convolution reverb             │
│   - Studio mastering dynamic range compressor          │
└──────────────────────────┬─────────────────────────────┘
                           ▼
                 AudioContext.destination
```

---

## 4. User Experience & Transport Controls

### Quick-Tap Selector in Transport Bar
- Located seamlessly beside the BPM slider/badge inside `#transportControls`.
- Displays the current sound profile:
  - `[ Rhodes ]` (Warm Suitcase)
  - `[ Wurli ]` (200A Reed)
  - `[ DX7 ]` (FM Tines)
  - `[ Clav ]` (Plucked D6)
- **Interaction**:
  - **Single Tap**: Instantly cycles to the next electric piano model without stopping playback.
  - **Press / Long-tap or Dropdown**: Pops up a clean floating 4-item menu to jump directly to any model.
- **Persistent Selection**: The selected EP model is automatically saved to the persistent storage vault across browser sessions.

---

## 5. Technical Implementation Details

1. **`src/audioEngine.ts`**:
   - Add `type ElectricPianoModel = 'rhodes' | 'wurlitzer' | 'dx7' | 'clavinet'`.
   - Implement dedicated sound synthesis models tailored to the physical resonance of each instrument.
   - Upgrade the master chain to feature the deep lush dual-LFO stereo chorus and analog tape saturation curve.
   - Add `getModel(): ElectricPianoModel` and `setModel(model: ElectricPianoModel)`.
2. **`src/main.ts`**:
   - Add state tracking for `selectedEPModel`.
   - Persist EP model in LocalStorage, IndexedDB, and CacheStorage vault payloads.
   - Bind quick-tap cycling and selection events.
3. **`index.html`**:
   - Integrate the minimal quick-tap EP selector pill into the transport bar.
