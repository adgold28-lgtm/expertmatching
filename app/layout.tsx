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

// COPY_AUDIT 1.1 / 1.2 / 11.8. metadataBase resolves any relative metadata URL,
// and the openGraph/twitter blocks give every page a real link card when the URL
// is pasted into a Slack or an email — which is how an invite-only product
// spreads. app/icon.svg is the favicon Next serves for every route; the icons
// entry below points at that same file so the tag is present even when a client
// ignores the file-based convention. Still missing: an OG image.
const SITE_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://expertmatch.fit';
const SITE_TITLE = "ExpertMatch — Talk to the operators who've done it";
const SITE_DESCRIPTION =
  'Find the right industry expert and be on a call with them this week. We handle outreach, scheduling, and billing.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  openGraph: {
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    siteName: 'ExpertMatch',
    url: SITE_URL,
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml' }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${spectral.variable} ${libreFranklin.variable}`}>
      <body className="font-body antialiased">{children}</body>
    </html>
  );
}
