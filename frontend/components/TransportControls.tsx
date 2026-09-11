"use client";

import React from 'react';
import { StemName, STEM_NAMES, STEM_CONFIGS } from '../hooks/useSpatialSession';

interface TransportControlsProps {
    isPlaying: boolean;
    currentTime: number;
    duration: number;
    volumes: Record<StemName, number>;
    mutes: Record<StemName, boolean>;
    onPlay: () => void;
    onPause: () => void;
    onStop: () => void;
    onSeek: (time: number) => void;
    onSetVolume: (stem: StemName, vol: number) => void;
    onToggleMute: (stem: StemName) => void;
}

export const TransportControls: React.FC<TransportControlsProps> = ({
    isPlaying,
    currentTime,
    duration,
    volumes,
    mutes,
    onPlay,
    onPause,
    onStop,
    onSeek,
    onSetVolume,
    onToggleMute
}) => {
    const formatTime = (secs: number) => {
        const m = Math.floor(secs / 60);
        const s = Math.floor(secs % 60);
        return `${m}:${s < 10 ? '0' : ''}${s}`;
    };

    return (
        <div className="transport-master-container">
            {/* Playback Buttons & Time */}
            <div className="transport-playback-cluster">
                <button
                    onClick={isPlaying ? onPause : onPlay}
                    className="transport-btn play-btn"
                    aria-label={isPlaying ? 'Pause' : 'Play'}
                >
                    {isPlaying ? '⏸ PAUSE' : '▶ PLAY'}
                </button>
                <button
                    onClick={onStop}
                    className="transport-btn stop-btn"
                    aria-label="Stop"
                >
                    ⏹ STOP
                </button>

                <div className="transport-time-display">
                    <span className="current-time">{formatTime(currentTime)}</span>
                    <span className="time-separator">/</span>
                    <span className="duration-time">{formatTime(duration)}</span>
                </div>

                {/* Progress bar */}
                <input
                    type="range"
                    min="0"
                    max={duration || 1}
                    step="0.1"
                    value={currentTime}
                    onChange={(e) => onSeek(parseFloat(e.target.value))}
                    className="seek-bar"
                />
            </div>

            {/* Stem Mixers (Drums, Bass, Vocals, Other) */}
            <div className="transport-stem-mixers">
                {STEM_NAMES.map(stem => {
                    const c = STEM_CONFIGS[stem];
                    const isMuted = mutes[stem];
                    const vol = volumes[stem] ?? 1.0;

                    return (
                        <div key={stem} className="stem-mixer-strip">
                            <span className="mixer-dot" style={{ background: c.color }} />
                            <span className="mixer-name">{c.name.slice(0, 3).toUpperCase()}</span>

                            <input
                                type="range"
                                min="0"
                                max="1"
                                step="0.01"
                                value={isMuted ? 0 : vol}
                                onChange={(e) => onSetVolume(stem, parseFloat(e.target.value))}
                                className="volume-slider"
                                style={{ accentColor: c.color }}
                                aria-label={`${c.label} volume`}
                            />

                            <button
                                onClick={() => onToggleMute(stem)}
                                className={`mute-btn ${isMuted ? 'muted' : ''}`}
                            >
                                M
                            </button>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};
