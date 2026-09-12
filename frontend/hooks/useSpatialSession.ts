"use client";

import { useState, useEffect, useRef, useCallback } from 'react';

export type StemName = 'vocals' | 'drums' | 'bass' | 'other';

/** Ordered low to high by spectral centroid — the same order the palette runs in. */
export const STEM_NAMES: StemName[] = ['bass', 'drums', 'other', 'vocals'];

export interface Position3D { x: number; y: number; z: number; }

export interface StemConfig {
    name: StemName;
    label: string;
    band: string;
    color: string;
    hexInt: number;
    initialPosition: Position3D;
}

/**
 * Hue encodes spectral content: low frequencies sit deep and saturated, high
 * frequencies rise toward the colour of the light itself. The ramp is the
 * information, not decoration — which is why the four are one family rather
 * than four competing primaries.
 */
export const STEM_CONFIGS: Record<StemName, StemConfig> = {
    bass: {
        name: 'bass',
        label: 'Bass',
        band: 'Below 250 Hz',
        color: '#7C4DFF',
        hexInt: 0x7c4dff,
        initialPosition: { x: -0.55, y: 1.30, z: -0.60 }
    },
    drums: {
        name: 'drums',
        label: 'Drums',
        band: 'Broadband, transient',
        color: '#4A7CF8',
        hexInt: 0x4a7cf8,
        initialPosition: { x: -1.70, y: 0.95, z: 0.05 }
    },
    other: {
        name: 'other',
        label: 'Instruments',
        band: '250 Hz to 4 kHz',
        color: '#2FB6E9',
        hexInt: 0x2fb6e9,
        initialPosition: { x: 1.70, y: 1.05, z: 0.20 }
    },
    vocals: {
        name: 'vocals',
        label: 'Vocals',
        band: 'Presence, 1 to 6 kHz',
        color: '#8FE6FF',
        hexInt: 0x8fe6ff,
        initialPosition: { x: 0.20, y: 2.05, z: 0.42 }
    }
};

export interface MasterLoudnessTelemetry {
    rmsDbfs: number;
    peakDbfs: number;
    sampleRate: number;
    isClipping: boolean;
}

export interface SphericalCoordinates {
    azimuthDeg: number;
    elevationDeg: number;
    distanceM: number;
    attenuationGain: number;
}

export const STAGE_MIN_R = 0.5;
export const STAGE_MAX_R = 3.0;

export function cartesianToSpherical(pos: Position3D): SphericalCoordinates {
    const d = Math.hypot(pos.x, pos.y, pos.z);
    const azRad = Math.atan2(pos.x, pos.y);      // 0 at +Y forward, +pi/2 at +X right
    const elRad = d > 1e-6 ? Math.asin(Math.max(-1, Math.min(1, pos.z / d))) : 0;

    return {
        azimuthDeg: Math.round((azRad * 180 / Math.PI) * 10) / 10,
        elevationDeg: Math.round((elRad * 180 / Math.PI) * 10) / 10,
        distanceM: Math.round(d * 100) / 100,
        attenuationGain: Math.round((1.0 / Math.max(STAGE_MIN_R, d)) * 100) / 100
    };
}

/** Plain-language bearing, for people who do not read degrees at a glance. */
export function bearingLabel(azimuthDeg: number, elevationDeg: number): string {
    const a = Math.abs(azimuthDeg);
    const side = azimuthDeg >= 0 ? 'right' : 'left';

    let lateral: string;
    if (a < 12) lateral = 'Directly ahead';
    else if (a < 68) lateral = `Ahead and ${side}`;
    else if (a < 112) lateral = `Hard ${side}`;
    else if (a < 168) lateral = `Behind and ${side}`;
    else lateral = 'Directly behind';

    if (elevationDeg > 18) return `${lateral}, raised`;
    if (elevationDeg < -18) return `${lateral}, lowered`;
    return lateral;
}

