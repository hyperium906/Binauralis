"use client";

import React from 'react';
import {
    StemName, STEM_NAMES, STEM_CONFIGS,
    Position3D, SphericalCoordinates, MasterLoudnessTelemetry
} from '../hooks/useSpatialSession';
import type { TrackLoudnessReport } from '../lib/api';
import type { DspBackend } from '../../web/types';

interface Props {
    activeStem: StemName;
    position: Position3D;
    spherical: SphericalCoordinates;
    bearing: string;
    loudness: MasterLoudnessTelemetry;
    trackLoudness?: TrackLoudnessReport | null;
    dspBackend?: DspBackend | 'none';
    levels: Record<StemName, number>;
    onSelectStem: (stem: StemName) => void;
    onResetPositions?: () => void;
}

const signed = (n: number, dp = 2) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(dp)}`;

/** Azimuth dial. The bearing, drawn — faster to read than the number beside it. */
const BearingDial: React.FC<{ azimuth: number; elevation: number; color: string }> = ({
    azimuth, elevation, color
}) => {
    const R = 26;
    // Screen angle: 0° azimuth points up (+Y forward), positive swings right.
    const rad = (azimuth - 90) * Math.PI / 180;
    const x = 32 + Math.cos(rad) * R;
    const y = 32 + Math.sin(rad) * R;

    return (
        <svg width="64" height="64" viewBox="0 0 64 64" fill="none" aria-hidden="true">
            <circle cx="32" cy="32" r={R} stroke="#222A36" strokeWidth="1" />
            {/* cardinal bearings */}
            <g stroke="#222A36" strokeWidth="1" strokeLinecap="round">
                <path d={`M 32 ${32 - R} v 4`} />
                <path d={`M 32 ${32 + R} v -4`} />
                <path d={`M ${32 - R} 32 h 4`} />
                <path d={`M ${32 + R} 32 h -4`} />
            </g>
            {/* the listener's forward datum */}
            <path d="M 32 32 L 32 10" stroke="#2F3A49" strokeWidth="1" strokeDasharray="2 3" />
            {/* bearing to the source */}
            <path d={`M 32 32 L ${x.toFixed(2)} ${y.toFixed(2)}`} stroke={color} strokeWidth="1.5" opacity="0.5" />
            <circle cx={x.toFixed(2)} cy={y.toFixed(2)} r="3.4" fill={color} />
            <circle cx="32" cy="32" r="3" fill="#06080B" />
            <circle cx="32" cy="32" r="3" stroke="#E8F3FF" strokeWidth="1.4" />
            {/* elevation, as a short vertical offset tick on the right margin */}
            <path
                d={`M 58 ${(32 - Math.max(-24, Math.min(24, elevation * 0.6))).toFixed(1)} h 4`}
                stroke={color} strokeWidth="1.6" strokeLinecap="round"
            />
            <path d="M 60 8 v 48" stroke="#222A36" strokeWidth="1" />
        </svg>
    );
};

export const SpatialTelemetryHUD: React.FC<Props> = ({
    activeStem, position, spherical, bearing, loudness, trackLoudness, dspBackend, levels, onSelectStem, onResetPositions
}) => {
    const cfg = STEM_CONFIGS[activeStem];

    // Meter spans the range an engineer actually works in, not -60 to 0.
    const LO = -40, HI = 0;
    const pct = (v: number) => ((Math.max(LO, Math.min(HI, v)) - LO) / (HI - LO)) * 100;

    const over = loudness.peakDbfs > -1.0;
    const filterUnit = dspBackend === 'wasm' ? 'wasm' : dspBackend === 'worklet-dsp' ? 'dsp' : 'tap';

    return (
        <aside className="readout" aria-label="Spatial telemetry">
            <section>
                <div className="sect-head">
                    <h2>Source</h2>
                    <span className="spec">{cfg.band}</span>
                </div>

                <div className="picker" role="group" aria-label="Select a stem">
                    {STEM_NAMES.map(stem => {
                        const c = STEM_CONFIGS[stem];
                        const on = stem === activeStem;
                        return (
                            <button
                                key={stem}
                                className="strip"
                                aria-pressed={on}
                                onClick={() => onSelectStem(stem)}
                                style={{ color: on ? c.color : undefined }}
                            >
                                <i style={{ background: c.color }} />
                                <span style={{ color: on ? 'var(--signal)' : 'inherit' }}>{c.label}</span>
                            </button>
                        );
                    })}
                </div>

                <div className="bearing">
                    <BearingDial azimuth={spherical.azimuthDeg} elevation={spherical.elevationDeg} color={cfg.color} />
                    <div className="bearing-text">
                        <strong>{bearing}</strong>
                        <span className="num">{signed(spherical.azimuthDeg, 1)}° azimuth</span>
                        <span className="num">{signed(spherical.elevationDeg, 1)}° elevation</span>
                    </div>
                </div>
            </section>

            <section>
                <div className="sect-head">
                    <h2>Position</h2>
                    {onResetPositions ? (
                        <button type="button" className="link-btn" onClick={onResetPositions}>
                            Reset stage
                        </button>
                    ) : (
                        <span className="spec">Listener at origin</span>
                    )}
                </div>

                <dl className="axes">
                    <div className="axis">
                        <dt>Lateral</dt>
                        <dd className="num">{signed(position.x)}<u>m</u></dd>
                    </div>
                    <div className="axis">
                        <dt>Depth</dt>
                        <dd className="num">{signed(position.y)}<u>m</u></dd>
                    </div>
                    <div className="axis">
                        <dt>Height</dt>
                        <dd className="num">{signed(position.z)}<u>m</u></dd>
                    </div>
                </dl>

                <dl className="axes">
                    <div className="axis">
                        <dt>Distance</dt>
                        <dd className="num">{spherical.distanceM.toFixed(2)}<u>m</u></dd>
                    </div>
                    <div className="axis">
                        <dt>Distance gain</dt>
                        <dd className="num">{spherical.attenuationGain.toFixed(2)}<u>×</u></dd>
                    </div>
                    <div className="axis">
                        <dt>Filter</dt>
                        <dd className="num">512<u>{filterUnit}</u></dd>
                    </div>
                </dl>
            </section>

            <section>
                <div className="sect-head">
                    <h2>Master level</h2>
                    {over ? <span className="over">OVER</span> : <span className="spec">ITU-R BS.1770-4</span>}
                </div>

                <dl className="levels">
                    <div className="level">
                        <dt>Short-term</dt>
                        <dd className="num">{loudness.rmsDbfs.toFixed(1)}<u>LUFS</u></dd>
                    </div>
                    <div className="level" data-over={over}>
                        <dt>True peak</dt>
                        <dd className="num">{loudness.peakDbfs.toFixed(1)}<u>dBTP</u></dd>
                    </div>
                    <div className="level">
                        <dt>Sample rate</dt>
                        <dd className="num">{(loudness.sampleRate / 1000).toFixed(1)}<u>kHz</u></dd>
                    </div>
                </dl>

                <div className="meter">
                    <div className="meter-track">
                        <div
                            className="meter-fill"
                            data-over={over}
                            style={{ width: `${pct(loudness.rmsDbfs)}%` }}
                        />
                        <div className="meter-tick" style={{ left: `${pct(-23)}%` }} title="EBU R128, −23 LUFS" />
                        <div className="meter-tick" style={{ left: `${pct(-14)}%` }} title="Streaming target, −14 LUFS" />
                    </div>
                    <div className="meter-scale">
                        <span style={{ left: '0%', transform: 'none' }}>−40</span>
                        <span data-target="true" style={{ left: `${pct(-23)}%` }}>−23</span>
                        <span data-target="true" style={{ left: `${pct(-14)}%` }}>−14</span>
                        <span style={{ left: '100%', transform: 'translateX(-100%)' }}>0 dBFS</span>
                    </div>
                    <p className="meter-key">
                        {trackLoudness ? (
                            <>
                                Track <span className="num">{trackLoudness.integrated_loudness_lufs.toFixed(1)}</span> LUFS
                                &nbsp;·&nbsp; LRA <span className="num">{trackLoudness.loudness_range_lu.toFixed(1)}</span> LU
                            </>
                        ) : (
                            <>−23 broadcast (EBU R128) &nbsp;·&nbsp; −14 streaming</>
                        )}
                    </p>
                </div>
            </section>

            <section>
                <div className="sect-head">
                    <h2>Sources</h2>
                    <span className="spec">Level and distance</span>
                </div>

                <ul className="sources">
                    {STEM_NAMES.map(stem => {
                        const c = STEM_CONFIGS[stem];
                        const lv = Math.max(0, Math.min(1, levels[stem] ?? 0));
                        return (
                            <li key={stem} data-active={stem === activeStem}>
                                <button onClick={() => onSelectStem(stem)}>
                                    <span className="src-name">{c.label}</span>
                                    <span className="src-bar">
                                        <span style={{ width: `${lv * 100}%`, background: c.color }} />
                                    </span>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            </section>
        </aside>
    );
};
