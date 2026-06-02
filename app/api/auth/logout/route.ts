import { COOKIE_NAME } from '../../../../lib/auth';

export async function POST(): Promise<Response> {
  const isProduction = process.env.NODE_ENV === 'production';

  const setCookie = [
    `${COOKIE_NAME}=`,
    'HttpOnly',
    'Max-Age=0',
    'Path=/',
    'SameSite=Lax',
    ...(isProduction ? ['Secure'] : []),
  ].join('; ');

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': setCookie,
    },
  });
}
