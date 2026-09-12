import type { Metadata, Viewport } from 'next';
import './globals.css';

export const viewport: Viewport = {
    themeColor: '#06080B',
    width: 'device-width',
    initialScale: 1
};

export const metadata: Metadata = {
    metadataBase: new URL('http://localhost:3000'),
    title: 'AuraStream — Spatial monitor',
    description:
        'Place four stems around a listener and hear them binaurally in real time. C++ convolution engine compiled to WebAssembly, 512-tap HRIR filters, 128-sample blocks.',
    icons: {
        icon: [
            { url: '/favicon.ico', sizes: 'any' },
            { url: '/favicon.svg', type: 'image/svg+xml' },
            { url: '/favicon-32x32.png', type: 'image/png', sizes: '32x32' },
            { url: '/favicon-16x16.png', type: 'image/png', sizes: '16x16' }
        ],
        apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
        shortcut: '/favicon.ico'
    },
    openGraph: {
        title: 'AuraStream — Spatial monitor',
        description: 'Place four stems around a listener and hear them binaurally in real time.',
        images: [{ url: '/social_card.png', width: 1200, height: 630, alt: 'AuraStream — spatial monitor' }]
    }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en">
            <head>
                <link rel="preconnect" href="https://fonts.googleapis.com" />
                <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
                <link
                    href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=Azeret+Mono:wght@400;500;600&display=swap"
                    rel="stylesheet"
                />
            </head>
            <body>{children}</body>
        </html>
    );
}
