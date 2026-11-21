/**
 * AuraStream Real-Time Multi-Client Synchronization Wire Protocol
 */

export type StemName = 'vocals' | 'drums' | 'bass' | 'other';

export interface Vector3D {
    x: number;
    y: number;
    z: number;
}

export type TransportAction = 'PLAY' | 'PAUSE' | 'STOP' | 'SEEK';

// -----------------------------------------------------------------------------
// NTP-Style Clock Synchronization Packets
// -----------------------------------------------------------------------------
export interface PingPacket {
    type: 'PING';
    clientTime: number; // t0: client local send timestamp in ms
    seq: number;
}

export interface PongPacket {
    type: 'PONG';
    clientTime: number; // t0 echoed back
    serverTime: number; // t1/t2: server timestamp in ms
    seq: number;
}

// -----------------------------------------------------------------------------
// Synchronized Transport & Spatial Movement Packets
// -----------------------------------------------------------------------------
export interface SyncTransportPacket {
    type: 'SYNC_TRANSPORT';
    action: TransportAction;
    serverTargetTime: number; // Future server timestamp when action must execute
    audioOffsetSec: number;   // Position in track
    senderId: string;
    roomId: string;
}

export interface NodeMovePacket {
    type: 'NODE_MOVE';
    stem: StemName;
    position: Vector3D;
    timestamp: number; // Sender's estimated server timestamp
    seq: number;
    senderId: string;
    roomId: string;
}

export interface RoomTrackInfo {
    jobId: string | null;
    title: string;
    mode: 'reference' | 'service';
    stemUrls?: Record<StemName, string>;
    apiBaseUrl?: string;
    duration?: number;
}

export interface SyncTrackPacket {
    type: 'SYNC_TRACK';
    track: RoomTrackInfo;
    senderId: string;
    roomId: string;
}

// -----------------------------------------------------------------------------
// Room Session Lifecycle Packets
// -----------------------------------------------------------------------------
export interface JoinRoomPacket {
    type: 'JOIN_ROOM';
    roomId: string;
    clientId: string;
}

export interface RoomStatePacket {
    type: 'ROOM_STATE';
    roomId: string;
    positions: Record<StemName, Vector3D>;
    isPlaying: boolean;
    audioOffsetSec: number;
    peers: string[];
    serverTime?: number;
    track?: RoomTrackInfo;
}

export interface PeerJoinedPacket {
    type: 'PEER_JOINED';
    clientId: string;
    roomId: string;
}

export interface PeerLeftPacket {
    type: 'PEER_LEFT';
    clientId: string;
    roomId: string;
}

export type SyncPacket =
    | PingPacket
    | PongPacket
    | SyncTransportPacket
    | NodeMovePacket
    | SyncTrackPacket
    | JoinRoomPacket
    | RoomStatePacket
    | PeerJoinedPacket
    | PeerLeftPacket;
