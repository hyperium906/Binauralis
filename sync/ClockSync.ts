import { PingPacket, PongPacket } from './protocol';

export interface ClockSample {
    rtt: number;      // Round-Trip Time in ms
    offset: number;   // Server - Client offset in ms
    timestamp: number;
}

export interface ClockSyncOptions {
    sampleWindowSize?: number;  // History buffer size (default: 16)
    pingIntervalMs?: number;    // Heartbeat ping interval (default: 3000ms)
    minSamplesForSync?: number; // Minimum samples required before declaring sync (default: 4)
}

export class ClockSync {
    private offset: number = 0;              // Current estimated clock offset (ms)
    private minRtt: number = Infinity;       // Lowest recorded RTT
    private samples: ClockSample[] = [];
    private seq: number = 0;
    private isSync: boolean = false;

    private readonly windowSize: number;
    private readonly minSamples: number;
    private sendPingFn?: (packet: PingPacket) => void;
    private pingTimer: any = null;

    constructor(options: ClockSyncOptions = {}) {
        this.windowSize = options.sampleWindowSize || 16;
        this.minSamples = options.minSamplesForSync || 4;
    }

    /**
     * @brief Start automated NTP ping loop using a sender callback.
     */
    public start(sendPing: (packet: PingPacket) => void, intervalMs: number = 3000): void {
        this.sendPingFn = sendPing;

        // Perform initial rapid burst of 5 pings for immediate sub-second convergence
        for (let i = 0; i < 5; ++i) {
            setTimeout(() => this.sendPing(), i * 120);
        }

        // Periodic maintenance heartbeat
        this.pingTimer = setInterval(() => {
            this.sendPing();
        }, intervalMs);
    }

    public stop(): void {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    /**
     * @brief Construct and dispatch a PING packet.
     */
    public sendPing(): void {
        if (!this.sendPingFn) return;
        const now = this.now();
        const packet: PingPacket = {
            type: 'PING',
            clientTime: now,
            seq: ++this.seq
        };
        this.sendPingFn(packet);
    }

    /**
     * @brief Process incoming PONG response and update clock offset estimate.
     * Calculates RTT and offset using Cristian's NTP algorithm.
     */
    public handlePong(pong: PongPacket, receiveTime?: number): ClockSample | null {
        const t3 = receiveTime !== undefined ? receiveTime : this.now();
        const t0 = pong.clientTime;
        const tServer = pong.serverTime;

        const rtt = t3 - t0;
        if (rtt < 0) return null; // Clock anomaly

        // Offset = serverTime - (t0 + RTT / 2)
        const offset = tServer - (t0 + rtt / 2.0);

        const sample: ClockSample = {
            rtt,
            offset,
            timestamp: t3
        };

        this.samples.push(sample);
        if (this.samples.length > this.windowSize) {
            this.samples.shift();
        }

        this.recalculateOffset();
        return sample;
    }

    /**
     * @brief Recalculate clock offset using outlier rejection and low-RTT weighting.
     * Samples with lowest RTT experience least asymmetric queueing and are given highest weight.
     */
    private recalculateOffset(): void {
        if (this.samples.length === 0) return;

        // Sort samples by RTT
        const sorted = [...this.samples].sort((a, b) => a.rtt - b.rtt);
        this.minRtt = sorted[0].rtt;

        // Take the top 50% lowest-latency samples (outlier rejection)
        const bestCount = Math.max(1, Math.floor(sorted.length * 0.5));
        const bestSamples = sorted.slice(0, bestCount);

        // Weighted average favoring minimum RTT
        let totalWeight = 0;
        let weightedOffsetSum = 0;

        for (const s of bestSamples) {
            // Weight inversely proportional to RTT: w = 1 / (rtt + 1.0)
            const w = 1.0 / (s.rtt + 1.0);
            weightedOffsetSum += s.offset * w;
            totalWeight += w;
        }

        const newOffset = weightedOffsetSum / totalWeight;

        if (!this.isSync && this.samples.length >= this.minSamples) {
            this.offset = newOffset;
            this.isSync = true;
        } else if (this.isSync) {
            // Exponential moving average filter for smooth jitter-free adjustment
            const alpha = 0.25;
            this.offset = alpha * newOffset + (1.0 - alpha) * this.offset;
        }
    }

    /**
     * @brief Returns current estimated server time in milliseconds.
     */
    public getServerTime(): number {
        return this.now() + this.offset;
    }

    /**
     * @brief Convert local timestamp to server timestamp.
     */
    public toServerTime(localTimeMs: number): number {
        return localTimeMs + this.offset;
    }

    /**
     * @brief Convert server timestamp to local timestamp.
     */
    public toLocalTime(serverTimeMs: number): number {
        return serverTimeMs - this.offset;
    }

    public getOffset(): number {
        return this.offset;
    }

    public getMinRtt(): number {
        return this.minRtt === Infinity ? 0 : this.minRtt;
    }

    public isSynchronized(): boolean {
        return this.isSync;
    }

    /**
     * High-resolution local epoch timestamp in milliseconds.
     */
    private now(): number {
        return typeof performance !== 'undefined' ? performance.now() : Date.now();
    }
}
