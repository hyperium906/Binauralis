import assert from 'node:assert';
import { WebSocket } from 'ws';
import { AuraStreamSyncServer } from '../server';
import { SyncClient } from '../SyncClient';
import { ClockSync } from '../ClockSync';
import { JitterBuffer } from '../JitterBuffer';

// =============================================================================
// Test 1: NTP-Style Clock Synchronization Under Network Latency & Jitter
// =============================================================================
async function testClockSyncConvergence() {
    console.log('[Test 1] NTP Clock Synchronization Convergence Under Jitter... ');
    const clock = new ClockSync({ sampleWindowSize: 16, minSamplesForSync: 4 });

    const trueServerOffset = 3450.0; // Simulated server clock is ahead by 3450ms
    const baseRtt = 30.0;            // 30ms round-trip latency

    for (let i = 1; i <= 10; ++i) {
        // Random network jitter: +/- 6ms
        const jitter = (Math.random() - 0.5) * 12.0;
        const rtt = baseRtt + jitter;
        const oneWayDelay = rtt / 2.0;

        const clientSendTime = 1000.0 + i * 100;
        // Server receives and timestamps at clientSendTime + oneWayDelay + trueServerOffset
        const serverTimestamp = clientSendTime + oneWayDelay + trueServerOffset;

        // Simulated client receive after full RTT
        const pong = {
            type: 'PONG' as const,
            clientTime: clientSendTime,
            serverTime: serverTimestamp,
            seq: i
        };

        clock.handlePong(pong, clientSendTime + rtt);
    }

    assert(clock.isSynchronized(), 'Clock failed to achieve synchronization status!');
    const estimatedOffset = clock.getOffset();
    const errorMs = Math.abs(estimatedOffset - trueServerOffset);

    assert(errorMs < 3.0, `Clock offset error too high! Expected ~${trueServerOffset}, got ${estimatedOffset} (Error: ${errorMs.toFixed(2)}ms)`);
    console.log(`PASSED (True Offset: ${trueServerOffset}ms | Estimated: ${estimatedOffset.toFixed(2)}ms | Error: ${errorMs.toFixed(2)}ms)`);
}

// =============================================================================
// Test 2: Cubic Hermite Spline Jitter Buffer Smoothing
// =============================================================================
function testJitterBufferSplineContinuity() {
    console.log('[Test 2] Cubic Hermite Spline Jitter Smoothing & Continuity... ');
    const jitter = new JitterBuffer({ interpolationDelayMs: 40 });

    // Push sequence of keyframes representing a source moving smoothly from X=0.0 to X=2.0
    // Keyframes at t = 0, 50, 100, 150, 200 ms
    jitter.pushKeyframe('vocals', { x: 0.0, y: 1.0, z: 0.0 }, 1000);
    jitter.pushKeyframe('vocals', { x: 0.5, y: 1.2, z: 0.1 }, 1050);
    jitter.pushKeyframe('vocals', { x: 1.0, y: 1.5, z: 0.2 }, 1100);
    jitter.pushKeyframe('vocals', { x: 1.5, y: 1.8, z: 0.3 }, 1150);
    jitter.pushKeyframe('vocals', { x: 2.0, y: 2.0, z: 0.4 }, 1200);

    // Evaluate position at renderTime = 1100 (serverTime = 1140 with 40ms delay)
    // Should be exactly at keyframe 2: x = 1.0
    const pMid = jitter.evaluate('vocals', 1140);
    assert(Math.abs(pMid.x - 1.0) < 0.05, `Expected x ≈ 1.0, got ${pMid.x}`);

    // Evaluate intermediate step between 1100 and 1150: renderTime = 1125 (serverTime = 1165)
    // Should lie smoothly halfway between 1.0 and 1.5 (x ≈ 1.25)
    const pInterp = jitter.evaluate('vocals', 1165);
    assert(pInterp.x > 1.0 && pInterp.x < 1.5, `Spline overshoot/undershoot: got ${pInterp.x}`);
    assert(Math.abs(pInterp.x - 1.25) < 0.1, `Expected smooth Hermite value near 1.25, got ${pInterp.x}`);

    console.log(`PASSED (Keyframe Midpoint: x=${pMid.x} | Hermite Interp: x=${pInterp.x})`);
}

