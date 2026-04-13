import type { Metadata } from 'next';
import { Cormorant_Garamond, Libre_Franklin } from 'next/font/google';
import './globals.css';

const cormorant = Cormorant_Garamond({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  style: ['normal', 'italic'],
  variable: '--font-cormorant',
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
    <html lang="en" className={`${cormorant.variable} ${libreFranklin.variable}`}>
      <body className="font-body antialiased">{children}</body>
    </html>
  );
}
