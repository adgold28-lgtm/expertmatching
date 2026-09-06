import type { Metadata } from 'next';

// app/login/page.tsx is a client component, so it cannot export `metadata`
// itself. This segment layout supplies the title/description the tab needs
// (COPY_AUDIT 4.1) without turning the form into a server component.

export const metadata: Metadata = {
  title: 'Sign in — ExpertMatch',
  description: 'Sign in to your ExpertMatch account.',
  robots: { index: false, follow: false },
};

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
