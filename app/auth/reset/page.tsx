// /auth/reset — self-service password recovery, reachable signed out.
//
// The page never says whether an address has an account: the form shows the
// same confirmation either way (lib/passwordReset explains why). The link it
// emails lands on /auth/set-password, the same page an invitation uses.

import type { Metadata } from 'next';
import ResetRequestForm from './ResetRequestForm';

export const metadata: Metadata = {
  title:   'Reset your password · ExpertMatch',
  robots:  { index: false, follow: false },
};

export default function ResetPasswordPage() {
  return <ResetRequestForm />;
}
