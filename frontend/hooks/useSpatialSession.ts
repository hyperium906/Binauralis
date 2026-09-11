"use client";

import { useState, useEffect, useRef, useCallback } from 'react';

export type StemName = 'vocals' | 'drums' | 'bass' | 'other';
export const STEM_NAMES: StemName[] = ['vocals', 'drums', 'bass', 'other'];

export interface Position3D {
    x: number;
    y: number;
    z: number;
}

export interface StemConfig {
    name: StemName;
    label: string;
    color: string;
    hexInt: number;
    initialPosition: Position3D;
}

export const STEM_CONFIGS: Record<StemName, StemConfig> = {
    vocals: {
        name: 'vocals',
        label: 'Lead Vocals',
        color: '#ff007f', // Magenta
        hexInt: 0xff007f,
        initialPosition: { x: 0.0, y: 1.8, z: 0.2 }
    },
    drums: {
        name: 'drums',
        label: 'Drums & Percussion',
        color: '#00f2fe', // Cyan
        hexInt: 0x00f2fe,
        initialPosition: { x: -1.2, y: 1.2, z: 0.0 }
    },
    bass: {
        name: 'bass',
        label: 'Sub Bass',
        color: '#ffaa00', // Gold
        hexInt: 0xffaa00,
        initialPosition: { x: 0.0, y: 0.8, z: -0.4 }
    },
    other: {
        name: 'other',
        label: 'Other / Synth',
        color: '#00ff88', // Emerald
        hexInt: 0x00ff88,
        initialPosition: { x: 1.2, y: 1.4, z: 0.1 }
    }
};

export interface MasterLoudnessTelemetry {
    rmsDbfs: number;
    peakDbfs: number;
    sampleRate: number;
    isClipping: boolean;
}

export interface SphericalCoordinates {
    azimuthDeg: number;   // [-180, 180]
    elevationDeg: number; // [-90, 90]
    distanceM: number;
    attenuationGain: number;
}

export function cartesianToSpherical(pos: Position3D): SphericalCoordinates {
    const d = Math.hypot(pos.x, pos.y, pos.z);
    const eps = 1e-6;
    const azRad = Math.atan2(pos.x, pos.y); // 0 at +Y (forward), +pi/2 at +X (right)
    const elRad = d > eps ? Math.asin(Math.max(-1.0, Math.min(1.0, pos.z / d))) : 0;

    const azDeg = Math.round((azRad * 180.0 / Math.PI) * 10) / 10;
    const elDeg = Math.round((elRad * 180.0 / Math.PI) * 10) / 10;
    const distM = Math.round(d * 100) / 100;
    const gain = Math.round((1.0 / Math.max(0.5, d)) * 100) / 100;

    return {
        azimuthDeg: azDeg,
        elevationDeg: elDeg,
        distanceM: distM,
        attenuationGain: gain
    };
}

