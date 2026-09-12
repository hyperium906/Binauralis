# AuraStream — brand and interface system

## The idea

AuraStream is a spatial monitor. You place four stems around a listener and
hear them binaurally, in real time.

Its peers are not games or crypto dashboards. They are the tools mix engineers
already trust: the Dolby Atmos panner, Nuendo, dearVR, Sound Particles. To that
audience "high technology" does not mean more neon. It means **precision made
legible** — instruments, graticules, calibrated light.

So the governing image is the **anechoic chamber**: the room where HRTFs are
actually measured, and therefore where the HRIR data this engine convolves with
comes from. Cold light, matte surfaces, one source in the room, and nothing
reflecting.

---

## The rule that governs everything

> **Light has a white core and a coloured falloff.**

A flat, evenly coloured glow reads as plastic. Real emitters blow out to white
at the centre and carry their hue only in the skirt. Every luminous element in
this system obeys this — the logo's source dot, the stem cores in the 3D scene,
the shell shader, the wavefronts.

In the 3D scene this is not faked. Cores are driven past 1.0 into an ACES tone
mapper with a bloom pass behind it, so the desaturation happens the way it does
in a camera.

---

## Colour

### Chamber

| Token | Hex | Use |
| :--- | :--- | :--- |
| `--void` | `#06080B` | The room. Page and canvas ground. |
| `--wedge` | `#0D1118` | Panel face. |
| `--wedge-rise` | `#131925` | Panel, raised or hovered. |
| `--graticule` | `#222A36` | Measurement hairline. Every border in the UI. |
| `--graticule-l` | `#2F3A49` | Hairline, emphasised. |

### Light

| Token | Hex | Use |
| :--- | :--- | :--- |
| `--signal` | `#E8F3FF` | Calibrated light. Primary text, the accent. Near-white with a cold cast — never a saturated neon. |
| `--signal-dim` | `#8A99AC` | Secondary text. |
| `--signal-mute` | `#55616F` | Labels, units, axis text. |
| `--caution` | `#FFAE3D` | **Threshold and over only.** Never decoration. If it is warm, something needs attention. |

### Sources

The four stems ride **one ramp ordered by spectral centroid**. Low frequencies
sit deep and saturated; high frequencies rise toward the colour of the light
itself. The hue is information — it tells you where in the spectrum the stem
lives — not four arbitrary identity colours.

| Stem | Token | Hex | Band |
| :--- | :--- | :--- | :--- |
| Bass | `--stem-bass` | `#7C4DFF` | Below 250 Hz |
| Drums | `--stem-drums` | `#4A7CF8` | Broadband, transient |
| Instruments | `--stem-other` | `#2FB6E9` | 250 Hz – 4 kHz |
| Vocals | `--stem-vocals` | `#8FE6FF` | Presence, 1 – 6 kHz |

**Equalising the ramp.** Because the ramp runs dark to bright by design, the low
stems carry far less luminance and fall under the bloom threshold while the high
ones blow out. In the 3D scene each core is scaled by `1.62 / luminance` so all
four read with the same presence. The ramp stays information; it does not double
as a brightness ranking.

---

## Type

Two families, each with one job.

- **Archivo** — all interface text. An engineered grotesque: tight, high
  legibility, real weight range. Weights in use: 400, 500, 600.
- **Azeret Mono** — **numerals only**, via `.num`. It is here for one functional
  reason: tabular figures stop digits jittering while a source is being dragged.
  It is not a decorative "technical" face, and labels never use it.

Sentence case throughout. No tracked-out all-caps eyebrows.

---

## The mark

One idea: **a point source radiates spherical wavefronts across the stage, and
the listener sits on the wavefront that is arriving right now.**

- The **source** is a solid white dot — it emits.
- The **listener** is an open ring — it receives.
- The **wavefronts** are full circles centred on the source, cropped by the
  stage boundary. The one passing through the listener is brightest.

The source sits near the boundary on purpose. Wavefronts then crop into broad
sweeping arcs instead of closing into concentric rings around the dot — which is
what makes the difference between this and a wifi glyph or a target.

Monochrome. No gradients. No letterform. Regenerate from
`scratchpad/genmark.py`-style geometry if it ever needs resizing; do not
hand-edit the arc paths.

### Files

| File | Use |
| :--- | :--- |
| `logo_mark.svg` | 64px master. The mark alone. |
| `logo_full.svg` | Mark plus wordmark, 268 × 64. |
| `favicon.svg` | 32px. Stage ring and faintest wavefront dropped, strokes thickened so it survives 16px. |
| `app_icon.svg` | 512px, rounded square, with the chamber gradient. |
| `banner.svg` | 1200 × 630 social card. |
| `favicon.ico` | 16 / 32 / 48 / 64 PNG frames. |

**Minimum sizes.** `logo_mark.svg` holds down to 24px. Below that use
`favicon.svg`, which is drawn for it.

**Clear space.** Keep a margin of one listener-ring diameter on every side.

**Do not**: recolour the mark per stem, add a gradient, put it on a light ground
without its dark plate, rotate it, or stretch the lockup.

> The wordmark in `logo_full.svg` and `banner.svg` is set in live `<text>` with
> an Archivo → Helvetica → Arial fallback. It renders correctly wherever Archivo
> is available. If these need to be pixel-stable on arbitrary machines, convert
> the text to outlines.

---

## Surfaces

Instruments do not have drop shadows, and they do not have frosted glass.

- Panels are **flat matte fills** separated by **1px hairlines**. No shadows, no
  glass, no blur — the single exception is the scrim behind the canvas
  instruction, which sits directly on the graticule and would otherwise be
  unreadable.
- **Zero border radius** on panels and controls. The only round things in the
  system are the ones that are physically round: sources, the listener, the
  stage, the bearing dial.
- Every border is a measurement line. If a line is not separating two different
  kinds of information, delete it.

---

## The 3D stage

- **Coordinates** match the DSP exactly: +X right, +Y forward, +Z up, listener
  at the origin. The camera's up vector is +Z.
- **Floor** is an analytic polar graticule computed in the fragment shader, not
  line meshes — so it stays crisp at any zoom and dissolves at the stage edge
  rather than ending on a hard circle. Rings every 0.5 m, whole metres heavier,
  bearing spokes every 30°.
- **Bounds** are real: sources are held between 0.5 m (where the inverse-distance
  law runs away) and 3.0 m (past which they are inaudible).
- **Post** is one `UnrealBloomPass` at strength 0.62, threshold 0.72. It is what
  turns an emissive material into light. Do not raise it to compensate for a dim
  material — fix the material.

### Motion

There is exactly **one** continuous motion in the product, and it is meaningful:

> **Wavefront propagation.** Moving a source launches a ring that expands across
> the measurement floor and reaches the listener after a delay proportional to
> distance. It is showing propagation delay — the thing the HRIR convolution
> actually encodes.

Everything else moves only in response to input. No idle orbiting, no drifting
particles, no fade-and-slide entrances. `prefers-reduced-motion` disables
wavefronts entirely.

---

## Writing

Name things the way a person using them would. "Instruments", not "Other /
Synth". "Directly ahead", not "FRONT CENTER". Units are lowercase and small;
numbers are the thing being read.

Never let a meter invent numbers without saying so. When no engine is attached
the masthead reads **Demo signal**, not **Binaural active**.
