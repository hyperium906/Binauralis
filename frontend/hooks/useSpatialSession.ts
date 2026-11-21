"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import { SpatialAudioEngine } from '../../web/SpatialAudioEngine';
import type { DspBackend } from '../../web/types';
import { SyncClient } from '../../sync/SyncClient';
import type { RoomStatePacket, RoomTrackInfo, TransportAction } from '../../sync/protocol';
import {
    DEFAULT_API_URL,
    DEFAULT_SYNC_URL,
    ServiceHealth,
    SessionSummary,
    TrackLoudnessReport,
    checkServiceHealth,
    listSessions,
    pollStemStatus,
    resolveStemUrls,
    uploadTrackForSeparation
} from '../lib/api';

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

export type SourceMode = 'demo' | 'reference' | 'local' | 'service';

export interface UploadProgressState {
    phase: 'idle' | 'uploading' | 'separating' | 'loading' | 'error';
    progress: number | null;
    message: string;
    jobId: string | null;
}

export interface SyncSessionState {
    status: 'disconnected' | 'connecting' | 'connected' | 'error';
    serverUrl: string;
    roomId: string;
    clientId: string;
    peers: string[];
    offsetMs: number;
    minRttMs: number;
    isSynced: boolean;
    error: string | null;
}

export const STAGE_MIN_R = 0.5;
export const STAGE_MAX_R = 3.0;

export function getInitialPositions(): Record<StemName, Position3D> {
    return {
        bass: { ...STEM_CONFIGS.bass.initialPosition },
        drums: { ...STEM_CONFIGS.drums.initialPosition },
        other: { ...STEM_CONFIGS.other.initialPosition },
        vocals: { ...STEM_CONFIGS.vocals.initialPosition }
    };
}

export function clampStagePosition(x: number, y: number, z: number): Position3D {
    const r = Math.hypot(x, y, z);
    let f = 1;
    if (r > STAGE_MAX_R) f = STAGE_MAX_R / r;
    else if (r < STAGE_MIN_R && r > 1e-4) f = STAGE_MIN_R / r;

    return {
        x: Math.round(x * f * 100) / 100,
        y: Math.round(y * f * 100) / 100,
        z: Math.round(z * f * 100) / 100
    };
}

