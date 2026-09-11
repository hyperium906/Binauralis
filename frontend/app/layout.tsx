import type { Metadata, Viewport } from 'next';
import './globals.css';

export const viewport: Viewport = {
    themeColor: '#050811',
    width: 'device-width',
    initialScale: 1,
};

export const metadata: Metadata = {
    metadataBase: new URL('http://localhost:3000'),
    title: 'AuraStream // 3D Spatial Audio Workstation',
    description: 'Dolby-grade 3D real-time binaural spatial audio workstation with zero-allocation C++ DSP, Demucs stem separation, and sub-50ms distributed sync.',
    icons: {
        icon: [
            { url: '/favicon.ico', sizes: 'any' },
            { url: '/favicon.svg', type: 'image/svg+xml' },
            { url: '/favicon-32x32.png', type: 'image/png', sizes: '32x32' },
            { url: '/favicon-16x16.png', type: 'image/png', sizes: '16x16' }
        ],
        apple: [
            { url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }
        ],
        shortcut: '/favicon.ico'
    },
    openGraph: {
        title: 'AuraStream // 3D Spatial Audio Workstation',
        description: 'Dolby-grade 3D real-time binaural spatial audio workstation with interactive canvas and loudness telemetry.',
        images: [
            {
                url: '/soundstage_hero.jpg',
                width: 1200,
                height: 630,
                alt: 'AuraStream 3D Spatial Audio Soundstage'
            }
        ]
    }
};

export default function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html lang="en">
            <head>
                <link rel="preconnect" href="https://fonts.googleapis.com" />
                <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
                <link
                    href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Outfit:wght@300;400;500;600;700&display=swap"
                    rel="stylesheet"
                />
            </head>
            <body>{children}</body>
        </html>
    );
}
