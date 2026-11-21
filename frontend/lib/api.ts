import type { StemName } from '../hooks/useSpatialSession';

export const DEFAULT_API_URL =
    process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export const DEFAULT_SYNC_URL =
    process.env.NEXT_PUBLIC_SYNC_URL || 'ws://localhost:8080';

export interface ServiceHealth {
    online: boolean;
    device?: string;
    version?: string;
    sampleRate?: number;
}

export interface TrackLoudnessReport {
    filename: string;
    integrated_loudness_lufs: number;
    loudness_range_lu: number;
    true_peak_dbfs: number;
    sample_rate: number;
    channels: number;
    duration_seconds: number;
    is_spotify_compliant: boolean;
    is_ebu_r128_compliant: boolean;
}

export interface StemFileDetail {
    name: StemName;
    file_path: string;
    url?: string;
    sample_rate: number;
    duration_seconds: number;
    sample_count: number;
    file_size_bytes: number;
}

export interface StemExtractionStatus {
    job_id: string;
    status: 'queued' | 'processing' | 'completed' | 'failed';
    progress: number;
    created_at: string;
    updated_at: string;
    filename?: string;
    separation_engine?: string;
    session_dir?: string;
    stems?: Record<StemName, string>;
    stem_urls?: Record<StemName, string>;
    stem_details?: Record<StemName, StemFileDetail>;
    loudness?: TrackLoudnessReport | null;
    error_message?: string | null;
}

export interface SessionSummary {
    job_id: string;
    filename: string;
    created_at: string;
    duration_seconds: number;
    sample_rate: number;
    separation_engine?: string | null;
    stem_urls: Record<StemName, string>;
    loudness?: TrackLoudnessReport | null;
}

function normalizeBase(url: string): string {
    return url.replace(/\/+$/, '');
}

export function resolveStemUrl(stemPathOrUrl: string, apiBase: string = DEFAULT_API_URL): string {
    if (/^https?:\/\//i.test(stemPathOrUrl)) {
        return stemPathOrUrl;
    }
    return `${normalizeBase(apiBase)}${stemPathOrUrl.startsWith('/') ? '' : '/'}${stemPathOrUrl}`;
}

export function resolveStemUrls(
    stemUrls: Record<StemName, string>,
    apiBase: string = DEFAULT_API_URL
): Record<StemName, string> {
    return {
        drums: resolveStemUrl(stemUrls.drums, apiBase),
        bass: resolveStemUrl(stemUrls.bass, apiBase),
        vocals: resolveStemUrl(stemUrls.vocals, apiBase),
        other: resolveStemUrl(stemUrls.other, apiBase)
    };
}

export async function checkServiceHealth(apiBase: string = DEFAULT_API_URL): Promise<ServiceHealth> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 2500);
    try {
        const res = await fetch(`${normalizeBase(apiBase)}/health`, {
            signal: controller.signal,
            cache: 'no-store'
        });
        if (!res.ok) return { online: false };
        const data = await res.json();
        return {
            online: data.status === 'healthy',
            device: data.device,
            version: data.version,
            sampleRate: data.sample_rate
        };
    } catch {
        return { online: false };
    } finally {
        window.clearTimeout(timer);
    }
}

export async function listSessions(apiBase: string = DEFAULT_API_URL): Promise<SessionSummary[]> {
    try {
        const res = await fetch(`${normalizeBase(apiBase)}/api/stems/sessions`, {
            cache: 'no-store'
        });
        if (!res.ok) return [];
        const data = await res.json();
        return Array.isArray(data.sessions) ? data.sessions : [];
    } catch {
        return [];
    }
}

export function uploadTrackForSeparation(
    file: File,
    apiBase: string = DEFAULT_API_URL,
    onUploadProgress?: (pct: number) => void
): Promise<{ job_id: string; status: string; message: string }> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${normalizeBase(apiBase)}/api/stems/extract`);

        xhr.upload.onprogress = (evt) => {
            if (evt.lengthComputable && onUploadProgress) {
                onUploadProgress(Math.round((evt.loaded / evt.total) * 100));
            }
        };

        xhr.onload = () => {
            try {
                const payload = JSON.parse(xhr.responseText || '{}');
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(payload);
                } else {
                    reject(new Error(payload.detail || `Upload failed (HTTP ${xhr.status})`));
                }
            } catch {
                reject(new Error(`Unexpected response from stem service (HTTP ${xhr.status})`));
            }
        };

        xhr.onerror = () => {
            reject(new Error(`Cannot reach FastAPI stem service at ${apiBase}`));
        };

        const form = new FormData();
        form.append('file', file);
        xhr.send(form);
    });
}

export async function pollStemStatus(
    jobId: string,
    apiBase: string = DEFAULT_API_URL
): Promise<StemExtractionStatus> {
    const res = await fetch(`${normalizeBase(apiBase)}/api/stems/status/${encodeURIComponent(jobId)}`, {
        cache: 'no-store'
    });
    if (!res.ok) {
        const detail = await res.text();
        throw new Error(detail || `Status request failed (HTTP ${res.status})`);
    }
    return res.json();
}