export function cartesianToSpherical(pos: Position3D): SphericalCoordinates {
    const d = Math.hypot(pos.x, pos.y, pos.z);
    const azRad = Math.atan2(pos.x, pos.y); // 0 at +Y forward, +pi/2 at +X right
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
    const [positions, setPositions] = useState<Record<StemName, Position3D>>(getInitialPositions);
    const [activeStem, setActiveStem] = useState<StemName>('vocals');
    const [volumes, setVolumes] = useState<Record<StemName, number>>({
        bass: 1, drums: 1, other: 1, vocals: 1
    });
    const [mutes, setMutes] = useState<Record<StemName, boolean>>({
        bass: false, drums: false, other: false, vocals: false
    });
    const [levels, setLevels] = useState<Record<StemName, number>>({
        bass: 0.04, drums: 0.04, other: 0.04, vocals: 0.04
    });
    const [loudness, setLoudness] = useState<MasterLoudnessTelemetry>({
        rmsDbfs: -60, peakDbfs: -60, sampleRate: 48000, isClipping: false
    });

    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(16);
    const [engineReady, setEngineReady] = useState(false);
    const [dspBackend, setDspBackend] = useState<DspBackend | 'none'>('none');
    const [sourceMode, setSourceMode] = useState<SourceMode>('demo');
    const [trackTitle, setTrackTitle] = useState<string>('Standby');
    const [trackLoudness, setTrackLoudness] = useState<TrackLoudnessReport | null>(null);
    const [activeJobId, setActiveJobId] = useState<string | null>(null);

    const [serviceHealth, setServiceHealth] = useState<ServiceHealth>({ online: false });
    const [savedSessions, setSavedSessions] = useState<SessionSummary[]>([]);
    const [uploadState, setUploadState] = useState<UploadProgressState>({
        phase: 'idle',
        progress: null,
        message: '',
        jobId: null
    });

    const [syncState, setSyncState] = useState<SyncSessionState>({
        status: 'disconnected',
        serverUrl: DEFAULT_SYNC_URL,
        roomId: 'studio-1',
        clientId: '',
        peers: [],
        offsetMs: 0,
        minRttMs: 0,
        isSynced: false,
        error: null
    });

    const audioEngineRef = useRef<SpatialAudioEngine | null>(null);
    const syncClientRef = useRef<SyncClient | null>(null);
    const positionsRef = useRef(positions);
    positionsRef.current = positions;
    const volumesRef = useRef(volumes);
    volumesRef.current = volumes;
    const mutesRef = useRef(mutes);
    mutesRef.current = mutes;
    const draggingStemRef = useRef<StemName | null>(null);
    const lastBroadcastRef = useRef<Record<StemName, number>>({ bass: 0, drums: 0, other: 0, vocals: 0 });
    const remoteActiveUntilRef = useRef<Record<StemName, number>>({ bass: 0, drums: 0, other: 0, vocals: 0 });
    const pollAbortRef = useRef<boolean>(false);

    const refreshServiceState = useCallback(async () => {
        const health = await checkServiceHealth(DEFAULT_API_URL);
        setServiceHealth(health);
        if (health.online) {
            const sessions = await listSessions(DEFAULT_API_URL);
            setSavedSessions(sessions);
        } else {
            setSavedSessions([]);
        }
        return health;
    }, []);

    useEffect(() => {
        refreshServiceState();
    }, [refreshServiceState]);

    /**
     * Lazily create and initialize the Web Audio + AudioWorklet binaural engine
     * inside a user gesture, syncing current 3D positions and stem faders.
     */
    const ensureEngine = useCallback(async (): Promise<SpatialAudioEngine> => {
        if (audioEngineRef.current) {
            return audioEngineRef.current;
        }

        const engine = new SpatialAudioEngine({
            targetSampleRate: 48000,
            wasmUrl: '/aurastream_standalone.wasm',
            workletUrl: '/SpatialWorkletProcessor.js',
            onPlaybackEnded: () => {
                setIsPlaying(false);
                setCurrentTime(0);
            }
        });

        await engine.initialize();
        audioEngineRef.current = engine;

        const p = positionsRef.current;
        const v = volumesRef.current;
        const m = mutesRef.current;
        for (const stem of STEM_NAMES) {
            engine.setStemPosition(stem, p[stem].x, p[stem].y, p[stem].z);
            engine.setStemVolume(stem, m[stem] ? 0 : (v[stem] ?? 1));
        }

        setEngineReady(true);
        setDspBackend(engine.getDspBackend());
        setLoudness((prev) => ({ ...prev, sampleRate: engine.getSampleRate() }));
        return engine;
    }, []);

    const attachAudioEngine = useCallback((engine: SpatialAudioEngine) => {
        audioEngineRef.current = engine;
        setEngineReady(true);
        setDspBackend(engine.getDspBackend());
        const p = positionsRef.current;
        STEM_NAMES.forEach((stem) => {
            engine.setStemPosition(stem, p[stem].x, p[stem].y, p[stem].z);
        });
        const d = engine.getDuration();
        if (d > 0) setDuration(d);
    }, []);

    const loadReferenceMix = useCallback(async (broadcast: boolean = true) => {
        setUploadState({ phase: 'loading', progress: null, message: 'Synthesizing 4-stem reference mix…', jobId: null });
        try {
            const engine = await ensureEngine();
            await engine.loadReferenceMix();
            setSourceMode('reference');
            setTrackTitle('Chamber reference');
            setTrackLoudness(null);
            setActiveJobId(null);
            setDuration(engine.getDuration());
            setCurrentTime(0);
            setIsPlaying(false);
            setUploadState({ phase: 'idle', progress: null, message: '', jobId: null });

            if (broadcast && syncClientRef.current?.getIsConnected()) {
                syncClientRef.current.broadcastTrack({
                    jobId: null,
                    title: 'Chamber reference',
                    mode: 'reference',
                    duration: engine.getDuration()
                });
            }
        } catch (err) {
            setUploadState({
                phase: 'error',
                progress: null,
                message: err instanceof Error ? err.message : 'Unable to initialize reference mix.',
                jobId: null
            });
        }
    }, [ensureEngine]);

    const loadServiceSession = useCallback(async (
        session: {
            jobId: string;
            title: string;
            stemUrls: Record<StemName, string>;
            loudness?: TrackLoudnessReport | null;
            apiBaseUrl?: string;
        },
        broadcast: boolean = true
    ) => {
        setUploadState({
            phase: 'loading',
            progress: null,
            message: `Decoding 4 aligned 48 kHz stems for ${session.title}…`,
            jobId: session.jobId
        });
        try {
            const engine = await ensureEngine();
            const resolvedUrls = resolveStemUrls(session.stemUrls, session.apiBaseUrl || DEFAULT_API_URL);
            await engine.loadAllStems(resolvedUrls);

            setSourceMode('service');
            setTrackTitle(session.title);
            setTrackLoudness(session.loudness ?? null);
            setActiveJobId(session.jobId);
            setDuration(engine.getDuration());
            setCurrentTime(0);
            setIsPlaying(false);
            setUploadState({ phase: 'idle', progress: null, message: '', jobId: session.jobId });

            if (broadcast && syncClientRef.current?.getIsConnected()) {
                syncClientRef.current.broadcastTrack({
                    jobId: session.jobId,
                    title: session.title,
                    mode: 'service',
                    stemUrls: session.stemUrls,
                    apiBaseUrl: session.apiBaseUrl || DEFAULT_API_URL,
                    duration: engine.getDuration()
                });
            }
        } catch (err) {
            setUploadState({
                phase: 'error',
                progress: null,
                message: err instanceof Error ? err.message : 'Failed to fetch separated stems.',
                jobId: session.jobId
            });
        }
    }, [ensureEngine]);

    const loadLocalFile = useCallback(async (file: File) => {
        setUploadState({
            phase: 'loading',
            progress: null,
            message: `Splitting ${file.name} into 4 spectral stems locally…`,
            jobId: null
        });
        try {
            const engine = await ensureEngine();
            await engine.loadLocalAudioFile(file);
            setSourceMode('local');
            setTrackTitle(file.name);
            setTrackLoudness(null);
            setActiveJobId(null);
            setDuration(engine.getDuration());
            setCurrentTime(0);
            setIsPlaying(false);
            setUploadState({ phase: 'idle', progress: null, message: '', jobId: null });
        } catch (err) {
            setUploadState({
                phase: 'error',
                progress: null,
                message: err instanceof Error ? err.message : 'Unable to decode local audio file.',
                jobId: null
            });
        }
    }, [ensureEngine]);

    const uploadAndSeparate = useCallback(async (file: File): Promise<boolean> => {
        pollAbortRef.current = false;
        setUploadState({
            phase: 'uploading',
            progress: 0,
            message: `Uploading ${file.name}…`,
            jobId: null
        });

        try {
            // Prime AudioContext during the user's file-selection gesture so decoding & playback stay unlocked
            const initPromise = ensureEngine().catch(() => null);

            const initiated = await uploadTrackForSeparation(file, DEFAULT_API_URL, (pct) => {
                setUploadState((prev) => ({
                    ...prev,
                    phase: 'uploading',
                    progress: Math.min(99, pct),
                    message: `Uploading ${file.name} (${pct}%)`
                }));
            });

            setUploadState({
                phase: 'separating',
                progress: null,
                message: 'Queued for 4-stem separation and BS.1770 loudness analysis…',
                jobId: initiated.job_id
            });

            let completed = null;
            for (let attempt = 0; attempt < 360; ++attempt) {
                if (pollAbortRef.current) return false;
                const status = await pollStemStatus(initiated.job_id, DEFAULT_API_URL);

                if (status.status === 'failed') {
                    throw new Error(status.error_message || 'Stem separation failed on server.');
                }

                if (status.status === 'completed' && status.stem_urls) {
                    completed = status;
                    break;
                }

                setUploadState({
                    phase: 'separating',
                    progress: status.progress > 0 ? status.progress : null,
                    message: status.progress > 0
                        ? `Separating stems (${status.progress}%)…`
                        : 'Running 4-stem separation…',
                    jobId: initiated.job_id
                });

                await new Promise((r) => window.setTimeout(r, 700));
            }

            if (!completed || !completed.stem_urls) {
                throw new Error('Timed out waiting for stem separation.');
            }

            await initPromise;
            await loadServiceSession({
                jobId: completed.job_id,
                title: completed.filename || file.name,
                stemUrls: completed.stem_urls,
                loudness: completed.loudness ?? null,
                apiBaseUrl: DEFAULT_API_URL
            }, true);

            // Refresh session history list
            refreshServiceState();
            return true;
        } catch (err) {
            setUploadState({
                phase: 'error',
                progress: null,
                message: err instanceof Error ? err.message : 'Audio upload failed.',
                jobId: null
            });
            return false;
        }
    }, [ensureEngine, loadServiceSession, refreshServiceState]);

    const updatePosition = useCallback((stem: StemName, x: number, y: number, z: number) => {
        const next = clampStagePosition(x, y, z);

        setPositions((prev) => (
            prev[stem].x === next.x && prev[stem].y === next.y && prev[stem].z === next.z
                ? prev
                : { ...prev, [stem]: next }
        ));

        audioEngineRef.current?.setStemPosition(stem, next.x, next.y, next.z);

        const sync = syncClientRef.current;
        if (sync?.getIsConnected()) {
            const now = performance.now();
            if (now - lastBroadcastRef.current[stem] >= 22) {
                lastBroadcastRef.current[stem] = now;
                sync.broadcastPosition(stem, next.x, next.y, next.z);
            }
        }
    }, []);

    const setDraggingStem = useCallback((stem: StemName | null) => {
        const finishedStem = draggingStemRef.current;
        draggingStemRef.current = stem;
        // Flush final resting coordinates immediately when drag ends
        if (!stem && finishedStem && syncClientRef.current?.getIsConnected()) {
            const p = positionsRef.current[finishedStem];
            lastBroadcastRef.current[finishedStem] = performance.now();
            syncClientRef.current.broadcastPosition(finishedStem, p.x, p.y, p.z);
        }
    }, []);

    const resetPositions = useCallback(() => {
        const defaults = getInitialPositions();
        setPositions(defaults);
        const engine = audioEngineRef.current;
        const sync = syncClientRef.current;
        for (const stem of STEM_NAMES) {
            const p = defaults[stem];
            engine?.setStemPosition(stem, p.x, p.y, p.z);
            if (sync?.getIsConnected()) {
                sync.broadcastPosition(stem, p.x, p.y, p.z);
            }
        }
    }, []);

    const executeLocalTransport = useCallback(async (
        action: TransportAction,
        offsetSec: number,
        delaySec: number = 0.05
    ) => {
        let engine = audioEngineRef.current;
        if (action === 'PLAY') {
            if (!engine) {
                try {
                    engine = await ensureEngine();
                    if (!engine.hasStemsLoaded()) {
                        await engine.loadReferenceMix();
                        setSourceMode('reference');
                        setTrackTitle('Chamber reference');
                        setDuration(engine.getDuration());
                    }
                } catch {
                    // Graceful Demo signal fallback if browser blocks Web Audio
                    setIsPlaying(true);
                    return;
                }
            } else if (!engine.hasStemsLoaded()) {
                await engine.loadReferenceMix();
                setSourceMode('reference');
                setTrackTitle('Chamber reference');
                setDuration(engine.getDuration());
            }

            await engine.scheduleTransport('PLAY', delaySec, offsetSec);
            setIsPlaying(true);
            setCurrentTime(offsetSec);
            return;
        }

        if (!engine) {
            if (action === 'PAUSE') setIsPlaying(false);
            else if (action === 'STOP') { setIsPlaying(false); setCurrentTime(0); }
            else if (action === 'SEEK') setCurrentTime(offsetSec);
            return;
        }

        await engine.scheduleTransport(action, delaySec, offsetSec);
        if (action === 'PAUSE') {
            setIsPlaying(false);
            setCurrentTime(offsetSec);
        } else if (action === 'STOP') {
            setIsPlaying(false);
            setCurrentTime(0);
        } else if (action === 'SEEK') {
            setCurrentTime(offsetSec);
        }
    }, [ensureEngine]);

    const play = useCallback(async () => {
        const engine = audioEngineRef.current;
        const offset = engine ? engine.getCurrentTime() : currentTime;
        if (syncClientRef.current?.getIsConnected()) {
            // Prime audio engine on user gesture before scheduled network callback fires
            if (!audioEngineRef.current) {
                try {
                    const ready = await ensureEngine();
                    if (!ready.hasStemsLoaded()) {
                        await ready.loadReferenceMix();
                        setSourceMode('reference');
                        setTrackTitle('Chamber reference');
                        setDuration(ready.getDuration());
                    }
                } catch {
                    // Handled in executeLocalTransport
                }
            }
            syncClientRef.current.requestTransport('PLAY', offset);
            return;
        }
        await executeLocalTransport('PLAY', offset, 0.04);
    }, [currentTime, ensureEngine, executeLocalTransport]);

    const pause = useCallback(() => {
        const offset = audioEngineRef.current ? audioEngineRef.current.getCurrentTime() : currentTime;
        if (syncClientRef.current?.getIsConnected()) {
            syncClientRef.current.requestTransport('PAUSE', offset);
            return;
        }
        void executeLocalTransport('PAUSE', offset, 0);
    }, [currentTime, executeLocalTransport]);

    const stop = useCallback(() => {
        if (syncClientRef.current?.getIsConnected()) {
            syncClientRef.current.requestTransport('STOP', 0);
            return;
        }
        void executeLocalTransport('STOP', 0, 0);
    }, [executeLocalTransport]);

    const seek = useCallback((targetSec: number) => {
        if (syncClientRef.current?.getIsConnected()) {
            syncClientRef.current.requestTransport('SEEK', targetSec);
            return;
        }
        void executeLocalTransport('SEEK', targetSec, 0.02);
    }, [executeLocalTransport]);

    const setStemVolume = useCallback((stem: StemName, vol: number) => {
        setVolumes((prev) => ({ ...prev, [stem]: vol }));
        setMutes((prev) => (prev[stem] && vol > 0 ? { ...prev, [stem]: false } : prev));
        audioEngineRef.current?.setStemVolume(stem, vol);
    }, []);

    const toggleMute = useCallback((stem: StemName) => {
        setMutes((prev) => {
            const next = !prev[stem];
            audioEngineRef.current?.setStemVolume(stem, next ? 0 : (volumesRef.current[stem] ?? 1));
            return { ...prev, [stem]: next };
        });
    }, []);

    /**
     * Multi-Client WebSocket Synchronization (NTP Clock Sync + Lookahead Transport +
     * 40ms Cubic Hermite Spline Jitter Buffer).
     */
    const disconnectSync = useCallback(() => {
        if (syncClientRef.current) {
            syncClientRef.current.disconnect();
            syncClientRef.current = null;
        }
        setSyncState((prev) => ({
            ...prev,
            status: 'disconnected',
            peers: [],
            isSynced: false,
            error: null
        }));
    }, []);

    const connectSync = useCallback(async (roomId: string, serverUrl: string = DEFAULT_SYNC_URL) => {
        const cleanRoom = roomId.trim() || 'studio-1';
        const cleanUrl = serverUrl.trim() || DEFAULT_SYNC_URL;

        if (syncClientRef.current) {
            syncClientRef.current.disconnect();
            syncClientRef.current = null;
        }

        const clientId = `peer_${Math.random().toString(36).substring(2, 7)}`;
        setSyncState((prev) => ({
            ...prev,
            status: 'connecting',
            roomId: cleanRoom,
            serverUrl: cleanUrl,
            clientId,
            error: null
        }));

        const handleIncomingTrack = (track: RoomTrackInfo) => {
            if (track.mode === 'service' && track.jobId && track.stemUrls) {
                void loadServiceSession({
                    jobId: track.jobId,
                    title: track.title,
                    stemUrls: track.stemUrls,
                    apiBaseUrl: track.apiBaseUrl || DEFAULT_API_URL
                }, false);
            } else if (track.mode === 'reference') {
                void loadReferenceMix(false);
            }
        };

        const client = new SyncClient(cleanUrl, cleanRoom, clientId, {
            onConnectionChange: (connected) => {
                setSyncState((prev) => ({
                    ...prev,
                    status: connected ? 'connected' : 'disconnected',
                    peers: connected ? prev.peers : []
                }));
            },
            onClockUpdate: (stats) => {
                setSyncState((prev) => ({
                    ...prev,
                    offsetMs: Math.round(stats.offsetMs * 10) / 10,
                    minRttMs: Math.round(stats.minRttMs * 100) / 100,
                    isSynced: stats.isSynced
                }));
            },
            onRoomState: (state: RoomStatePacket) => {
                const nextPos = getInitialPositions();
                for (const stem of STEM_NAMES) {
                    if (state.positions[stem]) {
                        const p = clampStagePosition(
                            state.positions[stem].x,
                            state.positions[stem].y,
                            state.positions[stem].z
                        );
                        nextPos[stem] = p;
                        audioEngineRef.current?.setStemPosition(stem, p.x, p.y, p.z);
                    }
                }
                setPositions(nextPos);
                setSyncState((prev) => ({ ...prev, peers: state.peers }));

                if (state.track) {
                    handleIncomingTrack(state.track);
                }
            },
            onPeerJoined: (peerId) => {
                setSyncState((prev) => ({
                    ...prev,
                    peers: prev.peers.includes(peerId) ? prev.peers : [...prev.peers, peerId]
                }));
            },
            onPeerLeft: (peerId) => {
                setSyncState((prev) => ({
                    ...prev,
                    peers: prev.peers.filter((id) => id !== peerId)
                }));
            },
            onRemoteNodeMove: (stem) => {
                // Keep Hermite spline interpolation active for 250ms past the newest packet
                remoteActiveUntilRef.current[stem] = performance.now() + 250;
            },
            onTrackSync: (track) => {
                handleIncomingTrack(track);
            },
            onScheduledTransport: (action, delaySec, audioOffsetSec) => {
                void executeLocalTransport(action, audioOffsetSec, delaySec);
            }
        });

        try {
            await client.connect();
            syncClientRef.current = client;
            setSyncState((prev) => ({
                ...prev,
                status: 'connected',
                error: null
            }));

            // Sync URL query param without page reload so the room link is shareable
            if (typeof window !== 'undefined') {
                const url = new URL(window.location.href);
                url.searchParams.set('room', cleanRoom);
                window.history.replaceState({}, '', url.toString());
            }
        } catch (err) {
            client.disconnect();
            setSyncState((prev) => ({
                ...prev,
                status: 'error',
                error: err instanceof Error ? err.message : 'Unable to reach sync server.'
            }));
        }
    }, [executeLocalTransport, loadReferenceMix, loadServiceSession]);

    // Auto-read ?room= query parameter on mount
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const params = new URLSearchParams(window.location.search);
        const roomParam = params.get('room');
        if (roomParam) {
            setSyncState((prev) => ({ ...prev, roomId: roomParam }));
            void connectSync(roomParam, DEFAULT_SYNC_URL);
        }
        return () => {
            pollAbortRef.current = true;
            syncClientRef.current?.disconnect();
            void audioEngineRef.current?.dispose();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /**
     * Smooth Cubic Hermite Spline evaluation loop for incoming remote stem moves (Invariant 5).
     * Runs only while connected and only writes to stems that have recent remote keyframes
     * and are not being dragged locally.
     */
    useEffect(() => {
        if (syncState.status !== 'connected') return;

        let raf = 0;
        const tick = () => {
            raf = window.requestAnimationFrame(tick);
            const sync = syncClientRef.current;
            if (!sync?.getIsConnected()) return;

            const now = performance.now();
            let anyChanged = false;
            const updates: Partial<Record<StemName, Position3D>> = {};

            for (const stem of STEM_NAMES) {
                if (draggingStemRef.current === stem) continue;
                if (now > remoteActiveUntilRef.current[stem]) continue;

                const smooth = sync.getSmoothPosition(stem);
                const clamped = clampStagePosition(smooth.x, smooth.y, smooth.z);
                const cur = positionsRef.current[stem];
                if (
                    Math.abs(clamped.x - cur.x) > 0.004 ||
                    Math.abs(clamped.y - cur.y) > 0.004 ||
                    Math.abs(clamped.z - cur.z) > 0.004
                ) {
                    updates[stem] = clamped;
                    anyChanged = true;
                    audioEngineRef.current?.setStemPosition(stem, clamped.x, clamped.y, clamped.z);
                }
            }

            if (anyChanged) {
                setPositions((prev) => ({ ...prev, ...updates }));
            }
        };

        raf = window.requestAnimationFrame(tick);
        return () => window.cancelAnimationFrame(raf);
    }, [syncState.status]);

    /**
     * 20 Hz Telemetry poll.
     * Drives real K-weighted LUFS + true stereo peak + per-stem RMS meters when
     * the AudioWorklet engine is active, or falls back transparently to the
     * clearly-labeled Demo signal when no audio engine is attached.
     */
    useEffect(() => {
        if (!isPlaying) {
            setLevels({ bass: 0.04, drums: 0.04, other: 0.04, vocals: 0.04 });
            if (audioEngineRef.current) {
                setLoudness((prev) => ({ ...prev, rmsDbfs: -60, peakDbfs: -60, isClipping: false }));
            }
            return;
        }

        const POLL_MS = 50;
        const id = window.setInterval(() => {
            const engine = audioEngineRef.current;

            if (engine) {
                setLoudness(engine.getMasterLoudness());
                setCurrentTime(engine.getCurrentTime());
                setLevels(engine.getStemLevels());
                return;
            }

            // Demo signal fallback (honestly surfaced as "Demo signal" in the masthead).
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

            setCurrentTime((prev) => (duration > 0 && prev + POLL_MS / 1000 > duration ? 0 : prev + POLL_MS / 1000));
        }, POLL_MS);

        return () => window.clearInterval(id);
    }, [isPlaying, duration]);

    const activeSpherical = cartesianToSpherical(positions[activeStem]);
    const activeBearing = bearingLabel(activeSpherical.azimuthDeg, activeSpherical.elevationDeg);

    return {
        positions, activeStem, setActiveStem, activeSpherical, activeBearing,
        volumes, mutes, levels, loudness,
        isPlaying, currentTime, duration,
        engineReady, dspBackend, sourceMode, trackTitle, trackLoudness, activeJobId,
        serviceHealth, savedSessions, uploadState, syncState,
        updatePosition, setDraggingStem, resetPositions,
        play, pause, stop, seek, setStemVolume, toggleMute,
        loadReferenceMix, loadServiceSession, loadLocalFile, uploadAndSeparate,
        refreshServiceState, connectSync, disconnectSync,
        attachAudioEngine
    };
}
