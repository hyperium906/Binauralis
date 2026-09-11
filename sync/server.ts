import { WebSocketServer, WebSocket } from 'ws';
import {
    SyncPacket,
    PingPacket,
    PongPacket,
    SyncTransportPacket,
    NodeMovePacket,
    JoinRoomPacket,
    RoomStatePacket,
    PeerJoinedPacket,
    PeerLeftPacket,
    StemName,
    Vector3D
} from './protocol';

interface ClientMetadata {
    clientId: string;
    roomId?: string;
    ws: WebSocket;
}

interface RoomState {
    roomId: string;
    positions: Record<StemName, Vector3D>;
    isPlaying: boolean;
    audioOffsetSec: number;
    lastTransportChangeServerTime: number;
    clients: Set<WebSocket>;
}

export class AuraStreamSyncServer {
    private wss: WebSocketServer | null = null;
    private clients: Map<WebSocket, ClientMetadata> = new Map();
    private rooms: Map<string, RoomState> = new Map();
    private readonly port: number;

    constructor(port: number = 8080) {
        this.port = port;
    }

    public start(): Promise<void> {
        return new Promise((resolve) => {
            this.wss = new WebSocketServer({ port: this.port }, () => {
                console.info(`[AuraStreamSyncServer] Listening on ws://0.0.0.0:${this.port}`);
                resolve();
            });

            this.wss.on('connection', (ws: WebSocket) => {
                this.handleConnection(ws);
            });
        });
    }

    public stop(): Promise<void> {
        return new Promise((resolve) => {
            if (!this.wss) return resolve();
            this.wss.close(() => {
                console.info('[AuraStreamSyncServer] Stopped.');
                resolve();
            });
        });
    }

    private handleConnection(ws: WebSocket): void {
        const clientMeta: ClientMetadata = {
            clientId: `client_${Math.random().toString(36).substring(2, 9)}`,
            ws
        };
        this.clients.set(ws, clientMeta);

        ws.on('message', (data: string | Buffer) => {
            try {
                const packet: SyncPacket = JSON.parse(data.toString());
                this.handlePacket(ws, clientMeta, packet);
            } catch (err) {
                console.error('[AuraStreamSyncServer] Invalid packet format:', err);
            }
        });

        ws.on('close', () => {
            this.handleDisconnection(ws, clientMeta);
        });
    }

    private handlePacket(ws: WebSocket, client: ClientMetadata, packet: SyncPacket): void {
        const nowServerTime = Date.now();

        switch (packet.type) {
            case 'PING': {
                // Immediate low-overhead PONG response for NTP clock synchronization
                const pong: PongPacket = {
                    type: 'PONG',
                    clientTime: packet.clientTime,
                    serverTime: nowServerTime,
                    seq: packet.seq
                };
                ws.send(JSON.stringify(pong));
                break;
            }

            case 'JOIN_ROOM': {
                this.handleJoinRoom(ws, client, packet);
                break;
            }

            case 'SYNC_TRANSPORT': {
                this.handleSyncTransport(client, packet);
                break;
            }

            case 'NODE_MOVE': {
                this.handleNodeMove(client, packet);
                break;
            }

            default:
                break;
        }
    }

    private handleJoinRoom(ws: WebSocket, client: ClientMetadata, packet: JoinRoomPacket): void {
        const { roomId, clientId } = packet;
        client.roomId = roomId;
        client.clientId = clientId || client.clientId;

        let room = this.rooms.get(roomId);
        if (!room) {
            room = {
                roomId,
                positions: {
                    vocals: { x: 0.0, y: 1.8, z: 0.2 },
                    drums:  { x: -1.2, y: 1.2, z: 0.0 },
                    bass:   { x: 0.0, y: 0.8, z: -0.4 },
                    other:  { x: 1.2, y: 1.4, z: 0.1 }
                },
                isPlaying: false,
                audioOffsetSec: 0,
                lastTransportChangeServerTime: Date.now(),
                clients: new Set()
            };
            this.rooms.set(roomId, room);
        }

        room.clients.add(ws);

        // Send current session state to new joiner
        const statePacket: RoomStatePacket = {
            type: 'ROOM_STATE',
            roomId,
            positions: room.positions,
            isPlaying: room.isPlaying,
            audioOffsetSec: room.audioOffsetSec,
            peers: Array.from(room.clients).map(c => this.clients.get(c)?.clientId || 'unknown')
        };
        ws.send(JSON.stringify(statePacket));

        // Notify other room peers
        const peerJoined: PeerJoinedPacket = {
            type: 'PEER_JOINED',
            clientId: client.clientId,
            roomId
        };
        this.broadcastToRoom(roomId, peerJoined, ws);
    }

    private handleSyncTransport(client: ClientMetadata, packet: SyncTransportPacket): void {
        const room = client.roomId ? this.rooms.get(client.roomId) : null;
        if (!room) return;

        // Schedule playback start 150ms in the future so all peers trigger on the exact same audio millisecond
        const scheduleLookaheadMs = 150;
        const targetServerTime = Date.now() + scheduleLookaheadMs;

        room.isPlaying = packet.action === 'PLAY';
        room.audioOffsetSec = packet.audioOffsetSec;
        room.lastTransportChangeServerTime = targetServerTime;

        const broadcastPacket: SyncTransportPacket = {
            type: 'SYNC_TRANSPORT',
            action: packet.action,
            serverTargetTime: targetServerTime,
            audioOffsetSec: packet.audioOffsetSec,
            senderId: client.clientId,
            roomId: room.roomId
        };

        // Broadcast to ALL peers in room including sender so timeline is perfectly unified
        this.broadcastToRoom(room.roomId, broadcastPacket);
    }

    private handleNodeMove(client: ClientMetadata, packet: NodeMovePacket): void {
        const room = client.roomId ? this.rooms.get(client.roomId) : null;
        if (!room) return;

        // Update authoritative room position state
        if (packet.stem in room.positions) {
            room.positions[packet.stem] = packet.position;
        }

        // Broadcast to all other peers with sender echo suppression
        this.broadcastToRoom(room.roomId, packet, client.ws);
    }

    private handleDisconnection(ws: WebSocket, client: ClientMetadata): void {
        if (client.roomId) {
            const room = this.rooms.get(client.roomId);
            if (room) {
                room.clients.delete(ws);
                const peerLeft: PeerLeftPacket = {
                    type: 'PEER_LEFT',
                    clientId: client.clientId,
                    roomId: client.roomId
                };
                this.broadcastToRoom(client.roomId, peerLeft);

                if (room.clients.size === 0) {
                    this.rooms.delete(client.roomId);
                }
            }
        }
        this.clients.delete(ws);
    }

    private broadcastToRoom(roomId: string, packet: SyncPacket, excludeWs?: WebSocket): void {
        const room = this.rooms.get(roomId);
        if (!room) return;

        const data = JSON.stringify(packet);
        for (const clientWs of room.clients) {
            if (clientWs !== excludeWs && clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(data);
            }
        }
    }
}

// Standalone execution entrypoint
if (typeof require !== 'undefined' && require.main === module) {
    const port = parseInt(process.env.PORT || '8080', 10);
    const server = new AuraStreamSyncServer(port);
    server.start();
}
