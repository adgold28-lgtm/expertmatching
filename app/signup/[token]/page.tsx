import { redirect } from 'next/navigation';

export default function SignupPage({ params }: { params: { token: string } }) {
  redirect(`/auth/set-password?token=${encodeURIComponent(params.token ?? '')}`);
}
