"use client";

import React, { useEffect, useId, useRef, useState } from 'react';
import type {
    ServiceHealth,
    SessionSummary,
    TrackLoudnessReport
} from '../lib/api';
import type {
    SourceMode,
    StemName,
    UploadProgressState
} from '../hooks/useSpatialSession';
import type { DspBackend } from '../../web/types';

interface AudioSessionDialogProps {
    open: boolean;
    onClose: () => void;
    sourceMode: SourceMode;
    dspBackend: DspBackend | 'none';
    trackTitle: string;
    activeJobId: string | null;
    trackLoudness: TrackLoudnessReport | null;
    serviceHealth: ServiceHealth;
    savedSessions: SessionSummary[];
    uploadState: UploadProgressState;
    onUploadSeparate: (file: File) => Promise<boolean>;
    onLoadLocalFile: (file: File) => Promise<void>;
    onLoadReferenceMix: () => Promise<void>;
    onLoadSession: (session: {
        jobId: string;
        title: string;
        stemUrls: Record<StemName, string>;
        loudness?: TrackLoudnessReport | null;
    }) => Promise<void>;
    onRefreshService: () => Promise<ServiceHealth>;
}

const formatDuration = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
};

export const AudioSessionDialog: React.FC<AudioSessionDialogProps> = ({
    open,
    onClose,
    sourceMode,
    dspBackend,
    trackTitle,
    activeJobId,
    trackLoudness,
    serviceHealth,
    savedSessions,
    uploadState,
    onUploadSeparate,
    onLoadLocalFile,
    onLoadReferenceMix,
    onLoadSession,
    onRefreshService
}) => {
    const dialogRef = useRef<HTMLDialogElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const localInputRef = useRef<HTMLInputElement>(null);
    const titleId = useId();
    const progressId = useId();
    const [dragOver, setDragOver] = useState(false);

    // Sync open prop with native modal top layer (showModal / close)
    useEffect(() => {
        const dialog = dialogRef.current;
        if (!dialog) return;
        if (open && !dialog.open) {
            dialog.showModal();
            void onRefreshService();
        } else if (!open && dialog.open) {
            dialog.close();
        }
    }, [open, onRefreshService]);

    // Native close listener (clears stale returnValue) + Safari closedby="any" fallback
    useEffect(() => {
        const dialog = dialogRef.current;
        if (!dialog) return;

        const handleClose = () => {
            dialog.returnValue = '';
            onClose();
        };
        dialog.addEventListener('close', handleClose);

        // Fallback for browsers without native <dialog closedby="any"> support (e.g. Safari)
        let cleanupFallback: (() => void) | undefined;
        if (typeof HTMLDialogElement !== 'undefined' && !('closedBy' in HTMLDialogElement.prototype)) {
            let pressedOutside = false;
            const isOutside = (e: PointerEvent) => {
                const r = dialog.getBoundingClientRect();
                return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
            };
            const onDown = (e: PointerEvent) => { pressedOutside = isOutside(e); };
            const onUp = (e: PointerEvent) => {
                if (pressedOutside && isOutside(e)) dialog.close();
                pressedOutside = false;
            };
            dialog.addEventListener('pointerdown', onDown);
            dialog.addEventListener('pointerup', onUp);
            cleanupFallback = () => {
                dialog.removeEventListener('pointerdown', onDown);
                dialog.removeEventListener('pointerup', onUp);
            };
        }

        return () => {
            dialog.removeEventListener('close', handleClose);
            cleanupFallback?.();
        };
    }, [onClose]);

    const busy = uploadState.phase === 'uploading' || uploadState.phase === 'separating' || uploadState.phase === 'loading';

    const handleSelectedFile = async (file: File | undefined) => {
        if (!file || busy) return;
        if (serviceHealth.online) {
            const ok = await onUploadSeparate(file);
            if (ok) dialogRef.current?.close();
        } else {
            await onLoadLocalFile(file);
            dialogRef.current?.close();
        }
    };

    const handleLocalFileOnly = async (file: File | undefined) => {
        if (!file || busy) return;
        await onLoadLocalFile(file);
        dialogRef.current?.close();
    };

    const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files?.[0];
        void handleSelectedFile(file);
    };

    const backendLabel = dspBackend === 'wasm'
        ? 'C++ WebAssembly'
        : dspBackend === 'worklet-dsp'
            ? 'Worklet 1024-pt FFT'
            : 'Standby';

    return (
        <dialog
            ref={dialogRef}
            className="modal"
            aria-labelledby={titleId}
            {...({ closedby: 'any' } as Record<string, string>)}
        >
            <div className="modal-head">
                <div>
                    <h2 id={titleId}>Audio source &amp; stems</h2>
                    <p className="modal-sub">
                        Active: <strong>{trackTitle}</strong> · DSP: <span className="num">{backendLabel}</span>
                    </p>
                </div>
                <form method="dialog">
                    <button type="submit" className="modal-close" aria-label="Close audio dialog">
                        Close
                    </button>
                </form>
            </div>

            <div className="modal-body">
                {/* 1. Upload / Stem Extraction */}
                <section className="modal-sect">
                    <div className="sect-head">
                        <h3>Extract 4 stems from audio file</h3>
                        <span className="spec">
                            <span className="lamp-inline" data-state={serviceHealth.online ? 'live' : 'idle'} />
                            {serviceHealth.online
                                ? `Demucs service online (${serviceHealth.device || 'cpu'})`
                                : 'Service offline — local 4-band split available'}
                        </span>
                    </div>

                    <div
                        className="dropzone"
                        data-over={dragOver}
                        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                        onDragLeave={() => setDragOver(false)}
                        onDrop={handleDrop}
                    >
                        <input
                            ref={fileInputRef}
                            type="file"
                            className="sr-only"
                            accept=".wav,.mp3,.flac,.ogg,.m4a,.aiff,audio/*"
                            disabled={busy}
                            onChange={(e) => {
                                void handleSelectedFile(e.target.files?.[0]);
                                e.target.value = '';
                            }}
                        />
                        <input
                            ref={localInputRef}
                            type="file"
                            className="sr-only"
                            accept=".wav,.mp3,.flac,.ogg,.m4a,.aiff,audio/*"
                            disabled={busy}
                            onChange={(e) => {
                                void handleLocalFileOnly(e.target.files?.[0]);
                                e.target.value = '';
                            }}
                        />

                        <p className="drop-copy">
                            Drop a stereo WAV, FLAC, or MP3 here — or choose a file to separate into
                            phase-aligned 48 kHz Bass, Drums, Instruments, and Vocals stems.
                        </p>

                        <div className="btn-row">
                            <button
                                type="button"
                                className="btn btn-primary"
                                autoFocus
                                disabled={busy}
                                onClick={() => fileInputRef.current?.click()}
                            >
                                {serviceHealth.online ? 'Upload & separate (FastAPI)' : 'Load audio (local 4-band split)'}
                            </button>

                            {serviceHealth.online && (
                                <button
                                    type="button"
                                    className="btn"
                                    disabled={busy}
                                    onClick={() => localInputRef.current?.click()}
                                >
                                    Instant local split
                                </button>
                            )}

                            <button
                                type="button"
                                className="btn"
                                disabled={busy}
                                onClick={async () => {
                                    await onLoadReferenceMix();
                                    dialogRef.current?.close();
                                }}
                            >
                                {sourceMode === 'reference' ? 'Reload reference mix' : 'Load reference mix'}
                            </button>
                        </div>
                    </div>

                    {busy && (
                        <div className="progress-block">
                            <div className="progress-meta">
                                <label htmlFor={progressId}>{uploadState.message}</label>
                                {uploadState.progress !== null && (
                                    <span className="num">{uploadState.progress}%</span>
                                )}
                            </div>
                            <progress
                                id={progressId}
                                className="prog"
                                max={100}
                                value={uploadState.progress !== null ? uploadState.progress : undefined}
                            />
                        </div>
                    )}

                    <div role="status" aria-live="polite" className="status-line" data-error={uploadState.phase === 'error'}>
                        {uploadState.phase === 'error' ? uploadState.message : ''}
                    </div>
                </section>

                {/* 2. Backend ITU-R BS.1770-4 Track Telemetry */}
                {trackLoudness && (
                    <section className="modal-sect">
                        <div className="sect-head">
                            <h3>Source track loudness</h3>
                            <span className="spec">ITU-R BS.1770-4 / EBU Tech 3342</span>
                        </div>
                        <dl className="axes">
                            <div className="axis">
                                <dt>Integrated</dt>
                                <dd className="num">{trackLoudness.integrated_loudness_lufs.toFixed(1)}<u>LUFS</u></dd>
                            </div>
                            <div className="axis">
                                <dt>Loudness range</dt>
                                <dd className="num">{trackLoudness.loudness_range_lu.toFixed(1)}<u>LU</u></dd>
                            </div>
                            <div className="axis">
                                <dt>True peak</dt>
                                <dd className="num">{trackLoudness.true_peak_dbfs.toFixed(1)}<u>dBTP</u></dd>
                            </div>
                        </dl>
                    </section>
                )}

                {/* 3. Separated Sessions on FastAPI Server */}
                <section className="modal-sect">
                    <div className="sect-head">
                        <h3>Separated sessions</h3>
                        <button
                            type="button"
                            className="link-btn"
                            onClick={() => { void onRefreshService(); }}
                        >
                            Refresh
                        </button>
                    </div>

                    {!serviceHealth.online ? (
                        <p className="empty-note">
                            Start the Python microservice with <code>make run_service</code> to enable
                            Demucs neural separation and session history.
                        </p>
                    ) : savedSessions.length === 0 ? (
                        <p className="empty-note">
                            No separated sessions on disk yet. Upload a track above to extract 4 stems.
                        </p>
                    ) : (
                        <ul className="session-list">
                            {savedSessions.map((sess) => {
                                const isActive = sess.job_id === activeJobId;
                                return (
                                    <li key={sess.job_id} data-active={isActive}>
                                        <button
                                            type="button"
                                            disabled={busy}
                                            onClick={async () => {
                                                await onLoadSession({
                                                    jobId: sess.job_id,
                                                    title: sess.filename,
                                                    stemUrls: sess.stem_urls,
                                                    loudness: sess.loudness ?? null
                                                });
                                                dialogRef.current?.close();
                                            }}
                                        >
                                            <span className="sess-name">{sess.filename}</span>
                                            <span className="sess-meta num">
                                                {formatDuration(sess.duration_seconds)} · {(sess.sample_rate / 1000).toFixed(0)} kHz
                                                {sess.loudness ? ` · ${sess.loudness.integrated_loudness_lufs.toFixed(1)} LUFS` : ''}
                                            </span>
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </section>
            </div>
        </dialog>
    );
};
