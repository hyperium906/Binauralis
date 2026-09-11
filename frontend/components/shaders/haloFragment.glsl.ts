/**
 * GLSL Fragment Shader for Dynamic Audio-Driven Pulsing Halo
 * Uses Fresnel rim glow modulated by real-time RMS audio amplitude.
 */
export const haloFragmentShader = `
uniform vec3 uColor;
uniform float uTime;
uniform float uRms; // Real-time audio RMS (0.0 to 1.0)

varying vec3 vNormal;
varying vec3 vViewPosition;

void main() {
    vec3 normal = normalize(vNormal);
    vec3 viewDir = normalize(vViewPosition);

    // Fresnel rim falloff
    float dotNV = dot(normal, viewDir);
    float fresnel = 1.0 - clamp(abs(dotNV), 0.0, 1.0);
    fresnel = pow(fresnel, 2.5);

    // Dynamic audio pulsation (subtle breathing base + sharp expansion on audio peaks)
    float basePulse = 0.5 + 0.5 * sin(uTime * 3.0);
    float audioIntensity = uRms * 3.5;
    float intensity = fresnel * (0.6 + 0.4 * basePulse + audioIntensity);

    float alpha = clamp(intensity * (0.4 + uRms * 0.6), 0.0, 0.95);
    vec3 glowColor = uColor * (1.0 + uRms * 2.0);

    gl_FragColor = vec4(glowColor, alpha);
}
`;
