import { Fraunces, IBM_Plex_Mono, IBM_Plex_Sans, Inter } from 'next/font/google';

/**
 * Brand typefaces (docs/brand-bible.md). Light (Ledger): Fraunces display,
 * Inter text. Dark (Midnight): IBM Plex Sans with Plex Mono figures. Each
 * exposes a CSS variable that globals.css maps onto --font-sans/--font-display/--font-mono.
 */
export const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
export const fraunces = Fraunces({ subsets: ['latin'], variable: '--font-fraunces', display: 'swap', axes: ['opsz', 'SOFT'] });
export const plexSans = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-plex-sans', display: 'swap' });
export const plexMono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-plex-mono', display: 'swap' });

export const fontVariables = [inter, fraunces, plexSans, plexMono].map((f) => f.variable).join(' ');
