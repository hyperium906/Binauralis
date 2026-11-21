"use client";

import React, { useEffect, useId, useRef, useState } from 'react';
import type { SyncSessionState } from '../hooks/useSpatialSession';

interface SyncRoomDialogProps {
    open: boolean;
    onClose: () => void;
    syncState: SyncSessionState;
    onConnect: (roomId: string, serverUrl: string) => Promise<void>;
    onDisconnect: () => void;
}

export const SyncRoomDialog: React.FC<SyncRoomDialogProps> = ({
    open,
    onClose,
    syncState,
    onConnect,
    onDisconnect
}) => {
    const dialogRef = useRef<HTMLDialogElement>(null);
    const titleId = useId();
    const roomInputId = useId();
    const urlInputId = useId();

    const [roomInput, setRoomInput] = useState(syncState.roomId);
    const [urlInput, setUrlInput] = useState(syncState.serverUrl);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        setRoomInput(syncState.roomId);
    }, [syncState.roomId]);

    useEffect(() => {
        const dialog = dialogRef.current;
        if (!dialog) return;
        if (open && !dialog.open) {
            dialog.showModal();
        } else if (!open && dialog.open) {
            dialog.close();
        }
    }, [open]);

    useEffect(() => {
        const dialog = dialogRef.current;
        if (!dialog) return;

        const handleClose = () => {
            dialog.returnValue = '';
            onClose();
        };
        dialog.addEventListener('close', handleClose);

        // Safari fallback for <dialog closedby="any">
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

    const connected = syncState.status === 'connected';
    const connecting = syncState.status === 'connecting';

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (connected) {
            onDisconnect();
        } else {
            await onConnect(roomInput, urlInput);
        }
    };

    const copyInviteLink = async () => {
        if (typeof window === 'undefined') return;
        const url = new URL(window.location.href);
        url.searchParams.set('room', roomInput.trim() || 'studio-1');
        try {
            await navigator.clipboard.writeText(url.toString());
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1800);
        } catch {
            // Clipboard unavailable
        }
    };

    return (
        <dialog
            ref={dialogRef}
            className="modal"
            aria-labelledby={titleId}
            {...({ closedby: 'any' } as Record<string, string>)}
        >
            <div className="modal-head">
                <div>
                    <h2 id={titleId}>Multi-client sync</h2>
                    <p className="modal-sub">
                        150 ms lookahead transport · 40 ms Cubic Hermite spline smoothing
                    </p>
                </div>
                <form method="dialog">
                    <button type="submit" className="modal-close" aria-label="Close sync dialog">
                        Close
                    </button>
                </form>
            </div>

            <div className="modal-body">
                <section className="modal-sect">
                    <form className="sync-form" onSubmit={handleSubmit}>
                        <div className="field-grid">
                            <div className="field">
                                <label htmlFor={roomInputId}>Room</label>
                                <input
                                    id={roomInputId}
                                    type="text"
                                    value={roomInput}
                                    disabled={connected || connecting}
                                    onChange={(e) => setRoomInput(e.target.value)}
                                    placeholder="studio-1"
                                    autoFocus
                                />
                            </div>
                            <div className="field">
                                <label htmlFor={urlInputId}>Sync server</label>
                                <input
                                    id={urlInputId}
                                    type="url"
                                    value={urlInput}
                                    disabled={connected || connecting}
                                    onChange={(e) => setUrlInput(e.target.value)}
                                    placeholder="ws://localhost:8080"
                                />
                            </div>
                        </div>

                        <div className="btn-row">
                            <button
                                type="submit"
                                className={connected ? 'btn' : 'btn btn-primary'}
                                disabled={connecting}
                            >
                                {connecting ? 'Connecting…' : connected ? 'Disconnect room' : 'Join room'}
                            </button>

                            <button
                                type="button"
                                className="btn"
                                onClick={copyInviteLink}
                            >
                                {copied ? 'Room link copied' : 'Copy room link'}
                            </button>
                        </div>

                        {syncState.error && (
                            <p className="status-line" data-error="true" role="status">
                                {syncState.error} — start the sync server with <code>make run_sync</code>.
                            </p>
                        )}
                    </form>
                </section>

                <section className="modal-sect">
                    <div className="sect-head">
                        <h3>NTP clock telemetry</h3>
                        <span className="spec">
                            {connected
                                ? (syncState.isSynced ? 'Clock locked' : 'Converging…')
                                : 'Solo mode'}
                        </span>
                    </div>

                    <dl className="axes">
                        <div className="axis">
                            <dt>Clock offset</dt>
                            <dd className="num">
                                {connected ? `${syncState.offsetMs >= 0 ? '+' : '−'}${Math.abs(syncState.offsetMs).toFixed(1)}` : '—'}
                                <u>ms</u>
                            </dd>
                        </div>
                        <div className="axis">
                            <dt>Min RTT</dt>
                            <dd className="num">
                                {connected ? syncState.minRttMs.toFixed(2) : '—'}
                                <u>ms</u>
                            </dd>
                        </div>
                        <div className="axis">
                            <dt>Peers</dt>
                            <dd className="num">
                                {connected ? syncState.peers.length : 1}
                                <u>live</u>
                            </dd>
                        </div>
                    </dl>

                    {connected && syncState.peers.length > 0 && (
                        <ul className="peer-list">
                            {syncState.peers.map((peer) => (
                                <li key={peer} className="num">
                                    <span className="lamp-inline" data-state="live" />
                                    {peer}
                                    {peer === syncState.clientId ? ' (this station)' : ''}
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            </div>
        </dialog>
    );
};
