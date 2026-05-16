# ExpertMatch Task Queue
Last updated: May 2026

## NOW (blocking or broken)
- [x] Auth overhaul: firm-based seats, invite-only flow, remove master password
      — firmStore.ts, set-password flow, admin panel rebuilt (May 2026)
- [x] Navigation flow: middleware redirects / and /login → /app for authenticated users
- [x] Landing page nav: "Open ExpertMatch" (gold) + Welcome [Name] + Sign Out when signed in
- [x] Post-login redirect: always lands on /app (login page default)
- [x] Welcome name: firstName stored on UserRecord, included in session payload,
      NavBar uses it when present — falls back to email-derived name
- [x] Onboarding flow: /onboarding stepper (calendar → billing → profile),
      middleware gates incomplete users, session refreshed with onboardingComplete:true
      NOTE: calendar (OAuth) and billing (Stripe) steps are stubs — see TODOs in route files
- [x] Access request notification bug: fixed admin email (ADMIN_NOTIFICATION_EMAIL env var),
      errors now logged instead of silently swallowed
- [x] Simplified research brief: two optional textareas (business problem + expert type),
      name auto-derived from brief text, outreach mode toggle (review/auto)
- [x] Outreach mode: outreachMode field on Project ('review' default, 'auto' sends immediately)
- [x] Rate configuration: clientRate + expertRate (clientRate * 0.70), seniority-based
      rate suggestions on expert card, default range $150–$500/hr
- [x] Request access form: removed "what are you researching" field,
      headline changed to "Find the expert you're looking for"
- [x] Exa AI integration: exa-js installed, ExaProvider added as primary search provider
      (SEARCH_PROVIDER=exa or auto-selected when EXA_API_KEY is set)

## NEXT (makes the product real)
- [ ] Calendar OAuth integration (Google + Outlook) — stubs exist in /api/onboarding/calendar
- [ ] Stripe billing integration — stubs exist in /api/onboarding/billing
- [ ] Per-minute time tracking — Zoom webhook stores actualDurationMin, billing route computes invoice
- [ ] Expert sourcing pipeline improvements
- [ ] Outreach generation with tone controls (formal → casual slider)
- [ ] Reply tracking: per-expert status 
      (Outreach Sent → Replied Yes → Scheduled → Completed → Billed)
- [ ] Shareable shortlist link (expertmatch.fit/brief/xyz) viewable without login
- [ ] Outreach mode enforcement: when outreachMode='review', show outreach queue for approval;
      when 'auto', send immediately after generation

## LATER (makes the product great)
- [ ] Firm-level rate guardrails (minRate/maxRate) — AI cannot exceed range without flagging
- [ ] Expert compensation tracking via Stripe Connect
- [ ] Project templates (PE firms, law firms, consulting)
- [ ] Audit trail on expert scoring — show evidence per expert
- [ ] Admin analytics dashboard
- [ ] Recent projects dropdown in nav on hover
