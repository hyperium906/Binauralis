# AuraStream Brand & Design System Guidelines

This document outlines the visual identity, brand marks, color palettes, typography, and asset specifications for the **AuraStream Spatial Audio Platform**.

---

## 💎 Brand Vision & Aesthetic

AuraStream embodies high-precision audio engineering merged with a futuristic, holographic soundstage.
The visual identity communicates:
1. **Technical Precision**: Mathematical rigor, sample-accurate DSP, and clean telemetry readouts.
2. **Spatial Immersion**: Three-dimensional sound propagation, orbital stem positioning, and binaural ear cues.
3. **Vibrant Modernity**: Dark obsidian backgrounds illuminated by glowing neon neon chromatic accents.

---

## 🎨 Color Palette & Design Tokens

AuraStream uses a curated high-contrast dark palette tailored for audio engineers working in studio environments.

### Primary Accents (Spatial Stems)

| Stem Role | Token Name | Hex | RGB | HSL | Semantic Meaning |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Lead Vocals** | `--stem-vocals` | `#ff007f` | `255, 0, 127` | `hsl(330, 100%, 50%)` | Focal presence, upfront center stage |
| **Drums & Percussion** | `--stem-drums` | `#00f2fe` | `0, 242, 254` | `hsl(184, 100%, 50%)` | Transient clarity, rhythm, stereo width |
| **Sub Bass** | `--stem-bass` | `#ffaa00` | `255, 170, 0` | `hsl(40, 100%, 50%)` | Warm low-end weight, foundation |
| **Other / Synths** | `--stem-other` | `#00ff88` | `0, 255, 136` | `hsl(152, 100%, 50%)` | Harmonic fill, ambient textures, space |

### Neutral & Surface Hierarchy

| Element | Hex / CSS Value | Description |
| :--- | :--- | :--- |
| **Obsidian Void** | `#050811` | Primary workstation background |
| **Dark Slate Surface** | `#0a0f1d` | Card & sidebar backdrop |
| **Glassmorphic Fill** | `rgba(15, 23, 42, 0.75)` | Floating HUD with `backdrop-filter: blur(16px)` |
| **Glass Border** | `rgba(255, 255, 255, 0.10)` | Crisp 1px structural dividing lines |
| **Primary Text** | `#f8fafc` | Pure bright contrast |
| **Secondary Text** | `#94a3b8` | Muted labels, units, and secondary notes |

---

## 🔤 Typography System

AuraStream pairs a fluid geometric display typeface with a precision monospaced typeface:

### 1. Display & Interface: `Outfit`
- **Source**: Google Fonts (`Outfit:wght@300;400;500;600;700;800`)
- **Usage**: Brand titles, dialog headers, buttons, navigation, and modal labels.
- **Weights**:
  - `800` (Extra Bold): Hero headers and brand wordmark.
  - `600` (Semi Bold): Section cards and control buttons.
  - `400` (Regular): Instructions and descriptive copy.

### 2. Telemetry & DSP Readouts: `JetBrains Mono`
- **Source**: Google Fonts (`JetBrains+Mono:wght@400;500;600;700`)
- **Usage**: Coordinate tables $(X, Y, Z, \theta, \phi)$, sample rates, buffer sizes, LUFS loudness meters, and latency stats.
- **Weights**:
  - `700` (Bold): Numeric values and status pills (`ZERO-ALLOC`, `-14.0 LUFS`).
  - `500` (Medium): Coordinate labels (`AZIMUTH`, `ELEVATION`, `GAIN`).

---

## 📐 Logo Assets & Deliverables

All master vector assets reside in the `/brand` directory:

| File | Resolution / ViewBox | Purpose |
| :--- | :--- | :--- |
| [logo_mark.svg](file:///Users/joshuadupati/Developer/Binauralis/brand/logo_mark.svg) | `100x100` (Square) | Standalone spatial audio emblem with concentric binaural waves and 4-stem nodes. |
| [logo_full.svg](file:///Users/joshuadupati/Developer/Binauralis/brand/logo_full.svg) | `440x100` (Horizontal) | Primary logo lockup uniting mark + "AuraStream" wordmark and "SPATIAL AUDIO ENGINE" subtitle. |
| [app_icon.svg](file:///Users/joshuadupati/Developer/Binauralis/brand/app_icon.svg) | `512x512` (Squircle) | macOS, iOS, and desktop application launcher icon with obsidian glassmorphic rim. |
| [favicon.svg](file:///Users/joshuadupati/Developer/Binauralis/brand/favicon.svg) | `32x32` (Square) | High-contrast vector browser favicon legible at 16x16 and 32x32. |
| [banner.svg](file:///Users/joshuadupati/Developer/Binauralis/brand/banner.svg) | `1200x630` (1.91:1) | High-resolution social share, OpenGraph, and GitHub repository hero banner. |

---

## ⚠️ Brand Usage Rules

### Do's:
- **Do** place the glowing logo marks against dark or obsidian backgrounds (`#050811` or `#0a0f1d`) for maximum chromatic punch.
- **Do** maintain the exact stem color pairings: `vocals` = Magenta, `drums` = Cyan, `bass` = Gold, `other` = Emerald.
- **Do** preserve the aspect ratio and minimum clear space around the logo equal to the radius of the central listener core.

### Don'ts:
- **Don't** invert the logo to black-on-white or strip the neon gradients.
- **Don't** replace the `Outfit` or `JetBrains Mono` fonts with system serifs or generic sans fonts.
- **Don't** compress or stretch the logo mark or app icon out of proportion.