// =============================================================================
// Test 3: Live Multi-Client WebSocket Signaling & Scheduled Transport
// =============================================================================
async function testLiveMultiClientSync() {
    console.log('[Test 3] Multi-Client WebSocket Signaling & Sub-50ms Transport Sync... ');

    const TEST_PORT = 9876;
    const server = new AuraStreamSyncServer(TEST_PORT);
    await server.start();

    const serverUrl = `ws://localhost:${TEST_PORT}`;
    const ROOM = 'spatial-collab-room-1';

    let clientBReceivedMove = false;
    let clientBTargetTime = 0;
    let clientATargetTime = 0;

    const clientA = new SyncClient(serverUrl, ROOM, 'client_A', {
        onScheduledTransport: (action, delaySec) => {
            clientATargetTime = Date.now() + delaySec * 1000;
        }
    });

    const clientB = new SyncClient(serverUrl, ROOM, 'client_B', {
        onScheduledTransport: (action, delaySec) => {
            clientBTargetTime = Date.now() + delaySec * 1000;
        }
    });

    await clientA.connect(WebSocket);
    await clientB.connect(WebSocket);

    // Allow connection and initial clock sync handshake to settle
    await new Promise(r => setTimeout(r, 200));

    // Client A moves 'vocals' stem
    clientA.broadcastPosition('vocals', 1.8, 2.2, 0.5);

    // Allow packet to travel to Client B
    await new Promise(r => setTimeout(r, 60));

    // Client B evaluates position from its jitter buffer
    const posB = clientB.getSmoothPosition('vocals');
    assert(posB !== undefined, 'Client B failed to receive position update!');
    console.log(`         Peer B received and smoothed position for vocals: X=${posB.x}, Y=${posB.y}`);

    // Client A requests synchronized PLAY transport
    clientA.requestTransport('PLAY', 0);

    // Wait for transport packet broadcast
    await new Promise(r => setTimeout(r, 80));

    assert(clientATargetTime > 0, 'Client A did not receive scheduled transport!');
    assert(clientBTargetTime > 0, 'Client B did not receive scheduled transport!');

    // Verify scheduled execution difference across peers is sub-millisecond precision (< 5ms)
    const clientDifferenceMs = Math.abs(clientATargetTime - clientBTargetTime);
    assert(clientDifferenceMs < 5.0, `Inter-client transport skew too high: ${clientDifferenceMs.toFixed(2)}ms`);

    console.log(`PASSED (Transport sync skew across remote peers: ${clientDifferenceMs.toFixed(2)}ms, Sub-50ms target met!)`);

    clientA.disconnect();
    clientB.disconnect();
    await server.stop();
}

// =============================================================================
// Test 4: Shared Room Track Sync & First-Sample Clock Offset Priming
// =============================================================================
async function testTrackSyncAndEarlyClockOffset() {
    console.log('[Test 4] Shared Room Track Sync & Immediate Clock Priming... ');

    const clock = new ClockSync({ minSamplesForSync: 4 });
    clock.handlePong({ type: 'PONG', clientTime: 100, serverTime: 5110, seq: 1 }, 120);
    assert(clock.hasOffset(), 'Clock should prime offset on the first PONG sample');
    assert(Math.abs(clock.getOffset() - 5000) < 0.01, `Unexpected first-sample offset: ${clock.getOffset()}`);
    assert(!clock.isSynchronized(), 'Clock should remain unsynced until minSamplesForSync are collected');

    const TEST_PORT = 9877;
    const server = new AuraStreamSyncServer(TEST_PORT);
    await server.start();

    const serverUrl = `ws://localhost:${TEST_PORT}`;
    const ROOM = 'track-sync-room';

    let receivedTrackTitle = '';
    let lateJoinerTrackTitle = '';

    const clientA = new SyncClient(serverUrl, ROOM, 'host_A');
    const clientB = new SyncClient(serverUrl, ROOM, 'peer_B', {
        onTrackSync: (track) => {
            receivedTrackTitle = track.title;
        }
    });

    await clientA.connect(WebSocket);
    await clientB.connect(WebSocket);

    clientA.broadcastTrack({
        jobId: '0123456789abcdef0123456789abcdef',
        title: 'anechoic_demo.wav',
        mode: 'service',
        stemUrls: {
            drums: '/api/stems/files/0123456789abcdef0123456789abcdef/drums.wav',
            bass: '/api/stems/files/0123456789abcdef0123456789abcdef/bass.wav',
            vocals: '/api/stems/files/0123456789abcdef0123456789abcdef/vocals.wav',
            other: '/api/stems/files/0123456789abcdef0123456789abcdef/other.wav'
        }
    });

    await new Promise(r => setTimeout(r, 60));
    assert.strictEqual(receivedTrackTitle, 'anechoic_demo.wav', 'Peer B did not receive SYNC_TRACK');

    // Late joiner should inherit the room's active track inside ROOM_STATE
    const clientC = new SyncClient(serverUrl, ROOM, 'late_C', {
        onRoomState: (state) => {
            lateJoinerTrackTitle = state.track?.title || '';
        }
    });
    await clientC.connect(WebSocket);
    await new Promise(r => setTimeout(r, 60));
    assert.strictEqual(lateJoinerTrackTitle, 'anechoic_demo.wav', 'Late joiner did not receive room track');

    console.log('PASSED (First-sample offset primed; SYNC_TRACK & late-joiner state verified)');

    clientA.disconnect();
    clientB.disconnect();
    clientC.disconnect();
    await server.stop();
}

async function runAllSyncTests() {
    console.log('\n===========================================================');
    console.log('  AuraStream Multi-Client Real-Time Sync Test Suite');
    console.log('===========================================================\n');

    await testClockSyncConvergence();
    testJitterBufferSplineContinuity();
    await testLiveMultiClientSync();
    await testTrackSyncAndEarlyClockOffset();

    console.log('\nAll Multi-Client Synchronization tests PASSED successfully!\n');
}

runAllSyncTests().catch(err => {
    console.error('FAILED with error:', err);
    process.exit(1);
});
