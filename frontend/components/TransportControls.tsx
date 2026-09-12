"use client";

import React from 'react';
import { StemName, STEM_NAMES, STEM_CONFIGS } from '../hooks/useSpatialSession';

interface Props {
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

const clock = (s: number) => {
    const t = Math.max(0, s);
    const m = Math.floor(t / 60);
    const sec = Math.floor(t % 60);
    return `${m}:${sec < 10 ? '0' : ''}${sec}`;
};

export const TransportControls: React.FC<Props> = ({
    isPlaying, currentTime, duration, volumes, mutes,
    onPlay, onPause, onStop, onSeek, onSetVolume, onToggleMute
}) => (
    <div className="transport">
        <div className="deck">
            <button
                className="key"
                data-lit={isPlaying}
                onClick={isPlaying ? onPause : onPlay}
                aria-label={isPlaying ? 'Pause' : 'Play'}
            >
                {isPlaying ? (
                    <svg width="10" height="12" viewBox="0 0 10 12" aria-hidden="true">
                        <rect width="3.2" height="12" fill="currentColor" />
                        <rect x="6.8" width="3.2" height="12" fill="currentColor" />
                    </svg>
                ) : (
                    <svg width="10" height="12" viewBox="0 0 10 12" aria-hidden="true">
                        <path d="M0 0 L10 6 L0 12 Z" fill="currentColor" />
                    </svg>
                )}
            </button>

            <button className="key" onClick={onStop} aria-label="Stop and return to start">
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                    <rect width="10" height="10" fill="currentColor" />
                </svg>
            </button>

            <div className="clock">
                {clock(currentTime)}<s>/</s><i>{clock(duration)}</i>
            </div>

            <input
                type="range"
                className="slide scrub"
                min={0}
                max={duration || 1}
                step={0.1}
                value={Math.min(currentTime, duration || 1)}
                onChange={e => onSeek(parseFloat(e.target.value))}
                aria-label="Playback position"
            />
        </div>

        <div className="faders">
            {STEM_NAMES.map(stem => {
                const c = STEM_CONFIGS[stem];
                const muted = mutes[stem];
                const vol = volumes[stem] ?? 1;
                return (
                    <div className="fader" key={stem} data-muted={muted}>
                        <label htmlFor={`fader-${stem}`} style={{ color: muted ? undefined : c.color }}>
                            {c.label}
                        </label>
                        <input
                            id={`fader-${stem}`}
                            type="range"
                            className="slide"
                            min={0}
                            max={1}
                            step={0.01}
                            value={muted ? 0 : vol}
                            onChange={e => onSetVolume(stem, parseFloat(e.target.value))}
                            aria-label={`${c.label} level`}
                        />
                        <button
                            className="cut"
                            aria-pressed={muted}
                            onClick={() => onToggleMute(stem)}
                            aria-label={`${muted ? 'Unmute' : 'Mute'} ${c.label}`}
                        >
                            M
                        </button>
                    </div>
                );
            })}
        </div>
    </div>
);
