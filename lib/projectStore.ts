// Project workspace storage.
// Production: Supabase Postgres — `projects` (promoted columns + brief jsonb),
// `project_experts` (one row per expert), `project_members` (sharing).
// Development fallback: in-memory Map with clear warning (process-local only).
//
// Access control mirrors the schema's RLS model: owner or explicit
// collaborator only (admins see everything). This layer uses the service-role
// client, so the email-based checks here are the enforcement for API routes;
// RLS is defense in depth beneath it.
//
// NEVER log: project names, research questions, confidential notes, or expert names.

import { randomBytes } from 'crypto';
import type { Expert, Project, ProjectExpert, ProjectSummary, ExpertStatus, RejectionReason, ValueChainPosition, ScreeningStatus, SuggestedDomain, PublicContactEmail, AvailabilitySlot, OverlapSlot } from '../types';
import { getServiceRoleClient } from './supabase/admin';
import type { Database, ProjectRow, ProjectExpertRow } from './supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

// ─── Input types ──────────────────────────────────────────────────────────────

export interface CreateProjectInput {
  name: string;
  researchQuestion?: string;  // optional — filled later when user runs search
  expertType?: string;        // "who to talk to" brief field
  industry: string;
  function: string;
  geography: string;
  seniority: string;
  experts?: Array<{ expert: Expert; status?: ExpertStatus }>;
  notes?: string;
  outreachMode?: 'auto' | 'review';
}

export interface UpdateExpertInput {
  status?: ExpertStatus;
  userNotes?: string;
  rejectionReason?: RejectionReason;
  rejectionNotes?: string;  // never logged
  rejectedAt?: number;
  contactEmail?: string;
  emailVerificationStatus?: import('../types').ContactStatus;
  emailProvider?: 'hunter' | 'snov' | 'none';
  emailCheckedAt?: number;
  contactStatus?: string;
  contactedAt?: number;
  outreachSubject?: string;
  outreachDraft?: string;
  // Contact path discovery
  suggestedDomains?: SuggestedDomain[];
  publicContactEmails?: PublicContactEmail[];
  selectedDomain?: string;
  selectedContactPathType?: 'personal_email' | 'general_company_email' | 'linkedin_source' | 'unknown';
  // Screening fields — screeningNotes must never be logged
  valueChainPosition?: ValueChainPosition;
  screeningStatus?: ScreeningStatus;
  vettingQuestions?: string[];
  screeningNotes?: string;
  knowledgeFit?: 1 | 2 | 3 | 4 | 5;
  communicationQuality?: 1 | 2 | 3 | 4 | 5;
  conflictRisk?: 'low' | 'medium' | 'high' | 'unknown';
  availability?: string;
  rateExpectation?: string;
  recommendToClient?: boolean;
  scheduledTime?: string;
  screenedAt?: number;
  // Availability token fields — never logged
  availabilityTokenHash?:   string;
  availabilityTokenExpiry?: number;
  availabilityRequestedAt?: number;
  availabilitySubmitted?:   boolean;
  availabilitySlots?:       AvailabilitySlot[];
  availabilityRaw?:         string;
  calendarProvider?:        'google' | 'calendly' | 'manual';
  // Calendar OAuth fields — never logged
  calendarAccessToken?:     string;
  calendarRefreshToken?:    string;
  calendarTokenExpiry?:     number;
  calendarEmail?:           string;
  calendlyUrl?:             string;
  calendlyAccessToken?:     string;
  oauthState?:              string | null;
  // Overlap engine results
  overlapResult?:    OverlapSlot | null;
  overlapCheckedAt?: number;
  calendarEventId?:  string;
  // Billing / Stripe
  clientRate?:           number | null;
  expertRate?:           number | null;
  callDurationMin?:      number | null;
  invoiceAmount?:        number | null;
  stripePaymentLinkId?:  string | null;
  stripePaymentLinkUrl?: string | null;
  stripePaymentIntentId?: string | null;
  paymentStatus?:        'unpaid' | 'invoice_sent' | 'paid' | 'failed' | null;
  paidAt?:               number | null;
  // Zoom meeting fields — zoomStartUrl is host-only, never exposed to frontend
  zoomMeetingId?:      string | null;
  zoomJoinUrl?:        string | null;
  zoomStartUrl?:       string | null;
  zoomMeetingStarted?: boolean;
  zoomMeetingEndedAt?: number | null;
  actualDurationMin?:  number | null;
  // Email sequence fields
  outreachToken?:        string;
  outreachStep?:         'email1' | 'email2' | 'email3';
  email1SentAt?:         number;
  email2SentAt?:         number;
  email3SentAt?:         number;
  replyDetectedAt?:      number;
  replyIntent?:          'interested' | 'declined' | 'counter_rate' | 'conflict' | 'unclear';
  counterRateProposed?:  number;
  conflictNote?:         string;
  // Stripe Connect
  stripeConnectAccountId?:  string;
  stripeTransferId?:        string;
  expertPaidAt?:            number;
  expertOnboardingStatus?:  'pending' | 'complete' | 'failed';
}

