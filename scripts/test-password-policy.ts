// scripts/test-password-policy.ts — lib/passwordPolicy must accept exactly what
// Supabase Auth accepts. The live check that produced this rule:
// admin.updateUserById with 'abcdefg1' and 'Password1' → 422 weak_password;
// 'Passw0rd!x' → ok (2026-09-11, prod project).
//
// Run: npx tsx scripts/test-password-policy.ts

import { passwordError, isWeakPasswordError, PASSWORD_RULE } from '../lib/passwordPolicy';

let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `  (${detail})`}`);
  if (!ok) failed++;
}

check('accepts upper+lower+digit+symbol',         passwordError('Passw0rd!x') === null);
check('accepts a hyphen as the symbol',           passwordError('Authflow-pw-abc1A') === null);
check('rejects under 8 characters',               passwordError('Ab1!') !== null);
check('rejects the old rule (digit only)',        passwordError('abcdefg1') !== null);
check('rejects no symbol (Supabase 422 case)',    passwordError('Password1') !== null);
check('rejects no uppercase',                     passwordError('password1!') !== null);
check('rejects no lowercase',                     passwordError('PASSWORD1!') !== null);
check('rejects no digit',                         passwordError('Password!!') !== null);
check('the rule text names all four classes',
  /uppercase/.test(PASSWORD_RULE) && /lowercase/.test(PASSWORD_RULE) && /number/.test(PASSWORD_RULE) && /symbol/.test(PASSWORD_RULE));
check('recognises Supabase weak_password by code',    isWeakPasswordError({ code: 'weak_password', message: 'x' }));
check('recognises Supabase weak_password by message', isWeakPasswordError({ message: 'Password should contain at least one character of each: ...' }));
check('ignores other auth errors',                    !isWeakPasswordError({ code: 'otp_expired', message: 'Token has expired' }));

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
