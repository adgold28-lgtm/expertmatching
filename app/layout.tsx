import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ExpertMatch — AI-Powered Expert Sourcing',
  description: 'Turn any business question into a curated list of experts to interview.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
