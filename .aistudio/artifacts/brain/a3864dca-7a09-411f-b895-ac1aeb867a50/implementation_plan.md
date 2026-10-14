# Implementation Plan - SoundFont (.sf2) Support for Keyboard Section

## User Request
- The app needs to receive sf2 files for keyboard section. Make this change.

## Proposed Changes
1. **Audio Engine (`src/audioEngine.ts`)**:
   - Import `SoundFont2` from `soundfont2-esm`.
   - Add `private customSoundFont: SoundFont2 | null = null;` and `private sfAudioBufferCache = new Map<string, AudioBuffer>();` to `ChordAudioEngine`.
   - Add `public async loadSoundFont(arrayBuffer: ArrayBuffer)` method to parse `.sf2` binaries into `SoundFont2`.
   - Add `public clearCustomInstrument()` method to clear both custom instrument sample and custom soundfont.
   - Update `scheduleSingleVoice` to query `this.customSoundFont.getKeyData(midi)`.
   - Extract raw 16-bit sample PCM data from SF2 sample headers, convert to normalized `AudioBuffer`, cache it, and play it back with correct sample rate, pitch correction, and note frequency transposition.

2. **UI & Handlers (`index.html` & `src/main.ts`)**:
   - Update `index.html` file input accept attribute for custom instrument to include `.sf2`.
   - Update `handleCustomInstrumentUpload` in `src/main.ts` to detect `.sf2` files (by extension or mime type) and call `loadSoundFont`, or fallback to WAV/MP3 sample loading.
   - Update instrument upload status indicators to show the loaded SoundFont name.

## Verification Plan
- Compile applet with `compile_applet`.
- Lint with `lint_applet`.
