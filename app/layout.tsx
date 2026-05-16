import type { Metadata } from 'next';
import { Spectral, Libre_Franklin } from 'next/font/google';
import './globals.css';

const spectral = Spectral({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700', '800'],
  style: ['normal', 'italic'],
  variable: '--font-spectral',
  display: 'swap',
});

const libreFranklin = Libre_Franklin({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600'],
  variable: '--font-libre-franklin',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'ExpertMatch — Expert Intelligence Platform',
  description: "Surface the practitioners, advisors, and outliers who've been there.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${spectral.variable} ${libreFranklin.variable}`}>
      <body className="font-body antialiased">{children}</body>
    </html>
  );
}
