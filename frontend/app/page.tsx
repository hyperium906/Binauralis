"use client";

import React from 'react';
import { useSpatialSession } from '../hooks/useSpatialSession';
import { SpatialCanvas3D } from '../components/SpatialCanvas3D';
import { SpatialTelemetryHUD } from '../components/SpatialTelemetryHUD';
import { TransportControls } from '../components/TransportControls';

export default function SpatialWorkstationPage() {
    const session = useSpatialSession();

    return (
        <div className="aurastream-app-layout">
            {/* Top Navigation Header */}
            <header className="app-header">
                <div className="brand-wrapper">
                    <img 
                        src="/logo_mark.svg" 
                        alt="AuraStream Emblem" 
                        className="brand-logo-img" 
                    />
                    <div className="brand-title">
                        AuraStream <span style={{ fontWeight: 400, opacity: 0.7 }}>// Spatial 3D Engine</span>
                    </div>
                </div>
                <div className="badge-status">
                    AUDIO ENGINE: {session.loudness.sampleRate} Hz (BINAURAL ACTIVE)
                </div>
            </header>

            {/* Main Interactive Stage */}
            <main className="app-main-grid">
                {/* 3D Canvas Viewport */}
                <section className="canvas-card" aria-label="3D Spatial Audio Stage">
                    <div className="canvas-overlay-instruction">
                        <h1 className="instruction-title">Interactive Soundstage</h1>
                        <p className="instruction-sub">
                            Drag orbital stems to dynamically adjust 3D azimuth, elevation, and distance attenuation.
                        </p>
                    </div>

                    <SpatialCanvas3D
                        positions={session.positions}
                        activeStem={session.activeStem}
                        rmsLevels={session.rmsLevels}
                        onSelectStem={session.setActiveStem}
                        onUpdatePosition={session.updatePosition}
                    />
                </section>

                {/* Real-time Telemetry & Loudness HUD */}
                <SpatialTelemetryHUD
                    activeStem={session.activeStem}
                    position={session.positions[session.activeStem]}
                    spherical={session.activeSpherical}
                    loudness={session.loudness}
                    onSelectStem={session.setActiveStem}
                />
            </main>

            {/* Bottom Synchronized Transport & Mixer Bar */}
            <footer aria-label="Audio Transport">
                <TransportControls
                    isPlaying={session.isPlaying}
                    currentTime={session.currentTime}
                    duration={session.duration}
                    volumes={session.volumes}
                    mutes={session.mutes}
                    onPlay={session.play}
                    onPause={session.pause}
                    onStop={session.stop}
                    onSeek={session.seek}
                    onSetVolume={session.setStemVolume}
                    onToggleMute={session.toggleMute}
                />
            </footer>
        </div>
    );
}
