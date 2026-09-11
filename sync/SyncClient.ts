import {
    SyncPacket,
    PingPacket,
    PongPacket,
    SyncTransportPacket,
    NodeMovePacket,
    JoinRoomPacket,
    RoomStatePacket,
    StemName,
    Vector3D,
    TransportAction
} from './protocol';
import { ClockSync } from './ClockSync';
import { JitterBuffer } from './JitterBuffer';

export interface SyncClientCallbacks {
    onRoomState?: (state: RoomStatePacket) => void;
    onScheduledTransport?: (action: TransportAction, delaySec: number, audioOffsetSec: number) => void;
    onPeerJoined?: (clientId: string) => void;
    onPeerLeft?: (clientId: string) => void;
}

export class SyncClient {
    private ws: any = null; // WebSocket instance (Node or Browser)
    private readonly serverUrl: string;
    private readonly roomId: string;
    private readonly clientId: string;

    public readonly clockSync: ClockSync;
    public readonly jitterBuffer: JitterBuffer;

    private callbacks: SyncClientCallbacks = {};
    private moveSeq: number = 0;
    private isConnected: boolean = false;

    constructor(
        serverUrl: string,
        roomId: string,
        clientId: string = `peer_${Math.random().toString(36).substring(2, 8)}`,
        callbacks: SyncClientCallbacks = {}
    ) {
        this.serverUrl = serverUrl;
        this.roomId = roomId;
        this.clientId = clientId;
        this.callbacks = callbacks;

        this.clockSync = new ClockSync();
        this.jitterBuffer = new JitterBuffer({ interpolationDelayMs: 40 });
    }

    public connect(WebSocketConstructor?: any): Promise<void> {
        return new Promise((resolve, reject) => {
            const WS = WebSocketConstructor || (typeof WebSocket !== 'undefined' ? WebSocket : null);
            if (!WS) {
                return reject(new Error('WebSocket constructor not found.'));
            }

            this.ws = new WS(this.serverUrl);

            this.ws.onopen = () => {
                this.isConnected = true;

                // 1. Start continuous NTP clock synchronization loop
                this.clockSync.start((ping: PingPacket) => {
                    this.send(ping);
                }, 2000);

                // 2. Join session room
                const joinPacket: JoinRoomPacket = {
                    type: 'JOIN_ROOM',
                    roomId: this.roomId,
                    clientId: this.clientId
                };
                this.send(joinPacket);

                resolve();
            };

            this.ws.onmessage = (event: any) => {
                const data = typeof event.data === 'string' ? event.data : event.data.toString();
                try {
                    const packet: SyncPacket = JSON.parse(data);
                    this.handlePacket(packet);
                } catch (err) {
                    console.error('[SyncClient] Parse error:', err);
                }
            };

            this.ws.onerror = (err: any) => {
                console.error('[SyncClient] Error:', err);
            };

            this.ws.onclose = () => {
                this.isConnected = false;
                this.clockSync.stop();
            };
        });
    }

    public disconnect(): void {
        this.clockSync.stop();
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.isConnected = false;
    }

    private handlePacket(packet: SyncPacket): void {
        switch (packet.type) {
            case 'PONG': {
                this.clockSync.handlePong(packet);
                break;
            }

            case 'ROOM_STATE': {
                // Initialize jitter buffer with current positions
                for (const [stem, pos] of Object.entries(packet.positions)) {
                    this.jitterBuffer.pushKeyframe(stem as StemName, pos, this.clockSync.getServerTime());
                }
                if (this.callbacks.onRoomState) {
                    this.callbacks.onRoomState(packet);
                }
                break;
            }

            case 'NODE_MOVE': {
                // Feed incoming 3D position keyframe into Hermite spline jitter buffer
                this.jitterBuffer.pushKeyframe(packet.stem, packet.position, packet.timestamp);
                break;
            }

            case 'SYNC_TRANSPORT': {
                // Compute scheduled local execution delay
                const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
                const localTargetTime = this.clockSync.toLocalTime(packet.serverTargetTime);
                const delayMs = Math.max(0, localTargetTime - now);
                const delaySec = delayMs / 1000.0;

                if (this.callbacks.onScheduledTransport) {
                    this.callbacks.onScheduledTransport(packet.action, delaySec, packet.audioOffsetSec);
                }
                break;
            }

            case 'PEER_JOINED': {
                if (this.callbacks.onPeerJoined) this.callbacks.onPeerJoined(packet.clientId);
                break;
            }

            case 'PEER_LEFT': {
                if (this.callbacks.onPeerLeft) this.callbacks.onPeerLeft(packet.clientId);
                break;
            }

            default:
                break;
        }
    }

    /**
     * @brief Broadcast node position update to room peers.
     */
    public broadcastPosition(stem: StemName, x: number, y: number, z: number): void {
        const timestamp = this.clockSync.getServerTime();
        const packet: NodeMovePacket = {
            type: 'NODE_MOVE',
            stem,
            position: { x, y, z },
            timestamp,
            seq: ++this.moveSeq,
            senderId: this.clientId,
            roomId: this.roomId
        };

        // Also push locally into jitter buffer for unified tracking
        this.jitterBuffer.pushKeyframe(stem, packet.position, timestamp);
        this.send(packet);
    }

    /**
     * @brief Request synchronized transport state change across all room peers.
     */
    public requestTransport(action: TransportAction, audioOffsetSec: number = 0): void {
        const packet: SyncTransportPacket = {
            type: 'SYNC_TRANSPORT',
            action,
            serverTargetTime: 0, // Server assigns future target timestamp
            audioOffsetSec,
            senderId: this.clientId,
            roomId: this.roomId
        };
        this.send(packet);
    }

    /**
     * @brief Query smooth interpolated 3D position for a stem.
     */
    public getSmoothPosition(stem: StemName): Vector3D {
        const currentServerTime = this.clockSync.getServerTime();
        return this.jitterBuffer.evaluate(stem, currentServerTime);
    }

    private send(packet: SyncPacket): void {
        if (this.ws && this.isConnected) {
            this.ws.send(JSON.stringify(packet));
        }
    }
}
