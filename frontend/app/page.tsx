"use client";

import React, { useState, useCallback, useEffect } from 'react';
import { useSpatialSession } from '../hooks/useSpatialSession';
import { SpatialCanvas3D } from '../components/SpatialCanvas3D';
import { SpatialTelemetryHUD } from '../components/SpatialTelemetryHUD';
import { TransportControls } from '../components/TransportControls';
import { AudioSessionDialog } from '../components/AudioSessionDialog';
import { SyncRoomDialog } from '../components/SyncRoomDialog';

export default function SpatialWorkstationPage() {
    const s = useSpatialSession();
    const [touched, setTouched] = useState(false);
    const [audioModalOpen, setAudioModalOpen] = useState(false);
    const [syncModalOpen, setSyncModalOpen] = useState(false);

    const onFirstMove = useCallback(() => setTouched(true), []);

    // Keyboard studio controls: Space for play/pause, arrows (+ Shift for Z) to nudge active source
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (audioModalOpen || syncModalOpen) return;
            const target = e.target as HTMLElement | null;
            if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
                return;
            }

            if (e.code === 'Space') {
                e.preventDefault();
                if (s.isPlaying) s.pause();
                else void s.play();
                return;
            }

            const step = 0.1;
            const cur = s.positions[s.activeStem];
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                onFirstMove();
                s.updatePosition(s.activeStem, cur.x - step, cur.y, cur.z);
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                onFirstMove();
                s.updatePosition(s.activeStem, cur.x + step, cur.y, cur.z);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                onFirstMove();
                s.updatePosition(s.activeStem, cur.x, e.shiftKey ? cur.y : cur.y + step, e.shiftKey ? cur.z + step : cur.z);
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                onFirstMove();
                s.updatePosition(s.activeStem, cur.x, e.shiftKey ? cur.y : cur.y - step, e.shiftKey ? cur.z - step : cur.z);
            }
        };

        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [audioModalOpen, syncModalOpen, s, onFirstMove]);

    const syncConnected = s.syncState.status === 'connected';
    const busyIngest = s.uploadState.phase === 'uploading' || s.uploadState.phase === 'separating' || s.uploadState.phase === 'loading';

    return (
        <div className="chamber">
            <header className="masthead">
                <div className="ident">
                    <img src="/logo_mark.svg" alt="" width={26} height={26} />
                    <h1>AuraStream <span>Spatial monitor</span></h1>
                </div>

                <div className="mast-tools">
                    <button
                        type="button"
                        className="mast-btn"
                        data-active={s.sourceMode !== 'demo'}
                        onClick={() => setAudioModalOpen(true)}
                    >
                        <span>Audio</span>
                        <b className="mast-val">
                            {busyIngest ? 'Loading…' : s.sourceMode === 'demo' ? 'Load track' : s.trackTitle}
                        </b>
                    </button>

                    <button
                        type="button"
                        className="mast-btn"
                        data-active={syncConnected}
                        onClick={() => setSyncModalOpen(true)}
                    >
                        <span className="lamp" data-state={syncConnected ? 'live' : 'idle'} />
                        <span>Sync</span>
                        <b className="mast-val num">
                            {syncConnected
                                ? `${s.syncState.roomId} · ${s.syncState.peers.length}p · ${s.syncState.minRttMs.toFixed(1)} ms`
                                : 'Solo'}
                        </b>
                    </button>

                    <div className="rate">
                        <span className="lamp" data-state={s.engineReady ? 'live' : 'idle'} />
                        {s.engineReady ? (
                            <>Engine live <b className="num">{(s.loudness.sampleRate / 1000).toFixed(1)} kHz</b></>
                        ) : (
                            <>Demo signal <b className="num">48.0 kHz</b></>
                        )}
                    </div>
                </div>
            </header>

            <div className="bench">
                <section className="stage" aria-label="Soundstage">
                    <SpatialCanvas3D
                        positions={s.positions}
                        activeStem={s.activeStem}
                        levels={s.levels}
                        onSelectStem={s.setActiveStem}
                        onUpdatePosition={s.updatePosition}
                        onFirstMove={onFirstMove}
                        onDragChange={s.setDraggingStem}
                    />
                    <div className="stage-note" data-touched={touched}>
                        <p>
                            Drag a source to move it around the listener, or press Play to audition
                            the 4-stem binaural reference mix. Load any track from Audio to separate stems.
                        </p>
                    </div>
                </section>

                <SpatialTelemetryHUD
                    activeStem={s.activeStem}
                    position={s.positions[s.activeStem]}
                    spherical={s.activeSpherical}
                    bearing={s.activeBearing}
                    loudness={s.loudness}
                    trackLoudness={s.trackLoudness}
                    dspBackend={s.dspBackend}
                    levels={s.levels}
                    onSelectStem={s.setActiveStem}
                    onResetPositions={s.resetPositions}
                />
            </div>

            <TransportControls
                isPlaying={s.isPlaying}
                currentTime={s.currentTime}
                duration={s.duration}
                volumes={s.volumes}
                mutes={s.mutes}
                onPlay={s.play}
                onPause={s.pause}
                onStop={s.stop}
                onSeek={s.seek}
                onSetVolume={s.setStemVolume}
                onToggleMute={s.toggleMute}
            />

            <AudioSessionDialog
                open={audioModalOpen}
                onClose={() => setAudioModalOpen(false)}
                sourceMode={s.sourceMode}
                dspBackend={s.dspBackend}
                trackTitle={s.trackTitle}
                activeJobId={s.activeJobId}
                trackLoudness={s.trackLoudness}
                serviceHealth={s.serviceHealth}
                savedSessions={s.savedSessions}
                uploadState={s.uploadState}
                onUploadSeparate={s.uploadAndSeparate}
                onLoadLocalFile={s.loadLocalFile}
                onLoadReferenceMix={s.loadReferenceMix}
                onLoadSession={s.loadServiceSession}
                onRefreshService={s.refreshServiceState}
            />

            <SyncRoomDialog
                open={syncModalOpen}
                onClose={() => setSyncModalOpen(false)}
                syncState={s.syncState}
                onConnect={s.connectSync}
                onDisconnect={s.disconnectSync}
            />
        </div>
    );
}
