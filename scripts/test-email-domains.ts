// scripts/test-email-domains.ts — a public email domain is never an organization.
//
//   npx tsx scripts/test-email-domains.ts
//
// No network. lib/emailDomains.ts is the list the registration fix rests on:
// gmail.com being an organization once made every Gmail address an
// auto-approved colleague of the platform admin.

import { isPublicEmailDomain, impliedOrgDomainFor, emailDomainOf, normalizeEmailDomain } from '../lib/emailDomains';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

for (const d of ['gmail.com', 'GMAIL.COM', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
                 'yahoo.com', 'yahoo.co.uk', 'icloud.com', 'me.com', 'aol.com', 'protonmail.com',
                 'proton.me', 'pm.me', 'gmx.de', 'mail.com', 'yandex.ru', 'qq.com', 'comcast.net',
                 'btinternet.com', 'mailinator.com', 'example.com', 'mail.gmail.com']) {
  check(`${d} is public`, isPublicEmailDomain(d));
}

for (const d of ['blackstone.com', 'kkr.com', 'colby.edu', 'expertmatch.fit', 'trial-ab12cd.expertmatch.fit',
                 'bain.com', 'mckinsey.com', 'a16z.com']) {
  check(`${d} is NOT public`, !isPublicEmailDomain(d));
}

check('empty domain counts as public (never an org)', isPublicEmailDomain(''));
check('normalizes @ and www.', normalizeEmailDomain('@WWW.Gmail.com') === 'gmail.com');
check('emailDomainOf', emailDomainOf('Jane.Doe@Blackstone.com') === 'blackstone.com');
check('emailDomainOf with no @', emailDomainOf('nope') === '');
check('impliedOrgDomainFor a work address', impliedOrgDomainFor('jane@blackstone.com') === 'blackstone.com');
check('impliedOrgDomainFor a gmail address is null', impliedOrgDomainFor('jane@gmail.com') === null);
check('impliedOrgDomainFor an outlook address is null', impliedOrgDomainFor('jane@outlook.com') === null);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