export interface UpdateProjectInput {
  notes?: string;
  confidentialNotes?: string;
  timeline?: string;
  targetExpertCount?: number;
  keyQuestions?: string;
  initialHypotheses?: string;
  additionalContext?: string;
  mustHaveExpertise?: string;
  niceToHaveExpertise?: string;
  targetCompanies?: string;
  companiesToAvoid?: string;
  peopleToAvoid?: string;
  conflictExclusions?: string;
  perspectivesNeeded?: string[];
  // Client scheduling fields
  clientEmail?: string | null;
  clientName?: string | null;
  clientAvailabilityToken?: string | null;
  clientAvailabilityTokenHash?: string | null;
  clientAvailabilityTokenExpiry?: number | null;
  clientAvailabilitySubmitted?: boolean;
  clientAvailabilitySlots?: AvailabilitySlot[] | null;
  clientCalendarProvider?: 'google' | 'calendly' | 'manual' | null;
  clientCalendarAccessToken?: string | null;
  clientCalendarRefreshToken?: string | null;
  clientCalendarEmail?: string | null;
  clientCalendlyUrl?: string;
  // Stripe
  stripeCustomerId?: string | null;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

const ID_RE = /^[a-f0-9]{24}$/;

function generateProjectId(): string {
  return randomBytes(12).toString('hex');
}

function toSummary(p: Project): ProjectSummary {
  return {
    id:               p.id,
    name:             p.name,
    researchQuestion: p.researchQuestion,
    expertCount:      p.experts.length,
    shortlistedCount: p.experts.filter(e => e.status === 'shortlisted').length,
    createdAt:        p.createdAt,
    updatedAt:        p.updatedAt,
    ownerEmail:       p.ownerEmail,
    collaborators:    p.collaborators,
  };
}

function makeProjectExperts(experts: Array<{ expert: Expert; status?: ExpertStatus }>): ProjectExpert[] {
  const now = Date.now();
  return experts.map(({ expert, status }) => ({
    expert,
    status: status ?? 'discovered',
    addedAt:   now,
    updatedAt: now,
  }));
}

function canAccess(p: { ownerEmail: string; collaborators: string[] }, email: string, role: 'admin' | 'user'): boolean {
  if (role === 'admin') return true;
  return p.ownerEmail === email || p.collaborators.includes(email);
}

// ─── Store interface ──────────────────────────────────────────────────────────

interface ProjectStore {
  createProject(input: CreateProjectInput, ownerEmail: string): Promise<Project>;
  getProject(id: string): Promise<Project | null>;
  getProjectForUser(id: string, email: string, role: 'admin' | 'user'): Promise<Project | null>;
  listProjects(): Promise<ProjectSummary[]>;
  listProjectsForUser(email: string, role: 'admin' | 'user'): Promise<ProjectSummary[]>;
  updateProject(project: Project): Promise<Project>;
  deleteProject(id: string): Promise<{ success: boolean }>;
  addExpertsToProject(id: string, experts: Array<{ expert: Expert; status?: ExpertStatus }>): Promise<Project>;
  updateExpertStatus(id: string, expertId: string, input: UpdateExpertInput): Promise<Project>;
  updateProjectFields(id: string, input: UpdateProjectInput): Promise<Project>;
  addExpertNote(id: string, expertId: string, note: string): Promise<Project>;
  removeExpertFromProject(id: string, expertId: string): Promise<Project>;
  addCollaborator(id: string, ownerEmail: string, collaboratorEmail: string): Promise<Project>;
  removeCollaborator(id: string, ownerEmail: string, collaboratorEmail: string): Promise<Project>;
}

// ─── In-memory (dev only) ─────────────────────────────────────────────────────

class InMemoryProjectStore implements ProjectStore {
  private data = new Map<string, Project>();