export function useSpatialSession() {
    const [positions, setPositions] = useState<Record<StemName, Position3D>>({
        bass: { ...STEM_CONFIGS.bass.initialPosition },
        drums: { ...STEM_CONFIGS.drums.initialPosition },
        other: { ...STEM_CONFIGS.other.initialPosition },
        vocals: { ...STEM_CONFIGS.vocals.initialPosition }
    });

    const [activeStem, setActiveStem] = useState<StemName>('vocals');
    const [volumes, setVolumes] = useState<Record<StemName, number>>({
        bass: 1, drums: 1, other: 1, vocals: 1
    });
    const [mutes, setMutes] = useState<Record<StemName, boolean>>({
        bass: false, drums: false, other: false, vocals: false
    });

    const [levels, setLevels] = useState<Record<StemName, number>>({
        bass: 0.05, drums: 0.05, other: 0.05, vocals: 0.05
    });

    const [loudness, setLoudness] = useState<MasterLoudnessTelemetry>({
        rmsDbfs: -60, peakDbfs: -60, sampleRate: 48000, isClipping: false
    });

    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(212);
    const [engineReady, setEngineReady] = useState(false);

    const audioEngineRef = useRef<any>(null);
    const positionsRef = useRef(positions);
    positionsRef.current = positions;

    const attachAudioEngine = useCallback((engine: any) => {
        audioEngineRef.current = engine;
        setEngineReady(true);
        const p = positionsRef.current;
        (Object.keys(p) as StemName[]).forEach(stem => {
            engine.setStemPosition?.(stem, p[stem].x, p[stem].y, p[stem].z);
        });
        if (typeof engine.getDuration === 'function') {
            const d = engine.getDuration();
            if (d > 0) setDuration(d);
        }
    }, []);

    const updatePosition = useCallback((stem: StemName, x: number, y: number, z: number) => {
        // Hold the source inside the stage: outside 3 m it is inaudible, inside
        // 0.5 m the inverse-distance law runs away.
        const r = Math.hypot(x, y, z);
        let f = 1;
        if (r > STAGE_MAX_R) f = STAGE_MAX_R / r;
        else if (r < STAGE_MIN_R && r > 1e-4) f = STAGE_MIN_R / r;

        const next = {
            x: Math.round(x * f * 100) / 100,
            y: Math.round(y * f * 100) / 100,
            z: Math.round(z * f * 100) / 100
        };

        setPositions(prev => (
            prev[stem].x === next.x && prev[stem].y === next.y && prev[stem].z === next.z
                ? prev
                : { ...prev, [stem]: next }
        ));

        audioEngineRef.current?.setStemPosition?.(stem, next.x, next.y, next.z);
    }, []);

    const play = useCallback(() => {
        setIsPlaying(true);
        audioEngineRef.current?.play?.();
    }, []);

    const pause = useCallback(() => {
        setIsPlaying(false);
        audioEngineRef.current?.pause?.();
    }, []);

    const stop = useCallback(() => {
        setIsPlaying(false);
        setCurrentTime(0);
        audioEngineRef.current?.stop?.();
    }, []);

    const seek = useCallback((targetSec: number) => {
        setCurrentTime(targetSec);
        audioEngineRef.current?.seek?.(targetSec);
    }, []);

    const setStemVolume = useCallback((stem: StemName, vol: number) => {
        setVolumes(prev => ({ ...prev, [stem]: vol }));
        audioEngineRef.current?.setStemVolume?.(stem, vol);
    }, []);

    const toggleMute = useCallback((stem: StemName) => {
        setMutes(prev => {
            const next = !prev[stem];
            audioEngineRef.current?.setStemVolume?.(stem, next ? 0 : (volumes[stem] ?? 1));
            return { ...prev, [stem]: next };
        });
    }, [volumes]);

    /**
     * Telemetry poll.
     *
     * Deliberately NOT on requestAnimationFrame: this sets React state, and at
     * 60 Hz that re-renders the whole tree — including the WebGL canvas host —
     * sixty times a second for numbers no one can read that fast. 20 Hz is
     * past the threshold where a meter looks live, at a third of the cost.
     *
     * With no engine attached the meters run on a synthesised signal so the
     * stage is not dead on arrival. That state is surfaced in the masthead as
     * "Demo signal" — a meter that invents numbers without saying so is worse
     * than one reading zero.
     */
    useEffect(() => {
        if (!isPlaying) {
            setLevels({ bass: 0.04, drums: 0.04, other: 0.04, vocals: 0.04 });
            return;
        }

        const POLL_MS = 50;
        const id = window.setInterval(() => {
            const engine = audioEngineRef.current;

            if (engine?.getMasterLoudness) {
                setLoudness(engine.getMasterLoudness());
                if (engine.getCurrentTime) setCurrentTime(engine.getCurrentTime());
                if (engine.getStemLevels) setLevels(engine.getStemLevels());
                return;
            }

            // Demo signal. Labelled as such in the UI.
            const t = performance.now() / 1000;
            const kick = Math.pow(Math.max(0, Math.sin(t * Math.PI * 2 * (112 / 60))), 7);
            setLevels({
                bass:   0.20 + 0.26 * Math.abs(Math.sin(t * 1.7)) + kick * 0.34,
                drums:  0.16 + kick * 0.62,
                other:  0.14 + 0.18 * Math.abs(Math.sin(t * 0.9 + 1.1)),
                vocals: 0.12 + 0.34 * Math.max(0, Math.sin(t * 0.55))
            });

            const rms = -15.5 + 2.4 * Math.sin(t * 0.7) + 1.1 * Math.sin(t * 2.3);
            setLoudness({
                rmsDbfs: Math.round(rms * 10) / 10,
                peakDbfs: Math.round((rms + 5.2 + Math.sin(t * 3.1)) * 10) / 10,
                sampleRate: 48000,
                isClipping: false
            });

            setCurrentTime(prev => (duration > 0 && prev + POLL_MS / 1000 > duration ? 0 : prev + POLL_MS / 1000));
        }, POLL_MS);

        return () => window.clearInterval(id);
    }, [isPlaying, duration]);

    const activeSpherical = cartesianToSpherical(positions[activeStem]);
    const activeBearing = bearingLabel(activeSpherical.azimuthDeg, activeSpherical.elevationDeg);

    return {
        positions, activeStem, setActiveStem, activeSpherical, activeBearing,
        volumes, mutes, levels, loudness,
        isPlaying, currentTime, duration, engineReady,
        updatePosition, play, pause, stop, seek, setStemVolume, toggleMute,
        attachAudioEngine
    };
}
