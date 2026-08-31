// lib/supabase/database.types.ts
//
// Hand-authored types for the Supabase schema created in
// supabase/migrations/20260831000000_supabase_cutover_foundation.sql.
//
// Keep this file in sync with that migration. (Once the Supabase CLI is wired
// up you can regenerate with: `supabase gen types typescript --linked`.)
//
// Access model reminder:
//   org-scoped     -> organizations, profiles, organization_members,
//                     access_requests, invites
//   project-scoped -> projects, project_members, project_experts
// Project data is reachable only via project ownership or an explicit
// project_members row — never org-wide.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

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
          email: string;
          requested_domain: string | null;
          name: string | null;
          firm_name: string | null;
          organization_id: string | null;
          status: 'requested' | 'approved' | 'rejected';
          reviewed_by: string | null;
          reviewed_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          email: string;
          requested_domain?: string | null;
          name?: string | null;
          firm_name?: string | null;
          organization_id?: string | null;
          status?: 'requested' | 'approved' | 'rejected';
          reviewed_by?: string | null;
          reviewed_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          email?: string;
          requested_domain?: string | null;
          name?: string | null;
          firm_name?: string | null;
          organization_id?: string | null;
          status?: 'requested' | 'approved' | 'rejected';
          reviewed_by?: string | null;
          reviewed_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      invites: {
        Row: {
          id: string;
          email: string;
          organization_id: string;
          role: 'org_admin' | 'org_member';
          token_hash: string;
          status: 'pending' | 'accepted' | 'revoked' | 'expired';
          invited_by: string | null;
          expires_at: string;
          accepted_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          email: string;
          organization_id: string;
          role?: 'org_admin' | 'org_member';
          token_hash: string;
          status?: 'pending' | 'accepted' | 'revoked' | 'expired';
          invited_by?: string | null;
          expires_at: string;
          accepted_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          email?: string;
          organization_id?: string;
          role?: 'org_admin' | 'org_member';
          token_hash?: string;
          status?: 'pending' | 'accepted' | 'revoked' | 'expired';
          invited_by?: string | null;
          expires_at?: string;
          accepted_at?: string | null;
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
    };
    Views: Record<string, never>;
    Functions: {
      is_org_member: { Args: { p_org: string }; Returns: boolean };
      is_org_admin: { Args: { p_org: string }; Returns: boolean };
      admin_shares_org_with: { Args: { p_target: string }; Returns: boolean };
      is_project_owner: { Args: { p_project: string }; Returns: boolean };
      has_project_access: { Args: { p_project: string }; Returns: boolean };
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
export type InviteRow = Database['public']['Tables']['invites']['Row'];
export type ProjectRow = Database['public']['Tables']['projects']['Row'];
export type ProjectMemberRow = Database['public']['Tables']['project_members']['Row'];
export type ProjectExpertRow = Database['public']['Tables']['project_experts']['Row'];
