/**
 * Stem node shell — vertex stage.
 * Passes the view vector so the fragment stage can compute a rim term, and
 * the object-space position so it can fade the shell against the floor.
 */
export const haloVertexShader = `
varying vec3 vNormal;
varying vec3 vView;
varying vec3 vLocal;

void main() {
    vNormal = normalize(normalMatrix * normal);
    vLocal  = position;

    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vView   = -mv.xyz;

    gl_Position = projectionMatrix * mv;
}
`;
