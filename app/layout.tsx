import Navigation from 'components/layout/Navigation';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Providers from './providers';
import './globals.css';

export const metadata: Metadata = {
  // The base every relative metadata URL resolves against, which is what makes the OG image an absolute
  // URL in the emitted tags. Scrapers refuse relative ones.
  metadataBase: new URL('https://worth.cash'),
  title: 'Worth.cash',
  description:
    'What your crypto is worth, wherever it is. Self-hosted and multichain, and all data stays in your browser.',
  openGraph: {
    title: 'Worth.cash',
    description: 'What your crypto is worth, wherever it is.',
    url: '/',
    siteName: 'Worth.cash',
    type: 'website',
  },
  // The image itself comes from the app/opengraph-image.png file convention; this only picks the large
  // card so the unfurl shows it full-width rather than as a thumbnail.
  twitter: {
    card: 'summary_large_image',
  },
};

// Applies the saved theme before first paint. Doing this in an effect instead would show a flash of the
// wrong theme on every page load.
const THEME_BOOT_SCRIPT = `
try {
  var stored = localStorage.getItem('portfolio-tracker-theme');
  var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (stored === 'dark' || (!stored && prefersDark)) document.documentElement.classList.add('dark');
} catch (error) {}
`;

const RootLayout = ({ children }: { children: ReactNode }) => (
  <html lang="en" suppressHydrationWarning>
    <head>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a static string that must run before paint */}
      <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
    </head>
    <body className="min-h-screen">
      <Providers>
        <Navigation />
        <main className="max-w-6xl mx-auto px-4 py-6">{children}</main>
      </Providers>
    </body>
  </html>
);

export default RootLayout;