export function useSpatialSession() {
    const [positions, setPositions] = useState<Record<StemName, Position3D>>({
        vocals: { ...STEM_CONFIGS.vocals.initialPosition },
        drums:  { ...STEM_CONFIGS.drums.initialPosition },
        bass:   { ...STEM_CONFIGS.bass.initialPosition },
        other:  { ...STEM_CONFIGS.other.initialPosition }
    });

    const [activeStem, setActiveStem] = useState<StemName>('vocals');
    const [volumes, setVolumes] = useState<Record<StemName, number>>({
        vocals: 1.0,
        drums: 1.0,
        bass: 1.0,
        other: 1.0
    });
    const [mutes, setMutes] = useState<Record<StemName, boolean>>({
        vocals: false,
        drums: false,
        bass: false,
        other: false
    });

    // Real-time RMS amplitudes for driving GLSL pulsing halos (0.0 to 1.0)
    const [rmsLevels, setRmsLevels] = useState<Record<StemName, number>>({
        vocals: 0.15,
        drums: 0.2,
        bass: 0.18,
        other: 0.12
    });

    const [loudness, setLoudness] = useState<MasterLoudnessTelemetry>({
        rmsDbfs: -23.4,
        peakDbfs: -18.2,
        sampleRate: 48000,
        isClipping: false
    });

    const [isPlaying, setIsPlaying] = useState<boolean>(false);
    const [currentTime, setCurrentTime] = useState<number>(0);
    const [duration, setDuration] = useState<number>(184.0);

    // Reference to SpatialAudioEngine instance if initialized
    const audioEngineRef = useRef<any>(null);

    // Attach external SpatialAudioEngine
    const attachAudioEngine = useCallback((engine: any) => {
        audioEngineRef.current = engine;
        // Sync initial positions
        for (const [stem, pos] of Object.entries(positions)) {
            engine.setStemPosition(stem, pos.x, pos.y, pos.z);
        }
    }, [positions]);

    // Handle coordinate drag update
    const updatePosition = useCallback((stem: StemName, x: number, y: number, z: number) => {
        // Enforce boundary sphere: R in [0.5m, 3.0m]
        const rawDist = Math.hypot(x, y, z);
        let clampedX = x;
        let clampedY = y;
        let clampedZ = z;

        const MIN_R = 0.5;
        const MAX_R = 3.0;

        if (rawDist > MAX_R) {
            const factor = MAX_R / rawDist;
            clampedX *= factor;
            clampedY *= factor;
            clampedZ *= factor;
        } else if (rawDist < MIN_R && rawDist > 1e-4) {
            const factor = MIN_R / rawDist;
            clampedX *= factor;
            clampedY *= factor;
            clampedZ *= factor;
        }

        const newPos = {
            x: Math.round(clampedX * 100) / 100,
            y: Math.round(clampedY * 100) / 100,
            z: Math.round(clampedZ * 100) / 100
        };

        setPositions(prev => ({
            ...prev,
            [stem]: newPos
        }));

        // Send lock-free spatial update to Web Audio engine
        if (audioEngineRef.current && audioEngineRef.current.setStemPosition) {
            audioEngineRef.current.setStemPosition(stem, newPos.x, newPos.y, newPos.z);
        }
    }, []);

    // Transport controls
    const play = useCallback(() => {
        setIsPlaying(true);
        if (audioEngineRef.current && audioEngineRef.current.play) {
            audioEngineRef.current.play();
        }
    }, []);

    const pause = useCallback(() => {
        setIsPlaying(false);
        if (audioEngineRef.current && audioEngineRef.current.pause) {
            audioEngineRef.current.pause();
        }
    }, []);

    const stop = useCallback(() => {
        setIsPlaying(false);
        setCurrentTime(0);
        if (audioEngineRef.current && audioEngineRef.current.stop) {
            audioEngineRef.current.stop();
        }
    }, []);

    const seek = useCallback((targetSec: number) => {
        setCurrentTime(targetSec);
        if (audioEngineRef.current && audioEngineRef.current.seek) {
            audioEngineRef.current.seek(targetSec);
        }
    }, []);

    const setStemVolume = useCallback((stem: StemName, vol: number) => {
        setVolumes(prev => ({ ...prev, [stem]: vol }));
        if (audioEngineRef.current && audioEngineRef.current.setStemVolume) {
            audioEngineRef.current.setStemVolume(stem, vol);
        }
    }, []);

    const toggleMute = useCallback((stem: StemName) => {
        setMutes(prev => {
            const nextVal = !prev[stem];
            if (audioEngineRef.current && audioEngineRef.current.setStemVolume) {
                audioEngineRef.current.setStemVolume(stem, nextVal ? 0.0 : (volumes[stem] || 1.0));
            }
            return { ...prev, [stem]: nextVal };
        });
    }, [volumes]);

    // Simulated / live audio telemetry ticker
    useEffect(() => {
        let animId: number;
        let lastTick = performance.now();

        const tick = (now: number) => {
            const dt = (now - lastTick) / 1000.0;
            lastTick = now;

            if (isPlaying) {
                setCurrentTime(prev => (prev + dt > duration ? 0 : prev + dt));

                if (audioEngineRef.current && audioEngineRef.current.getMasterLoudness) {
                    const metrics = audioEngineRef.current.getMasterLoudness();
                    setLoudness(metrics);
                } else {
                    // Organic telemetry fluctuation when running without live mic/stream
                    const t = now / 1000.0;
                    const simRms = -14.0 + 3.0 * Math.sin(t * 1.5) + 1.5 * Math.cos(t * 3.7);
                    const simPeak = simRms + 4.5 + Math.sin(t * 5.2);
                    setLoudness({
                        rmsDbfs: Math.round(simRms * 10) / 10,
                        peakDbfs: Math.round(simPeak * 10) / 10,
                        sampleRate: 48000,
                        isClipping: simPeak >= -0.1
                    });

                    // Dynamic RMS per stem for GLSL shaders
                    setRmsLevels({
                        vocals: Math.max(0.05, 0.25 + 0.2 * Math.sin(t * 2.8)),
                        drums:  Math.max(0.08, 0.35 + 0.3 * Math.abs(Math.sin(t * 4.2))),
                        bass:   Math.max(0.05, 0.3 + 0.25 * Math.sin(t * 1.8)),
                        other:  Math.max(0.02, 0.18 + 0.15 * Math.cos(t * 3.1))
                    });
                }
            } else {
                setRmsLevels({ vocals: 0.05, drums: 0.05, bass: 0.05, other: 0.05 });
            }

            animId = requestAnimationFrame(tick);
        };

        animId = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(animId);
    }, [isPlaying, duration]);

    const activeSpherical = cartesianToSpherical(positions[activeStem]);

    return {
        positions,
        activeStem,
        setActiveStem,
        activeSpherical,
        volumes,
        mutes,
        rmsLevels,
        loudness,
        isPlaying,
        currentTime,
        duration,
        updatePosition,
        play,
        pause,
        stop,
        seek,
        setStemVolume,
        toggleMute,
        attachAudioEngine
    };
}
