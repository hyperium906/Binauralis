/**
 * Stem node shell — fragment stage.
 *
 * The governing rule of the whole scene: light has a WHITE CORE and a
 * COLOURED FALLOFF. A flat coloured glow reads as plastic; real emitters
 * blow out to white at the centre and carry their hue only in the skirt.
 * So the rim term drives a mix from the stem hue toward white, and the
 * bloom pass downstream does the rest.
 *
 * uLevel is the stem's own signal level, not a decorative oscillator — the
 * shell tightens and brightens with what the stem is actually doing.
 */
export const haloFragmentShader = `
uniform vec3  uColor;
uniform float uLevel;    // 0..1 stem signal level
uniform float uSelected; // 0 or 1

varying vec3 vNormal;
varying vec3 vView;
varying vec3 vLocal;

void main() {
    vec3 n = normalize(vNormal);
    vec3 v = normalize(vView);

    // Rim: grazing angles are bright, face-on is transparent.
    float rim = 1.0 - clamp(abs(dot(n, v)), 0.0, 1.0);

    // A tighter exponent when the stem is loud: the shell reads as a thin
    // hot skin rather than a soft cloud.
    float tightness = mix(3.4, 2.0, clamp(uLevel, 0.0, 1.0));
    rim = pow(rim, tightness);

    // Selection adds a second, wider rim so the active node is obvious
    // without changing its hue.
    float halo = pow(1.0 - clamp(abs(dot(n, v)), 0.0, 1.0), 1.25) * uSelected * 0.30;

    float energy = rim * (0.55 + uLevel * 1.60) + halo;

    // White core, coloured falloff.
    vec3 tint = mix(uColor, vec3(1.0), clamp(energy * 0.55, 0.0, 0.85));

    float alpha = clamp(energy, 0.0, 1.0) * (0.42 + uLevel * 0.38);

    gl_FragColor = vec4(tint * (0.85 + uLevel * 0.9), alpha);
}
`;

/**
 * Floor graticule — the polar measurement grid.
 *
 * Drawn as a single plane rather than dozens of line meshes: the rings and
 * bearings are computed analytically, which means they stay pixel-crisp at
 * any camera distance and dissolve smoothly at the edge instead of ending
 * on a hard circle. Nothing here is decoration — every ring is a metre.
 */
export const floorVertexShader = `
varying vec2 vXY;

void main() {
    vXY = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const floorFragmentShader = `
uniform vec3  uGrid;
uniform vec3  uEdge;
uniform float uOuter;   // stage radius, metres
uniform float uInner;   // minimum source distance, metres

varying vec2 vXY;

// Analytic line: 1.0 on the line, 0 off it, width held constant in pixels.
float band(float x, float period, float width) {
    float f = abs(fract(x / period - 0.5) - 0.5) * period;
    float d = fwidth(x) * width;
    return 1.0 - smoothstep(0.0, d, f);
}

void main() {
    float r     = length(vXY);
    float theta = atan(vXY.y, vXY.x);

    // Distance rings every 0.5 m, with the whole-metre rings carrying more weight.
    float half_m = band(r, 0.5, 1.1) * 0.40;
    float whole_m = band(r, 1.0, 1.4) * 0.92;

    // Bearing spokes every 30 degrees. Spacing in arc length so they do not
    // crowd into a solid disc near the listener.
    float arc    = theta * max(r, 0.35);
    float spokes = band(arc, 0.5236 * max(r, 0.35), 1.1) * 0.34;

    float grid = max(max(half_m, whole_m), spokes);

    // Radial falloff: nothing inside the near-field clamp, nothing past the
    // stage. No hard edge anywhere.
    grid *= smoothstep(uInner * 0.22, uInner * 0.95, r);
    grid *= 1.0 - smoothstep(uOuter * 0.88, uOuter * 1.02, r);

    // The stage boundary itself, drawn once, brighter.
    float edge = 1.0 - smoothstep(0.0, fwidth(r) * 2.0, abs(r - uOuter));

    vec3  col = mix(uGrid, uEdge, edge);
    float a   = clamp(grid + edge * 0.85, 0.0, 1.0);

    if (a < 0.002) discard;
    gl_FragColor = vec4(col, a);
}
`;

/**
 * Wavefront — the one piece of continuous motion in the scene.
 *
 * A ring expanding from a stem toward the listener. uProgress is driven in
 * real time from the stem's actual distance, so the ring reaches the
 * listener when the sound would: it is showing propagation delay, which is
 * exactly what the HRIR convolution encodes.
 */
export const wavefrontVertexShader = `
varying vec2 vXY;

void main() {
    vXY = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const wavefrontFragmentShader = `
uniform vec3  uColor;
uniform float uProgress;  // 0 at the source, 1 at the listener
uniform float uRadius;    // plane half-extent, metres
uniform float uStrength;

varying vec2 vXY;

void main() {
    float r    = length(vXY);
    float head = uProgress * uRadius;

    // Thin leading edge, short skirt behind it. The edge is kept narrow on
    // purpose: a wide one reads as a smoke ring rather than a wavefront.
    float d    = r - head;
    float ring = exp(-pow(d * 26.0, 2.0));
    float wake = exp(-pow(max(d, 0.0) * 5.5, 2.0)) * 0.14;

    // Energy drops with distance travelled, and the whole thing fades out as
    // it lands so there is no pop at arrival.
    float decay = (1.0 - uProgress) * (1.0 - uProgress);

    float a = (ring + wake) * decay * uStrength * 1.5;
    if (a < 0.003) discard;

    // Hue survives the crest; only the very peak goes white.
    vec3 tint = mix(uColor, vec3(1.0), ring * ring * 0.45) * 1.35;
    gl_FragColor = vec4(tint, clamp(a, 0.0, 1.0));
}
`;
