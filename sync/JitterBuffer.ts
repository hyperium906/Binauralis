import { StemName, Vector3D } from './protocol';

export interface SpatialKeyframe {
    position: Vector3D;
    timestamp: number; // Server timestamp in ms
}

export interface JitterBufferOptions {
    interpolationDelayMs?: number; // Render delay buffer (default: 40ms)
    maxBufferSize?: number;        // Maximum keyframes per stem (default: 32)
}

export class JitterBuffer {
    private readonly interpolationDelayMs: number;
    private readonly maxBufferSize: number;

    // Separate keyframe queue per stem
    private keyframes: Map<StemName, SpatialKeyframe[]> = new Map();

    // Last evaluated smooth positions
    private currentPositions: Map<StemName, Vector3D> = new Map();

    constructor(options: JitterBufferOptions = {}) {
        this.interpolationDelayMs = options.interpolationDelayMs || 40;
        this.maxBufferSize = options.maxBufferSize || 32;

        const stems: StemName[] = ['vocals', 'drums', 'bass', 'other'];
        for (const s of stems) {
            this.keyframes.set(s, []);
            this.currentPositions.set(s, { x: 0, y: 1.0, z: 0 });
        }
    }

    /**
     * @brief Push incoming network position keyframe into jitter queue.
     */
    public pushKeyframe(stem: StemName, position: Vector3D, timestamp: number): void {
        const queue = this.keyframes.get(stem);
        if (!queue) return;

        // Discard outdated out-of-order packets older than existing tail
        if (queue.length > 0 && timestamp < queue[queue.length - 1].timestamp) {
            return;
        }

        queue.push({
            position: { x: position.x, y: position.y, z: position.z },
            timestamp
        });

        // Maintain fixed size
        if (queue.length > this.maxBufferSize) {
            queue.shift();
        }
    }

    /**
     * @brief Evaluates smooth continuous 3D position using Cubic Hermite Spline interpolation.
     * @param stem Target stem name
     * @param currentServerTimeMs Current synchronized server timestamp
     * @return Smooth Vector3D position with guaranteed C1 velocity continuity
     */
    public evaluate(stem: StemName, currentServerTimeMs: number): Vector3D {
        const queue = this.keyframes.get(stem);
        const fallback = this.currentPositions.get(stem) || { x: 0, y: 1, z: 0 };

        if (!queue || queue.length === 0) {
            return fallback;
        }

        if (queue.length === 1) {
            const p = queue[0].position;
            this.currentPositions.set(stem, p);
            return p;
        }

        // Render time delayed by interpolation window
        const renderTime = currentServerTimeMs - this.interpolationDelayMs;

        // 1. If renderTime is older than our oldest keyframe, clamp to oldest
        if (renderTime <= queue[0].timestamp) {
            const p = queue[0].position;
            this.currentPositions.set(stem, p);
            return p;
        }

        // 2. If renderTime has passed the newest keyframe (network stall / packet loss),
        // gracefully extrapolate or clamp to newest
        const newest = queue[queue.length - 1];
        if (renderTime >= newest.timestamp) {
            this.currentPositions.set(stem, newest.position);
            return newest.position;
        }

        // 3. Find the surrounding keyframe pair: queue[i] <= renderTime < queue[i+1]
        let idx = 0;
        for (let i = 0; i < queue.length - 1; ++i) {
            if (queue[i].timestamp <= renderTime && renderTime < queue[i + 1].timestamp) {
                idx = i;
                break;
            }
        }

        const k0 = queue[idx];
        const k1 = queue[idx + 1];

        const dt = k1.timestamp - k0.timestamp;
        if (dt <= 0.001) {
            return k0.position;
        }

        // Normalized interpolation parameter s in [0, 1]
        const s = (renderTime - k0.timestamp) / dt;

        // 4. Calculate finite difference velocities m0 and m1
        // m0 uses k0's predecessor (kPrev) and k1
        const kPrev = idx > 0 ? queue[idx - 1] : k0;
        const dtPrev = k1.timestamp - kPrev.timestamp;
        const m0x = dtPrev > 0 ? (k1.position.x - kPrev.position.x) / dtPrev : 0;
        const m0y = dtPrev > 0 ? (k1.position.y - kPrev.position.y) / dtPrev : 0;
        const m0z = dtPrev > 0 ? (k1.position.z - kPrev.position.z) / dtPrev : 0;

        // m1 uses k1's successor (kNext) and k0
        const kNext = idx + 2 < queue.length ? queue[idx + 2] : k1;
        const dtNext = kNext.timestamp - k0.timestamp;
        const m1x = dtNext > 0 ? (kNext.position.x - k0.position.x) / dtNext : 0;
        const m1y = dtNext > 0 ? (kNext.position.y - k0.position.y) / dtNext : 0;
        const m1z = dtNext > 0 ? (kNext.position.z - k0.position.z) / dtNext : 0;

        // 5. Hermite Cubic Spline Basis Polynomials
        const s2 = s * s;
        const s3 = s2 * s;
        const h00 = 2 * s3 - 3 * s2 + 1;
        const h10 = s3 - 2 * s2 + s;
        const h01 = -2 * s3 + 3 * s2;
        const h11 = s3 - s2;

        const posX = h00 * k0.position.x + h10 * dt * m0x + h01 * k1.position.x + h11 * dt * m1x;
        const posY = h00 * k0.position.y + h10 * dt * m0y + h01 * k1.position.y + h11 * dt * m1y;
        const posZ = h00 * k0.position.z + h10 * dt * m0z + h01 * k1.position.z + h11 * dt * m1z;

        const result: Vector3D = {
            x: Math.round(posX * 1000) / 1000,
            y: Math.round(posY * 1000) / 1000,
            z: Math.round(posZ * 1000) / 1000
        };

        this.currentPositions.set(stem, result);

        // Prune stale keyframes older than renderTime - 500ms
        const pruneThreshold = renderTime - 500;
        while (queue.length > 4 && queue[0].timestamp < pruneThreshold) {
            queue.shift();
        }

        return result;
    }

    public getInterpolatedPosition(stem: StemName): Vector3D {
        return this.currentPositions.get(stem) || { x: 0, y: 1, z: 0 };
    }
}
