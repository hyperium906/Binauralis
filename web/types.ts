/**
 * AuraStream Web Audio Engine - TypeScript Definitions
 */

export type StemName = 'drums' | 'bass' | 'vocals' | 'other';

export const STEM_NAMES: readonly StemName[] = ['drums', 'bass', 'vocals', 'other'] as const;

export const STEM_INDEX_MAP: Record<StemName, number> = {
    drums: 0,
    bass: 1,
    vocals: 2,
    other: 3
};

export interface Position3D {
    x: number; // +X = Right, -X = Left
    y: number; // +Y = Forward, -Y = Behind
    z: number; // +Z = Up, -Z = Down
}

export interface MasterLoudnessMetrics {
    rmsDbfs: number;
    peakDbfs: number;
    sampleRate: number;
    isClipping: boolean;
}

export interface HRIRTableData {
    leftHrir: Float32Array;
    rightHrir: Float32Array;
    numPositions: number;
    filterLen: number;
}

export type WorkletInboundMessage =
    | {
          type: 'INIT_WASM';
          wasmModule: WebAssembly.Module;
          hrirData?: HRIRTableData;
          sampleRate: number;
      }
    | {
          type: 'SET_POSITION';
          sourceId: number;
          stemName: StemName;
          x: number;
          y: number;
          z: number;
      }
    | {
          type: 'RESET_SOURCE';
          sourceId: number;
      };

export type WorkletOutboundMessage =
    | { type: 'ENGINE_INITIALIZED'; sampleRate: number; blockSize: number }
    | { type: 'ENGINE_ERROR'; error: string };
