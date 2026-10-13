// lib/supabase/database.types.ts
//
// Hand-authored types for the Supabase schema created in
//   supabase/migrations/20260831000000_supabase_cutover_foundation.sql
//   supabase/migrations/20260901000000_onboarding_billing_calendar.sql
//   supabase/migrations/20260902000000_org_billing_and_rls_hardening.sql
//   supabase/migrations/20260906000000_outreach_suppressions.sql
//   supabase/migrations/20260907000000_matchy_phase1.sql
//   supabase/migrations/20260907100000_availability_windows_and_indexes.sql
//   supabase/migrations/20260907300000_matchy_phase2_events.sql
//   supabase/migrations/20260908000000_identity_boundary_trial_events.sql
//   supabase/migrations/20260909000000_cron_scan_indexes.sql (indexes only)
//   supabase/migrations/20260910000000_call_cancelled_event.sql
//   supabase/migrations/20260914000000_screening_requests.sql
//
// EVERY table belongs here, including the service-role-only ones. This file is
// the only compile-time check on column names in a codebase that otherwise
// talks to Postgres through strings, so a table described by an ad-hoc inline
// type somewhere else is a table nothing checks (audit M-10).
//
// Keep this file in sync with those migrations. (Once the Supabase CLI is
// wired up you can regenerate with: `supabase gen types typescript --linked`.)
//
// Access model reminder:
//   org-scoped     -> organizations, profiles, organization_members,
//                     access_requests
//   project-scoped -> projects, project_members, project_experts
//   service-role   -> access_requests, user_calendar_connections,
//                     outreach_suppressions, engagement_events,
//                     organization_billing, system_events, product_events,
//                     requests, objectives, screening_tokens,
//                     screening_responses, call_outcomes
//   project-read   -> conversation_messages (members read; writes service-role)
// Project data is reachable only via project ownership or an explicit
// project_members row — never org-wide.
//
// The five screening-flow tables (20260914000000) are service-role only with
// ZERO policies: access is owner-or-platform-admin, decided in
// lib/requestStore.ts, and the expert's name, address and expert-side ask are
// dropped by the route before a client sees a respondent. RLS grants nobody
// anything on them, so nothing here is reachable from a browser session.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

/**
 * organizations.firm_type / access_requests.firm_type — the check-constrained
 * values from 20260907000000_matchy_phase1.sql. lib/matchyTemplates.ts maps
 * these to the one type word Matchy says to an expert.
 */
export type FirmTypeValue =
  | 'pe_firm'
  | 'family_office'
  | 'consulting_firm'
  | 'law_firm'
  | 'hedge_fund'
  | 'corporate'
  | 'other';

/** organizations.firm_size / access_requests.firm_size — the size word. */
export type FirmSizeValue = 'boutique' | 'mid_size' | 'large';

/** engagement_events.type — every Matchy action or observation worth keeping. */
export type EngagementEventType =
  | 'bookmarked'
  | 'contact_found'
  | 'contact_not_found'
  | 'intro_sent'
  | 'reply_received'
  | 'intent_classified'
  | 'rate_offered'
  | 'rate_countered'
  | 'rate_agreed'
  | 'conflict_flagged'
  | 'times_proposed'
  | 'scheduled'
  | 'completed'
  | 'charged'
  | 'rejected'
  | 'client_ready'
  // Matchy Phase 2 (supabase/migrations/20260907300000_matchy_phase2_events.sql)
  | 'nudge_sent'
  | 'rescheduled'
  | 'time_declined'
  // Wave 5 (supabase/migrations/20260910000000_call_cancelled_event.sql)
  | 'call_cancelled'
  | 'no_show';

