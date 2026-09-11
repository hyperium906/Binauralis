"use client";

import React from 'react';
import {
    StemName,
    STEM_NAMES,
    STEM_CONFIGS,
    Position3D,
    SphericalCoordinates,
    MasterLoudnessTelemetry
} from '../hooks/useSpatialSession';

interface SpatialTelemetryHUDProps {
    activeStem: StemName;
    position: Position3D;
    spherical: SphericalCoordinates;
    loudness: MasterLoudnessTelemetry;
    onSelectStem: (stem: StemName) => void;
}

export const SpatialTelemetryHUD: React.FC<SpatialTelemetryHUDProps> = ({
    activeStem,
    position,
    spherical,
    loudness,
    onSelectStem
}) => {
    const config = STEM_CONFIGS[activeStem];

    // Compute percentage along -60 to 0 LUFS scale
    const minLufs = -60.0;
    const maxLufs = 0.0;
    const clampedRms = Math.max(minLufs, Math.min(maxLufs, loudness.rmsDbfs));
    const lufsPercent = ((clampedRms - minLufs) / (maxLufs - minLufs)) * 100.0;

    // Spotify target -14 LUFS position
    const spotifyTargetPercent = ((-14.0 - minLufs) / (maxLufs - minLufs)) * 100.0;
    // EBU R128 target -23 LUFS position
    const ebuTargetPercent = ((-23.0 - minLufs) / (maxLufs - minLufs)) * 100.0;

    // Directional descriptor for Azimuth
    let directionLabel = "Front";
    const az = spherical.azimuthDeg;
    if (Math.abs(az) < 15) directionLabel = "Front Center";
    else if (az >= 15 && az <= 75) directionLabel = "Front-Right";
    else if (az > 75 && az < 105) directionLabel = "Direct Right";
    else if (az >= 105 && az <= 165) directionLabel = "Rear-Right";
    else if (Math.abs(az) > 165) directionLabel = "Behind";
    else if (az <= -15 && az >= -75) directionLabel = "Front-Left";
    else if (az < -75 && az > -105) directionLabel = "Direct Left";
    else if (az <= -105 && az >= -165) directionLabel = "Rear-Left";

    return (
        <aside className="telemetry-hud-container" aria-label="Spatial Audio Telemetry">
            {/* Stem Selector Tabs */}
            <div className="hud-tabs">
                {STEM_NAMES.map(stem => {
                    const c = STEM_CONFIGS[stem];
                    const isActive = stem === activeStem;
                    return (
                        <button
                            key={stem}
                            onClick={() => onSelectStem(stem)}
                            className={`hud-tab-btn ${isActive ? 'active' : ''}`}
                            style={{
                                borderColor: isActive ? c.color : 'transparent',
                                color: isActive ? '#ffffff' : 'var(--text-muted)'
                            }}
                        >
                            <span className="tab-indicator" style={{ background: c.color }} />
                            {c.name.toUpperCase()}
                        </button>
                    );
                })}
            </div>

            {/* Active Stem Coordinates Card */}
            <div className="hud-card">
                <div className="hud-card-header">
                    <div className="stem-title-badge" style={{ color: config.color }}>
                        <span className="pulsing-dot" style={{ background: config.color }} />
                        {config.label}
                    </div>
                    <span className="hud-direction-badge">{directionLabel}</span>
                </div>

                {/* 3D Cartesian Coordinates */}
                <div className="telemetry-grid">
                    <div className="telemetry-item">
                        <span className="telemetry-label">X (LATERAL)</span>
                        <span className="telemetry-val">
                            {position.x >= 0 ? `+${position.x.toFixed(2)}` : position.x.toFixed(2)}
                            <span className="unit">m</span>
                        </span>
                    </div>
                    <div className="telemetry-item">
                        <span className="telemetry-label">Y (FRONTAL)</span>
                        <span className="telemetry-val">
                            {position.y >= 0 ? `+${position.y.toFixed(2)}` : position.y.toFixed(2)}
                            <span className="unit">m</span>
                        </span>
                    </div>
                    <div className="telemetry-item">
                        <span className="telemetry-label">Z (ELEVATION)</span>
                        <span className="telemetry-val">
                            {position.z >= 0 ? `+${position.z.toFixed(2)}` : position.z.toFixed(2)}
                            <span className="unit">m</span>
                        </span>
                    </div>
                </div>

                {/* Spherical Coordinates & Acoustic Attenuation */}
                <div className="telemetry-grid" style={{ marginTop: '0.85rem' }}>
                    <div className="telemetry-item">
                        <span className="telemetry-label">AZIMUTH (θ)</span>
                        <span className="telemetry-val">
                            {spherical.azimuthDeg >= 0 ? `+${spherical.azimuthDeg.toFixed(1)}` : spherical.azimuthDeg.toFixed(1)}°
                        </span>
                    </div>
                    <div className="telemetry-item">
                        <span className="telemetry-label">ELEVATION (φ)</span>
                        <span className="telemetry-val">
                            {spherical.elevationDeg >= 0 ? `+${spherical.elevationDeg.toFixed(1)}` : spherical.elevationDeg.toFixed(1)}°
                        </span>
                    </div>
                    <div className="telemetry-item">
                        <span className="telemetry-label">DISTANCE GAIN</span>
                        <span className="telemetry-val">
                            {spherical.attenuationGain.toFixed(2)}
                            <span className="unit">×</span>
                        </span>
                    </div>
                </div>
            </div>

            {/* Master Loudness Telemetry (ITU-R BS.1770-4 / EBU R128) */}
            <div className="hud-card">
                <div className="hud-card-header">
                    <span style={{ fontSize: '0.8rem', fontWeight: 600, letterSpacing: '0.5px' }}>
                        MASTER TELEMETRY (BS.1770-4)
                    </span>
                    {loudness.isClipping && <span className="clip-badge">CLIP</span>}
                </div>

                <div className="loudness-metrics-row">
                    <div>
                        <span className="telemetry-label">INTEGRATED</span>
                        <div className="telemetry-val-large">
                            {loudness.rmsDbfs.toFixed(1)}
                            <span className="unit">LUFS</span>
                        </div>
                    </div>
                    <div>
                        <span className="telemetry-label">TRUE PEAK</span>
                        <div className="telemetry-val-large">
                            {loudness.peakDbfs.toFixed(1)}
                            <span className="unit">dBFS</span>
                        </div>
                    </div>
                    <div>
                        <span className="telemetry-label">SAMPLE RATE</span>
                        <div className="telemetry-val-large">
                            {loudness.sampleRate}
                            <span className="unit">Hz</span>
                        </div>
                    </div>
                </div>

                {/* Integrated Horizontal LUFS Meter Bar */}
                <div className="lufs-meter-bar-wrapper">
                    <div className="meter-scale-markers">
                        <span>-60</span>
                        <span>-36</span>
                        <span style={{ color: 'var(--accent-blue)' }}>-23 (EBU)</span>
                        <span style={{ color: 'var(--accent-cyan)' }}>-14 (SPOTIFY)</span>
                        <span>0 dBFS</span>
                    </div>

                    <div className="meter-track">
                        {/* Fill */}
                        <div className="meter-fill-bar" style={{ width: `${lufsPercent}%` }} />

                        {/* EBU R128 Target Marker (-23 LUFS) */}
                        <div
                            className="meter-target-tick"
                            style={{ left: `${ebuTargetPercent}%` }}
                            title="EBU R128 Broadcast Target (-23 LUFS)"
                        />

                        {/* Spotify Target Marker (-14 LUFS) */}
                        <div
                            className="meter-target-tick spotify-target"
                            style={{ left: `${spotifyTargetPercent}%` }}
                            title="Spotify Target (-14 LUFS)"
                        />
                    </div>
                </div>
            </div>
        </aside>
    );
};
