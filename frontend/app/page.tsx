"use client";

import React, { useState, useCallback } from 'react';
import { useSpatialSession } from '../hooks/useSpatialSession';
import { SpatialCanvas3D } from '../components/SpatialCanvas3D';
import { SpatialTelemetryHUD } from '../components/SpatialTelemetryHUD';
import { TransportControls } from '../components/TransportControls';

export default function SpatialWorkstationPage() {
    const s = useSpatialSession();
    const [touched, setTouched] = useState(false);
    const onFirstMove = useCallback(() => setTouched(true), []);

    return (
        <div className="chamber">
            <header className="masthead">
                <div className="ident">
                    <img src="/logo_mark.svg" alt="" width={26} height={26} />
                    <h1>AuraStream <span>Spatial monitor</span></h1>
                </div>

                <div className="rate">
                    <span className="lamp" data-state={s.engineReady ? 'live' : 'idle'} />
                    {s.engineReady ? (
                        <>Engine live <b className="num">{(s.loudness.sampleRate / 1000).toFixed(1)} kHz</b></>
                    ) : (
                        <>Demo signal <b className="num">48.0 kHz</b></>
                    )}
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
                    />
                    <div className="stage-note" data-touched={touched}>
                        <p>
                            Drag a source to move it around the listener. Distance sets
                            attenuation; bearing selects the head-related filter.
                        </p>
                    </div>
                </section>

                <SpatialTelemetryHUD
                    activeStem={s.activeStem}
                    position={s.positions[s.activeStem]}
                    spherical={s.activeSpherical}
                    bearing={s.activeBearing}
                    loudness={s.loudness}
                    levels={s.levels}
                    onSelectStem={s.setActiveStem}
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
        </div>
    );
}