export interface Database {
  public: {
    Tables: {
      organizations: {
        Row: {
          id: string;
          name: string;
          domain: string | null;
          plan: 'starter' | 'growth' | 'enterprise';
          seat_limit: number;
          status: 'active' | 'disabled';
          // How Matchy names this client to an expert without identifying it.
          firm_type: FirmTypeValue | null;
          firm_size: FirmSizeValue | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          domain?: string | null;
          plan?: 'starter' | 'growth' | 'enterprise';
          seat_limit?: number;
          status?: 'active' | 'disabled';
          firm_type?: FirmTypeValue | null;
          firm_size?: FirmSizeValue | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          domain?: string | null;
          plan?: 'starter' | 'growth' | 'enterprise';
          seat_limit?: number;
          status?: 'active' | 'disabled';
          firm_type?: FirmTypeValue | null;
          firm_size?: FirmSizeValue | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          id: string;
          email: string;
          first_name: string | null;
          last_name: string | null;
          full_name: string | null;
          title: string | null;
          onboarding_complete: boolean;
          is_platform_admin: boolean;
          stripe_customer_id: string | null;
          billing_complete: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          email: string;
          first_name?: string | null;
          last_name?: string | null;
          full_name?: string | null;
          title?: string | null;
          onboarding_complete?: boolean;
          is_platform_admin?: boolean;
          stripe_customer_id?: string | null;
          billing_complete?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          email?: string;
          first_name?: string | null;
          last_name?: string | null;
          full_name?: string | null;
          title?: string | null;
          onboarding_complete?: boolean;
          is_platform_admin?: boolean;
          stripe_customer_id?: string | null;
          billing_complete?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      organization_members: {
        Row: {
          id: string;
          organization_id: string;
          profile_id: string;
          role: 'org_admin' | 'org_member';
          status: 'pending' | 'active' | 'disabled';
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          profile_id: string;
          role?: 'org_admin' | 'org_member';
          status?: 'pending' | 'active' | 'disabled';
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          profile_id?: string;
          role?: 'org_admin' | 'org_member';
          status?: 'pending' | 'active' | 'disabled';
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      access_requests: {
        Row: {
          id: string;
          kind: 'access' | 'seat';
          email: string;
          requested_domain: string | null;
          name: string | null;
          firm_name: string | null;
          use_case: string | null;
          // Captured on the public form; copied onto the organization at approval.
          firm_type: FirmTypeValue | null;
          firm_size: FirmSizeValue | null;
          organization_id: string | null;
          status: 'requested' | 'approved' | 'rejected';
          reviewed_by: string | null;
          reviewed_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          kind?: 'access' | 'seat';
          email: string;
          requested_domain?: string | null;
          name?: string | null;
          firm_name?: string | null;
          use_case?: string | null;
          firm_type?: FirmTypeValue | null;
          firm_size?: FirmSizeValue | null;
          organization_id?: string | null;
          status?: 'requested' | 'approved' | 'rejected';
          reviewed_by?: string | null;
          reviewed_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          kind?: 'access' | 'seat';
          email?: string;
          requested_domain?: string | null;
          name?: string | null;
          firm_name?: string | null;
          use_case?: string | null;
          firm_type?: FirmTypeValue | null;
          firm_size?: FirmSizeValue | null;
          organization_id?: string | null;
          status?: 'requested' | 'approved' | 'rejected';
          reviewed_by?: string | null;
          reviewed_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      projects: {
        Row: {
          id: string;
          organization_id: string;
          owner_id: string;
          name: string;
          research_question: string;
          status: 'active' | 'archived';
          brief: Json;
          // Matchy: per-project send switch and the CLIENT-side rate band.
          review_first: boolean;
          client_rate_min: number | null;
          client_rate_max: number | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          owner_id: string;
          name: string;
          research_question?: string;
          status?: 'active' | 'archived';
          brief?: Json;
          review_first?: boolean;
          client_rate_min?: number | null;
          client_rate_max?: number | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          owner_id?: string;
          name?: string;
          research_question?: string;
          status?: 'active' | 'archived';
          brief?: Json;
          review_first?: boolean;
          client_rate_min?: number | null;
          client_rate_max?: number | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      project_members: {
        Row: {
          id: string;
          project_id: string;
          profile_id: string;
          role: 'owner' | 'collaborator' | 'viewer';
          created_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          profile_id: string;
          role?: 'owner' | 'collaborator' | 'viewer';
          created_at?: string;
        };
        Update: {
          id?: string;
          project_id?: string;
          profile_id?: string;
          role?: 'owner' | 'collaborator' | 'viewer';
          created_at?: string;
        };
        Relationships: [];
      };
      project_experts: {
        Row: {
          id: string;
          project_id: string;
          expert_id: string;
          status: string;
          contact_email: string | null;
          data: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          expert_id: string;
          status?: string;
          contact_email?: string | null;
          data?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          project_id?: string;
          expert_id?: string;
          status?: string;
          contact_email?: string | null;
          data?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      // Service-role only (RLS enabled, no authenticated policies).
      // access_token / refresh_token hold AES-256-GCM ciphertext.
      user_calendar_connections: {
        Row: {
          profile_id: string;
          provider: 'google' | 'calendly' | 'manual';
          access_token: string | null;
          refresh_token: string | null;
          token_expiry: number | null;
          calendar_email: string | null;
          calendly_url: string | null;
          manual_slots: Json | null;
          // Recurring availability, added by 20260907100000: an array of
          // { dayOfWeek, from, to, timezone } — see lib/availabilityWindows.ts.
          weekly_windows: Json | null;
          timezone: string | null;
          oauth_state: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          profile_id: string;
          provider: 'google' | 'calendly' | 'manual';
          access_token?: string | null;
          refresh_token?: string | null;
          token_expiry?: number | null;
          calendar_email?: string | null;
          calendly_url?: string | null;
          manual_slots?: Json | null;
          weekly_windows?: Json | null;
          timezone?: string | null;
          oauth_state?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          profile_id?: string;
          provider?: 'google' | 'calendly' | 'manual';
          access_token?: string | null;
          refresh_token?: string | null;
          token_expiry?: number | null;
          calendar_email?: string | null;
          calendly_url?: string | null;
          manual_slots?: Json | null;
          weekly_windows?: Json | null;
          timezone?: string | null;
          oauth_state?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      // Service-role only (RLS enabled, no authenticated policies).
      // Global do-not-contact list; email is normalized lowercase.
      outreach_suppressions: {
        Row: {
          email: string;
          reason: 'opt_out' | 'declined' | 'manual';
          source_project_id: string | null;
          created_at: string;
        };
        Insert: {
          email: string;
          reason: 'opt_out' | 'declined' | 'manual';
          source_project_id?: string | null;
          created_at?: string;
        };
        Update: {
          email?: string;
          reason?: 'opt_out' | 'declined' | 'manual';
          source_project_id?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      // The ORGANIZATION is the paying entity: its Stripe customer, the
      // per-seat subscription, and whether a default card is on file.
      organization_billing: {
        Row: {
          organization_id: string;
          stripe_customer_id: string | null;
          stripe_subscription_id: string | null;
          stripe_subscription_item_id: string | null;
          billing_complete: boolean;
          subscription_status: string | null;
          seat_quantity_synced: number;
          billing_email: string | null;
          set_up_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          organization_id: string;
          stripe_customer_id?: string | null;
          stripe_subscription_id?: string | null;
          stripe_subscription_item_id?: string | null;
          billing_complete?: boolean;
          subscription_status?: string | null;
          seat_quantity_synced?: number;
          billing_email?: string | null;
          set_up_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          organization_id?: string;
          stripe_customer_id?: string | null;
          stripe_subscription_id?: string | null;
          stripe_subscription_item_id?: string | null;
          billing_complete?: boolean;
          subscription_status?: string | null;
          seat_quantity_synced?: number;
          billing_email?: string | null;
          set_up_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      // Project members READ via has_project_access; every write is
      // service-role only. body_raw holds AES-256-GCM ciphertext (see
      // lib/encryption.ts) — never plaintext.
      conversation_messages: {
        Row: {
          id: string;
          project_id: string;
          expert_id: string;
          direction: 'inbound' | 'outbound';
          author: 'client' | 'expert' | 'matchy';
          body_raw: string | null;
          body_clean: string | null;
          summary: string | null;
          intent: string | null;
          screen_result: Json | null;
          resend_message_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          expert_id: string;
          direction: 'inbound' | 'outbound';
          author: 'client' | 'expert' | 'matchy';
          body_raw?: string | null;
          body_clean?: string | null;
          summary?: string | null;
          intent?: string | null;
          screen_result?: Json | null;
          resend_message_id?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          project_id?: string;
          expert_id?: string;
          direction?: 'inbound' | 'outbound';
          author?: 'client' | 'expert' | 'matchy';
          body_raw?: string | null;
          body_clean?: string | null;
          summary?: string | null;
          intent?: string | null;
          screen_result?: Json | null;
          resend_message_id?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      // Service-role only (RLS enabled, no authenticated policies).
      // payload carries numbers, booleans and short enum strings — never PII.
      engagement_events: {
        Row: {
          id: string;
          project_id: string;
          expert_id: string;
          org_id: string | null;
          type: EngagementEventType;
          payload: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          expert_id: string;
          org_id?: string | null;
          type: EngagementEventType;
          payload?: Json;
          created_at?: string;
        };
        Update: {
          id?: string;
          project_id?: string;
          expert_id?: string;
          org_id?: string | null;
          type?: EngagementEventType;
          payload?: Json;
          created_at?: string;
        };
        Relationships: [];
      };
      // Operational failures the request path deliberately swallowed — seat
      // syncs, payouts, mail, sourcing, invoices, nudges. Service-role only
      // (RLS enabled, no policies). Written by
      // lib/engagementEvents.recordSystemFailure, read by lib/attention.ts.
      // `kind` and `area` are free-form text on purpose: a new area must never
      // be able to turn a swallowed failure into a second failure at insert
      // time. See 20260907100000_availability_windows_and_indexes.sql.
      system_events: {
        Row: {
          id: string;
          kind: string;
          area: string;
          reason: string;
          organization_id: string | null;
          project_id: string | null;
          expert_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          kind: string;
          area: string;
          reason: string;
          organization_id?: string | null;
          project_id?: string | null;
          expert_id?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          kind?: string;
          area?: string;
          reason?: string;
          organization_id?: string | null;
          project_id?: string | null;
          expert_id?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      // What people DO in the product — the trial/usage funnel. Service-role
      // only (RLS enabled, no policies). See lib/productEvents.ts and
      // supabase/migrations/20260908000000_identity_boundary_trial_events.sql.
      product_events: {
        Row: {
          id: string;
          actor_id: string | null;
          organization_id: string | null;
          project_id: string | null;
          type: string;
          payload: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          actor_id?: string | null;
          organization_id?: string | null;
          project_id?: string | null;
          type: string;
          payload?: Json;
          created_at?: string;
        };
        Update: {
          id?: string;
          actor_id?: string | null;
          organization_id?: string | null;
          project_id?: string | null;
          type?: string;
          payload?: Json;
          created_at?: string;
        };
        Relationships: [];
      };

      // ── Structured Request & Screening Flow ──────────────────────────────
      // supabase/migrations/20260914000000_screening_requests.sql. All five
      // tables: RLS enabled, ZERO policies — service-role only. Read and
      // written through lib/requestStore.ts; access is owner-or-admin, decided
      // in application code, because RLS grants nobody anything here.

      // A brief with 3-6 learning objectives. `deadline` has NO database
      // default: the app sets it (now + 14 days) so a row can never carry an
      // expiry nobody chose, which is why it is required on Insert.
      // `client_rate` is CLIENT-side dollars per hour on the $50 grid.
      expert_requests: {
        Row: {
          id: string;
          organization_id: string;
          owner_id: string;
          status: 'draft' | 'approved' | 'closed';
          topic_statement: string;
          /** ScreeningTargeting (types.ts) — staff-facing, never shown to an expert. */
          targeting: Json;
          call_count: number;
          deadline: string;
          client_rate: number;
          call_length_min: number;
          approved_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          owner_id: string;
          status?: 'draft' | 'approved' | 'closed';
          topic_statement: string;
          targeting?: Json;
          call_count?: number;
          deadline: string;
          client_rate: number;
          call_length_min?: number;
          approved_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          owner_id?: string;
          status?: 'draft' | 'approved' | 'closed';
          topic_statement?: string;
          targeting?: Json;
          call_count?: number;
          deadline?: string;
          client_rate?: number;
          call_length_min?: number;
          approved_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      // One learning objective in the client's words, plus the generated
      // first-person stem and proof prompt. model_stem / model_proof_prompt
      // keep what the model wrote after a client edit.
      objectives: {
        Row: {
          id: string;
          request_id: string;
          /** 0-based, unique within the request. */
          position: number;
          objective_text: string;
          stem: string | null;
          proof_prompt: string | null;
          model_stem: string | null;
          model_proof_prompt: string | null;
          client_edited: boolean;
          source: 'model' | 'fallback' | 'client' | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          request_id: string;
          position: number;
          objective_text: string;
          stem?: string | null;
          proof_prompt?: string | null;
          model_stem?: string | null;
          model_proof_prompt?: string | null;
          client_edited?: boolean;
          source?: 'model' | 'fallback' | 'client' | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          request_id?: string;
          position?: number;
          objective_text?: string;
          stem?: string | null;
          proof_prompt?: string | null;
          model_stem?: string | null;
          model_proof_prompt?: string | null;
          client_edited?: boolean;
          source?: 'model' | 'fallback' | 'client' | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };

      // One screening link = one candidate on one request. NOT the Matchy
      // reply token (lib/outreachToken.ts) — this is lib/screeningToken.ts.
      // The raw token is never stored; `token_hash` is sha256(raw) and unique.
      // `expert_email` and `rate_ask` are STAFF-ONLY and must be dropped by the
      // route before a respondent reaches a client.
      screening_tokens: {
        Row: {
          id: string;
          request_id: string;
          /** 'em:<24 hex>' or 'anon:<12 hex>' — the cross-request expert key. */
          expert_id: string;
          expert_email: string | null;
          /** ExpertSnapshot (types.ts): { name, headline, background[] }. */
          expert_snapshot: Json;
          token_hash: string;
          expires_at: string;
          /** Single use: the submit is conditional on this being null. */
          submitted_at: string | null;
          revoked_at: string | null;
          call_requested_at: string | null;
          rate_accepted: boolean | null;
          /** EXPERT-side dollars per hour. Staff-only raw. */
          rate_ask: number | null;
          availability: 'this_week' | 'next_week' | 'later' | null;
          created_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          request_id: string;
          expert_id: string;
          expert_email?: string | null;
          expert_snapshot?: Json;
          token_hash: string;
          expires_at: string;
          submitted_at?: string | null;
          revoked_at?: string | null;
          call_requested_at?: string | null;
          rate_accepted?: boolean | null;
          rate_ask?: number | null;
          availability?: 'this_week' | 'next_week' | 'later' | null;
          created_by?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          request_id?: string;
          expert_id?: string;
          expert_email?: string | null;
          expert_snapshot?: Json;
          token_hash?: string;
          expires_at?: string;
          submitted_at?: string | null;
          revoked_at?: string | null;
          call_requested_at?: string | null;
          rate_accepted?: boolean | null;
          rate_ask?: number | null;
          availability?: 'this_week' | 'next_week' | 'later' | null;
          created_by?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };

      // One expert answer to one objective. request_id and expert_id are
      // denormalised from the token row so the stage-5 queries index off this
      // table alone. proof_text is the expert's own sentence, shown to the
      // client unsummarised.
      screening_responses: {
        Row: {
          id: string;
          token_id: string;
          objective_id: string;
          request_id: string;
          expert_id: string;
          answer: 'yes' | 'no' | 'unsure';
          proof_text: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          token_id: string;
          objective_id: string;
          request_id: string;
          expert_id: string;
          answer: 'yes' | 'no' | 'unsure';
          proof_text?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          token_id?: string;
          objective_id?: string;
          request_id?: string;
          expert_id?: string;
          answer?: 'yes' | 'no' | 'unsure';
          proof_text?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };

      // Stage 5: what the call actually delivered, one verdict per objective.
      // Upserted on (token_id, objective_id) — re-marking is not a new row.
      call_outcomes: {
        Row: {
          id: string;
          request_id: string;
          token_id: string;
          objective_id: string;
          expert_id: string;
          outcome: 'answered' | 'partial' | 'unanswered';
          marked_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          request_id: string;
          token_id: string;
          objective_id: string;
          expert_id: string;
          outcome: 'answered' | 'partial' | 'unanswered';
          marked_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          request_id?: string;
          token_id?: string;
          objective_id?: string;
          expert_id?: string;
          outcome?: 'answered' | 'partial' | 'unanswered';
          marked_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      is_org_member: { Args: { p_org: string }; Returns: boolean };
      is_org_admin: { Args: { p_org: string }; Returns: boolean };
      admin_shares_org_with: { Args: { p_target: string }; Returns: boolean };
      is_project_owner: { Args: { p_project: string }; Returns: boolean };
      has_project_access: { Args: { p_project: string }; Returns: boolean };
      // Added by 20260902000000 section 3 (RLS hardening).
      is_active_member_of_project_org: {
        Args: { p_project: string; p_profile: string };
        Returns: boolean;
      };
      may_be_project_member: {
        Args: { p_project: string; p_profile: string };
        Returns: boolean;
      };
      is_platform_admin_profile: { Args: { p_profile: string }; Returns: boolean };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

// Convenience row aliases used by the data layer.
export type OrganizationRow = Database['public']['Tables']['organizations']['Row'];
export type ProfileRow = Database['public']['Tables']['profiles']['Row'];
export type OrganizationMemberRow = Database['public']['Tables']['organization_members']['Row'];
export type AccessRequestRow = Database['public']['Tables']['access_requests']['Row'];
export type ProjectRow = Database['public']['Tables']['projects']['Row'];
export type ProjectMemberRow = Database['public']['Tables']['project_members']['Row'];
export type ProjectExpertRow = Database['public']['Tables']['project_experts']['Row'];
export type UserCalendarConnectionRow = Database['public']['Tables']['user_calendar_connections']['Row'];
export type OutreachSuppressionRow = Database['public']['Tables']['outreach_suppressions']['Row'];
export type OrganizationBillingRow = Database['public']['Tables']['organization_billing']['Row'];
export type ConversationMessageRow = Database['public']['Tables']['conversation_messages']['Row'];
export type EngagementEventRow = Database['public']['Tables']['engagement_events']['Row'];
export type ProductEventRow = Database['public']['Tables']['product_events']['Row'];
export type SystemEventRow = Database['public']['Tables']['system_events']['Row'];
export type SystemEventInsert = Database['public']['Tables']['system_events']['Insert'];

// Screening flow (20260914000000_screening_requests.sql).
export type ExpertRequestRow = Database['public']['Tables']['expert_requests']['Row'];
export type ObjectiveRow = Database['public']['Tables']['objectives']['Row'];
export type ScreeningTokenRow = Database['public']['Tables']['screening_tokens']['Row'];
export type ScreeningResponseRow = Database['public']['Tables']['screening_responses']['Row'];
export type CallOutcomeRow = Database['public']['Tables']['call_outcomes']['Row'];