  async createProject(input: CreateProjectInput, ownerEmail: string): Promise<Project> {
    const now      = Date.now();
    const firmDomain = ownerEmail === 'admin' ? '*' : (ownerEmail.split('@')[1] ?? 'admin');
    const project: Project = {
      id:               generateProjectId(),
      name:             input.name,
      researchQuestion: input.researchQuestion ?? '',
      industry:         input.industry,
      function:         input.function,
      geography:        input.geography,
      seniority:        input.seniority,
      createdAt:        now,
      updatedAt:        now,
      experts:          makeProjectExperts(input.experts ?? []),
      notes:            input.notes,
      outreachMode:     input.outreachMode ?? 'review',
      ownerEmail,
      collaborators:    [],
      firmDomain,
    };
    this.data.set(project.id, project);
    return project;
  }

  async getProject(id: string): Promise<Project | null> {
    return this.data.get(id) ?? null;
  }

  async getProjectForUser(id: string, email: string, role: 'admin' | 'user'): Promise<Project | null> {
    const project = this.data.get(id) ?? null;
    if (!project) return null;
    return canAccess(project, email, role) ? project : null;
  }

  async listProjects(): Promise<ProjectSummary[]> {
    return Array.from(this.data.values())
      .map(toSummary)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async listProjectsForUser(email: string, role: 'admin' | 'user'): Promise<ProjectSummary[]> {
    return Array.from(this.data.values())
      .filter(p => canAccess(p, email, role))
      .map(toSummary)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async updateProject(project: Project): Promise<Project> {
    const updated = { ...project, updatedAt: Date.now() };
    this.data.set(project.id, updated);
    return updated;
  }

  async addExpertsToProject(id: string, experts: Array<{ expert: Expert; status?: ExpertStatus }>): Promise<Project> {
    const project = await this.getProject(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    const existingIds = new Set(project.experts.map(pe => pe.expert.id));
    const newEntries  = makeProjectExperts(experts.filter(({ expert: e }) => !existingIds.has(e.id)));
    return this.updateProject({ ...project, experts: [...project.experts, ...newEntries] });
  }

  async updateExpertStatus(id: string, expertId: string, input: UpdateExpertInput): Promise<Project> {
    const project = await this.getProject(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    const experts = project.experts.map(pe =>
      pe.expert.id !== expertId ? pe : { ...pe, ...input, updatedAt: Date.now() },
    );
    return this.updateProject({ ...project, experts });
  }

  async updateProjectFields(id: string, input: UpdateProjectInput): Promise<Project> {
    const project = await this.getProject(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    return this.updateProject({ ...project, ...input });
  }

  async addExpertNote(id: string, expertId: string, note: string): Promise<Project> {
    const project = await this.getProject(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    const experts = project.experts.map(pe => {
      if (pe.expert.id !== expertId) return pe;
      const existing  = pe.userNotes?.trim() ?? '';
      const userNotes = existing ? `${existing}\n\n${note.trim()}` : note.trim();
      return { ...pe, userNotes, updatedAt: Date.now() };
    });
    return this.updateProject({ ...project, experts });
  }

  async removeExpertFromProject(id: string, expertId: string): Promise<Project> {
    const project = await this.getProject(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    return this.updateProject({ ...project, experts: project.experts.filter(pe => pe.expert.id !== expertId) });
  }

  async deleteProject(id: string): Promise<{ success: boolean }> {
    if (!this.data.has(id)) return { success: false };
    this.data.delete(id);
    return { success: true };
  }

  async addCollaborator(id: string, ownerEmail: string, collaboratorEmail: string): Promise<Project> {
    const project = await this.getProject(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    if (project.ownerEmail !== ownerEmail) throw new Error('Only the project owner can add collaborators');
    if (project.collaborators.includes(collaboratorEmail)) return project;
    return this.updateProject({ ...project, collaborators: [...project.collaborators, collaboratorEmail] });
  }

  async removeCollaborator(id: string, ownerEmail: string, collaboratorEmail: string): Promise<Project> {
    const project = await this.getProject(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    if (project.ownerEmail !== ownerEmail) throw new Error('Only the project owner can remove collaborators');
    return this.updateProject({ ...project, collaborators: project.collaborators.filter(e => e !== collaboratorEmail) });
  }
}

// ─── Supabase Postgres (production) ──────────────────────────────────────────

// Project fields promoted to real columns; everything else lives in `brief`.
const PROMOTED_PROJECT_KEYS = new Set([
  'id', 'name', 'researchQuestion', 'createdAt', 'updatedAt',
  'experts', 'ownerEmail', 'collaborators', 'firmDomain',
]);

// ProjectExpert fields promoted to real columns; everything else in `data`.
const PROMOTED_EXPERT_KEYS = new Set(['status', 'contactEmail']);

// Bounded retries for the optimistic-concurrency loop in mutateExpert.
const EXPERT_WRITE_RETRIES = 3;

function toMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function projectToBrief(project: Project): Record<string, unknown> {
  const brief: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(project)) {
    if (!PROMOTED_PROJECT_KEYS.has(k) && v !== undefined) brief[k] = v;
  }
  return brief;
}

function expertToRow(projectId: string, pe: ProjectExpert): Database['public']['Tables']['project_experts']['Insert'] {
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(pe)) {
    if (!PROMOTED_EXPERT_KEYS.has(k) && v !== undefined) data[k] = v;
  }
  return {
    project_id:    projectId,
    expert_id:     pe.expert.id,
    status:        pe.status,
    contact_email: pe.contactEmail ?? null,
    data:          data as Database['public']['Tables']['project_experts']['Insert']['data'],
  };
}

function rowToExpert(row: ProjectExpertRow): ProjectExpert {
  const data = (row.data ?? {}) as unknown as Omit<ProjectExpert, 'status' | 'contactEmail'>;
  return {
    ...data,
    status: row.status as ExpertStatus,
    ...(row.contact_email ? { contactEmail: row.contact_email } : {}),
  };
}

interface ProjectContext {
  ownerEmail:    string;
  collaborators: string[];
  firmDomain:    string;
}

function rowToProject(row: ProjectRow, experts: ProjectExpert[], ctx: ProjectContext): Project {
  const brief = (row.brief ?? {}) as Partial<Project>;
  return {
    ...brief,
    id:               row.id,
    name:             row.name,
    researchQuestion: row.research_question,
    industry:         brief.industry  ?? '',
    function:         brief.function  ?? '',
    geography:        brief.geography ?? '',
    seniority:        brief.seniority ?? '',
    createdAt:        toMs(row.created_at),
    updatedAt:        toMs(row.updated_at),
    experts,
    ownerEmail:       ctx.ownerEmail,
    collaborators:    ctx.collaborators,
    firmDomain:       ctx.firmDomain,
  };
}

class SupabaseProjectStore implements ProjectStore {
  constructor(private readonly db: SupabaseClient<Database>) {}

  // ── lookup helpers ─────────────────────────────────────────────────────────

  private async profileIdByEmail(email: string): Promise<string | null> {
    const { data } = await this.db
      .from('profiles')
      .select('id')
      .eq('email', email.toLowerCase().trim())
      .maybeSingle();
    return data?.id ?? null;
  }

  private async emailsByProfileIds(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const { data } = await this.db.from('profiles').select('id, email').in('id', ids);
    return new Map((data ?? []).map(p => [p.id, p.email]));
  }

  /** Owner email, collaborator emails, and org domain for one project row. */
  private async contextFor(row: ProjectRow): Promise<ProjectContext> {
    const [{ data: members }, emailById, { data: org }] = await Promise.all([
      this.db.from('project_members').select('profile_id').eq('project_id', row.id),
      this.emailsByProfileIds([row.owner_id]),
      this.db.from('organizations').select('domain').eq('id', row.organization_id).maybeSingle(),
    ]);
    const collaboratorIds = (members ?? []).map(m => m.profile_id).filter(id => id !== row.owner_id);
    const collabEmailById = await this.emailsByProfileIds(collaboratorIds);
    return {
      ownerEmail:    emailById.get(row.owner_id) ?? '',
      collaborators: collaboratorIds.map(id => collabEmailById.get(id)).filter((e): e is string => !!e),
      firmDomain:    org?.domain ?? '',
    };
  }

  private async expertsFor(projectId: string): Promise<ProjectExpert[]> {
    const { data } = await this.db
      .from('project_experts')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: true });
    return (data ?? []).map(rowToExpert);
  }

  private async assemble(row: ProjectRow): Promise<Project> {
    const [experts, ctx] = await Promise.all([this.expertsFor(row.id), this.contextFor(row)]);
    return rowToProject(row, experts, ctx);
  }

  private async getRow(id: string): Promise<ProjectRow | null> {
    const { data } = await this.db.from('projects').select('*').eq('id', id).maybeSingle();
    return data ?? null;
  }

  // ── ProjectStore implementation ────────────────────────────────────────────

  async createProject(input: CreateProjectInput, ownerEmail: string): Promise<Project> {
    const ownerId = await this.profileIdByEmail(ownerEmail);
    if (!ownerId) throw new Error('Project owner has no account');

    const { data: membership } = await this.db
      .from('organization_members')
      .select('organization_id')
      .eq('profile_id', ownerId)
      .limit(1)
      .maybeSingle();
    if (!membership) throw new Error('Project owner has no organization');

    const brief: Record<string, unknown> = {
      industry:     input.industry,
      function:     input.function,
      geography:    input.geography,
      seniority:    input.seniority,
      outreachMode: input.outreachMode ?? 'review',
      ...(input.expertType ? { expertType: input.expertType } : {}),
      ...(input.notes      ? { notes:      input.notes }      : {}),
    };

    const id = generateProjectId();
    const { data: row, error } = await this.db
      .from('projects')
      .insert({
        id,
        organization_id:   membership.organization_id,
        owner_id:          ownerId,
        name:              input.name,
        research_question: input.researchQuestion ?? '',
        brief:             brief as Database['public']['Tables']['projects']['Insert']['brief'],
      })
      .select()
      .single();
    if (error || !row) throw new Error('Failed to create project');

    const experts = makeProjectExperts(input.experts ?? []);
    if (experts.length > 0) {
      const { error: expErr } = await this.db
        .from('project_experts')
        .insert(experts.map(pe => expertToRow(id, pe)));
      if (expErr) throw new Error('Failed to add experts to new project');
    }

    return this.assemble(row);
  }

  async getProject(id: string): Promise<Project | null> {
    if (!ID_RE.test(id)) return null;
    const row = await this.getRow(id);
    return row ? this.assemble(row) : null;
  }

  async getProjectForUser(id: string, email: string, role: 'admin' | 'user'): Promise<Project | null> {
    const project = await this.getProject(id);
    if (!project) return null;
    return canAccess(project, email, role) ? project : null;
  }

  private async summarize(rows: ProjectRow[]): Promise<ProjectSummary[]> {
    if (rows.length === 0) return [];
    const ids = rows.map(r => r.id);

    const [{ data: expertRows }, { data: memberRows }] = await Promise.all([
      this.db.from('project_experts').select('project_id, status').in('project_id', ids),
      this.db.from('project_members').select('project_id, profile_id').in('project_id', ids),
    ]);

    const profileIds = Array.from(new Set([
      ...rows.map(r => r.owner_id),
      ...(memberRows ?? []).map(m => m.profile_id),
    ]));
    const emailById = await this.emailsByProfileIds(profileIds);

    const counts = new Map<string, { total: number; shortlisted: number }>();
    for (const e of expertRows ?? []) {
      const c = counts.get(e.project_id) ?? { total: 0, shortlisted: 0 };
      c.total += 1;
      if (e.status === 'shortlisted') c.shortlisted += 1;
      counts.set(e.project_id, c);
    }

    const collabsByProject = new Map<string, string[]>();
    for (const m of memberRows ?? []) {
      const email = emailById.get(m.profile_id);
      if (!email) continue;
      const list = collabsByProject.get(m.project_id) ?? [];
      list.push(email);
      collabsByProject.set(m.project_id, list);
    }

    return rows
      .map(r => {
        const c = counts.get(r.id) ?? { total: 0, shortlisted: 0 };
        const ownerEmail = emailById.get(r.owner_id) ?? '';
        return {
          id:               r.id,
          name:             r.name,
          researchQuestion: r.research_question,
          expertCount:      c.total,
          shortlistedCount: c.shortlisted,
          createdAt:        toMs(r.created_at),
          updatedAt:        toMs(r.updated_at),
          ownerEmail,
          collaborators:    (collabsByProject.get(r.id) ?? []).filter(e => e !== ownerEmail),
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const { data } = await this.db.from('projects').select('*');
    return this.summarize(data ?? []);
  }

  async listProjectsForUser(email: string, role: 'admin' | 'user'): Promise<ProjectSummary[]> {
    if (role === 'admin') return this.listProjects();
    const profileId = await this.profileIdByEmail(email);
    if (!profileId) return [];

    const [{ data: owned }, { data: memberships }] = await Promise.all([
      this.db.from('projects').select('*').eq('owner_id', profileId),
      this.db.from('project_members').select('project_id').eq('profile_id', profileId),
    ]);
    const memberIds = (memberships ?? []).map(m => m.project_id);
    let shared: ProjectRow[] = [];
    if (memberIds.length > 0) {
      const { data } = await this.db.from('projects').select('*').in('id', memberIds);
      shared = data ?? [];
    }
    const seen = new Set<string>();
    const rows = [...(owned ?? []), ...shared].filter(r => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
    return this.summarize(rows);
  }

  // Updates project-level fields only (name, research question, brief).
  // Experts and collaborators are managed by their dedicated methods.
  async updateProject(project: Project): Promise<Project> {
    const { data: row, error } = await this.db
      .from('projects')
      .update({
        name:              project.name,
        research_question: project.researchQuestion,
        brief:             projectToBrief(project) as Database['public']['Tables']['projects']['Update']['brief'],
      })
      .eq('id', project.id)
      .select()
      .single();
    if (error || !row) throw new Error(`Project not found: ${project.id}`);
    return this.assemble(row);
  }

  async deleteProject(id: string): Promise<{ success: boolean }> {
    if (!ID_RE.test(id)) return { success: false };
    // Cascades to project_experts and project_members via FK.
    const { error } = await this.db.from('projects').delete().eq('id', id);
    return { success: !error };
  }

  /** Touches projects.updated_at so list views sort correctly. */
  private async touch(id: string): Promise<void> {
    await this.db.from('projects').update({ updated_at: new Date().toISOString() }).eq('id', id);
  }

  async addExpertsToProject(id: string, experts: Array<{ expert: Expert; status?: ExpertStatus }>): Promise<Project> {
    const row = await this.getRow(id);
    if (!row) throw new Error(`Project not found: ${id}`);
    const entries = makeProjectExperts(experts);
    if (entries.length > 0) {
      // Ignore duplicates — an expert already in the project keeps its state.
      const { error } = await this.db
        .from('project_experts')
        .upsert(entries.map(pe => expertToRow(id, pe)), {
          onConflict:       'project_id,expert_id',
          ignoreDuplicates: true,
        });
      if (error) throw new Error('Failed to add experts');
      await this.touch(id);
    }
    return this.assemble((await this.getRow(id)) ?? row);
  }

  // Read-merge-write on one project_experts row, with optimistic concurrency:
  // the whole `data` blob is rewritten, so the UPDATE only applies if
  // `updated_at` still matches what we read (the row's trigger bumps it on
  // every write). On conflict, re-read and re-apply `mutate` on fresh state.
  private async mutateExpert(
    id: string,
    expertId: string,
    mutate: (current: ProjectExpert) => ProjectExpert,
  ): Promise<Project> {
    const row = await this.getRow(id);
    if (!row) throw new Error(`Project not found: ${id}`);

    for (let attempt = 0; attempt < EXPERT_WRITE_RETRIES; attempt++) {
      const { data: expertRow } = await this.db
        .from('project_experts')
        .select('*')
        .eq('project_id', id)
        .eq('expert_id', expertId)
        .maybeSingle();
      if (!expertRow) throw new Error(`Expert not found: ${expertId}`);

      const patch = expertToRow(id, mutate(rowToExpert(expertRow)));
      const { data: updated, error } = await this.db
        .from('project_experts')
        .update({ status: patch.status, contact_email: patch.contact_email, data: patch.data })
        .eq('id', expertRow.id)
        .eq('updated_at', expertRow.updated_at)
        .select('id');
      if (error) throw new Error('Failed to update expert');
      if (updated && updated.length > 0) {
        await this.touch(id);
        return this.assemble((await this.getRow(id)) ?? row);
      }
    }
    throw new Error('expert_update_conflict');
  }

  async updateExpertStatus(id: string, expertId: string, input: UpdateExpertInput): Promise<Project> {
    return this.mutateExpert(id, expertId, current => ({ ...current, ...input, updatedAt: Date.now() }));
  }

  async updateProjectFields(id: string, input: UpdateProjectInput): Promise<Project> {
    const row = await this.getRow(id);
    if (!row) throw new Error(`Project not found: ${id}`);
    const brief = { ...(row.brief as Record<string, unknown> ?? {}) };
    for (const [k, v] of Object.entries(input)) {
      if (v !== undefined) brief[k] = v;
    }
    const { data: updated, error } = await this.db
      .from('projects')
      .update({ brief: brief as Database['public']['Tables']['projects']['Update']['brief'] })
      .eq('id', id)
      .select()
      .single();
    if (error || !updated) throw new Error(`Project not found: ${id}`);
    return this.assemble(updated);
  }

  async addExpertNote(id: string, expertId: string, note: string): Promise<Project> {
    return this.mutateExpert(id, expertId, current => {
      const existing  = current.userNotes?.trim() ?? '';
      const userNotes = existing ? `${existing}\n\n${note.trim()}` : note.trim();
      return { ...current, userNotes, updatedAt: Date.now() };
    });
  }

  async removeExpertFromProject(id: string, expertId: string): Promise<Project> {
    const row = await this.getRow(id);
    if (!row) throw new Error(`Project not found: ${id}`);
    await this.db.from('project_experts').delete().eq('project_id', id).eq('expert_id', expertId);
    await this.touch(id);
    return this.assemble((await this.getRow(id)) ?? row);
  }

  async addCollaborator(id: string, ownerEmail: string, collaboratorEmail: string): Promise<Project> {
    const project = await this.getProject(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    if (project.ownerEmail !== ownerEmail) throw new Error('Only the project owner can add collaborators');
    if (project.collaborators.includes(collaboratorEmail)) return project;

    const profileId = await this.profileIdByEmail(collaboratorEmail);
    if (!profileId) throw new Error('Collaborator has no account');

    const { error } = await this.db
      .from('project_members')
      .upsert(
        { project_id: id, profile_id: profileId, role: 'collaborator' },
        { onConflict: 'project_id,profile_id', ignoreDuplicates: true },
      );
    if (error) throw new Error('Failed to add collaborator');
    await this.touch(id);
    return (await this.getProject(id)) ?? project;
  }

  async removeCollaborator(id: string, ownerEmail: string, collaboratorEmail: string): Promise<Project> {
    const project = await this.getProject(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    if (project.ownerEmail !== ownerEmail) throw new Error('Only the project owner can remove collaborators');

    const profileId = await this.profileIdByEmail(collaboratorEmail);
    if (profileId) {
      await this.db.from('project_members').delete().eq('project_id', id).eq('profile_id', profileId);
      await this.touch(id);
    }
    return (await this.getProject(id)) ?? project;
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

let _store: ProjectStore | null = null;

function getProjectStore(): ProjectStore {
  if (_store) return _store;
  const db = getServiceRoleClient();
  if (db) {
    _store = new SupabaseProjectStore(db);
    return _store;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[projectStore] FATAL: production requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  }
  console.warn('[projectStore] Using in-memory store — dev mode only, NOT production-safe.');
  _store = new InMemoryProjectStore();
  return _store;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function createProject(input: CreateProjectInput, ownerEmail: string): Promise<Project> {
  return getProjectStore().createProject(input, ownerEmail);
}

// Internal use only — no access control. Used by webhooks, Stripe, Zoom, availability.
export function getProject(id: string): Promise<Project | null> {
  if (!ID_RE.test(id)) return Promise.resolve(null);
  return getProjectStore().getProject(id);
}

// Access-controlled lookup — returns null if user has no access.
export function getProjectForUser(id: string, email: string, role: 'admin' | 'user'): Promise<Project | null> {
  if (!ID_RE.test(id)) return Promise.resolve(null);
  return getProjectStore().getProjectForUser(id, email, role);
}

// Internal use only — returns all projects. Used by Zoom webhooks.
export function listProjects(): Promise<ProjectSummary[]> {
  return getProjectStore().listProjects();
}

// Access-controlled list — returns only projects the user owns or collaborates on.
export function listProjectsForUser(email: string, role: 'admin' | 'user'): Promise<ProjectSummary[]> {
  return getProjectStore().listProjectsForUser(email, role);
}

export function updateProject(project: Project): Promise<Project> {
  return getProjectStore().updateProject(project);
}

export function deleteProject(id: string): Promise<{ success: boolean }> {
  if (!ID_RE.test(id)) return Promise.resolve({ success: false });
  return getProjectStore().deleteProject(id);
}

export function addExpertsToProject(
  id: string,
  experts: Array<{ expert: Expert; status?: ExpertStatus }>,
): Promise<Project> {
  return getProjectStore().addExpertsToProject(id, experts);
}

export function updateExpertStatus(
  id: string,
  expertId: string,
  input: UpdateExpertInput,
): Promise<Project> {
  return getProjectStore().updateExpertStatus(id, expertId, input);
}

export function updateProjectFields(id: string, input: UpdateProjectInput): Promise<Project> {
  return getProjectStore().updateProjectFields(id, input);
}

export function addExpertNote(id: string, expertId: string, note: string): Promise<Project> {
  return getProjectStore().addExpertNote(id, expertId, note);
}

export function removeExpertFromProject(id: string, expertId: string): Promise<Project> {
  return getProjectStore().removeExpertFromProject(id, expertId);
}

export function addCollaborator(id: string, ownerEmail: string, collaboratorEmail: string): Promise<Project> {
  return getProjectStore().addCollaborator(id, ownerEmail, collaboratorEmail);
}

export function removeCollaborator(id: string, ownerEmail: string, collaboratorEmail: string): Promise<Project> {
  return getProjectStore().removeCollaborator(id, ownerEmail, collaboratorEmail);
}
