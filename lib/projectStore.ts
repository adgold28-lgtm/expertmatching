// Project workspace storage.
// Production: Upstash Redis — durable, no TTL (projects persist indefinitely).
// Development: in-memory Map with clear warning (process-local only).
//
// Key scheme — no client names or PII in Redis key names:
//   project:{24-char hex id}  → full Project JSON
//   projects:index            → JSON array of ProjectSummary (lightweight list view)
//
// NEVER log: project names, research questions, confidential notes, or expert names.
// TODO: Add proper per-user auth before multi-tenant deployment.

import { randomBytes } from 'crypto';
import type { Expert, Project, ProjectExpert, ProjectSummary, ExpertStatus, RejectionReason, ValueChainPosition, ScreeningStatus, SuggestedDomain, PublicContactEmail, AvailabilitySlot, OverlapSlot } from '../types';
import { getUpstashClient, type UpstashRedis } from './upstashRedis';

// ─── Input types ──────────────────────────────────────────────────────────────

export interface CreateProjectInput {
  name: string;
  researchQuestion: string;
  industry: string;
  function: string;
  geography: string;
  seniority: string;
  experts?: Array<{ expert: Expert; status?: ExpertStatus }>;
  notes?: string;
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
    id:              p.id,
    name:            p.name,
    researchQuestion: p.researchQuestion,
    expertCount:     p.experts.length,
    shortlistedCount: p.experts.filter(e => e.status === 'shortlisted').length,
    createdAt:       p.createdAt,
    updatedAt:       p.updatedAt,
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

// ─── Store interface ──────────────────────────────────────────────────────────

interface ProjectStore {
  createProject(input: CreateProjectInput): Promise<Project>;
  getProject(id: string): Promise<Project | null>;
  listProjects(): Promise<ProjectSummary[]>;
  updateProject(project: Project): Promise<Project>;
  deleteProject(id: string): Promise<{ success: boolean }>;
  addExpertsToProject(id: string, experts: Array<{ expert: Expert; status?: ExpertStatus }>): Promise<Project>;
  updateExpertStatus(id: string, expertId: string, input: UpdateExpertInput): Promise<Project>;
  updateProjectFields(id: string, input: UpdateProjectInput): Promise<Project>;
  addExpertNote(id: string, expertId: string, note: string): Promise<Project>;
  removeExpertFromProject(id: string, expertId: string): Promise<Project>;
}

// ─── In-memory (dev only) ─────────────────────────────────────────────────────

class InMemoryProjectStore implements ProjectStore {
  private data = new Map<string, Project>();

  async createProject(input: CreateProjectInput): Promise<Project> {
    const now = Date.now();
    const project: Project = {
      id:               generateProjectId(),
      name:             input.name,
      researchQuestion: input.researchQuestion,
      industry:         input.industry,
      function:         input.function,
      geography:        input.geography,
      seniority:        input.seniority,
      createdAt:        now,
      updatedAt:        now,
      experts:          makeProjectExperts(input.experts ?? []),
      notes:            input.notes,
    };
    this.data.set(project.id, project);
    return project;
  }

  async getProject(id: string): Promise<Project | null> {
    return this.data.get(id) ?? null;
  }

  async listProjects(): Promise<ProjectSummary[]> {
    return Array.from(this.data.values())
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
}

// ─── Upstash Redis (production) ───────────────────────────────────────────────

class UpstashProjectStore implements ProjectStore {
  constructor(private readonly redis: UpstashRedis) {}

  private async getIndex(): Promise<ProjectSummary[]> {
    const raw = await this.redis.get('projects:index');
    if (!raw) return [];
    try { return JSON.parse(raw) as ProjectSummary[]; } catch { return []; }
  }

  private async setIndex(summaries: ProjectSummary[]): Promise<void> {
    const sorted = [...summaries].sort((a, b) => b.updatedAt - a.updatedAt);
    await this.redis.set('projects:index', JSON.stringify(sorted));
  }

  // Advisory lock around projects:index read-modify-write to reduce (not
  // eliminate) the race window when multiple requests update the index
  // concurrently. Lock expires in 5s; on failure, proceeds without lock.
  private async withIndexLock<T>(op: () => Promise<T>): Promise<T> {
    const lockKey = 'lock:projects:index';
    const lockId  = randomBytes(8).toString('hex');
    let acquired  = false;

    for (let i = 0; i < 5; i++) {
      const ok = await this.redis.set(lockKey, lockId, { ex: 5, nx: true });
      if (ok === 'OK') { acquired = true; break; }
      if (i < 4) await new Promise(r => setTimeout(r, 120 + i * 80));
    }

    if (!acquired) {
      // Could not acquire — proceed without lock rather than blocking the request.
      // TODO: replace with Redis WATCH / optimistic concurrency for strict safety.
      console.warn('[projectStore] index lock contention — proceeding without lock');
    }

    try {
      return await op();
    } finally {
      if (acquired) {
        await this.redis.releaseLockIfOwner(lockKey, lockId).catch(() => {});
      }
    }
  }

  async createProject(input: CreateProjectInput): Promise<Project> {
    const now = Date.now();
    const project: Project = {
      id:               generateProjectId(),
      name:             input.name,
      researchQuestion: input.researchQuestion,
      industry:         input.industry,
      function:         input.function,
      geography:        input.geography,
      seniority:        input.seniority,
      createdAt:        now,
      updatedAt:        now,
      experts:          makeProjectExperts(input.experts ?? []),
      notes:            input.notes,
    };
    await this.redis.set(`project:${project.id}`, JSON.stringify(project));
    await this.withIndexLock(async () => {
      const index = await this.getIndex();
      index.push(toSummary(project));
      await this.setIndex(index);
    });
    return project;
  }

  async getProject(id: string): Promise<Project | null> {
    if (!ID_RE.test(id)) return null;
    const raw = await this.redis.get(`project:${id}`);
    if (!raw) return null;
    try { return JSON.parse(raw) as Project; } catch { return null; }
  }

  async listProjects(): Promise<ProjectSummary[]> {
    return this.getIndex();
  }

  async updateProject(project: Project): Promise<Project> {
    const updated = { ...project, updatedAt: Date.now() };
    await this.redis.set(`project:${project.id}`, JSON.stringify(updated));
    await this.withIndexLock(async () => {
      const index    = await this.getIndex();
      const newIndex = index.map(s => s.id === project.id ? toSummary(updated) : s);
      await this.setIndex(newIndex);
    });
    return updated;
  }

  async deleteProject(id: string): Promise<{ success: boolean }> {
    if (!ID_RE.test(id)) return { success: false };
    // Delete the project document; remove it from the index under the advisory lock.
    await this.redis.del(`project:${id}`);
    await this.withIndexLock(async () => {
      const index    = await this.getIndex();
      const filtered = index.filter(s => s.id !== id);
      await this.setIndex(filtered);
    });
    return { success: true };
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
}

// ─── Factory ─────────────────────────────────────────────────────────────────

let _store: ProjectStore | null = null;

function getProjectStore(): ProjectStore {
  if (_store) return _store;
  const redis = getUpstashClient();
  if (redis) {
    _store = new UpstashProjectStore(redis);
    return _store;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[projectStore] FATAL: production requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN');
  }
  console.warn('[projectStore] Using in-memory store — dev mode only, NOT production-safe.');
  _store = new InMemoryProjectStore();
  return _store;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function createProject(input: CreateProjectInput): Promise<Project> {
  return getProjectStore().createProject(input);
}

export function getProject(id: string): Promise<Project | null> {
  if (!ID_RE.test(id)) return Promise.resolve(null);
  return getProjectStore().getProject(id);
}

export function listProjects(): Promise<ProjectSummary[]> {
  return getProjectStore().listProjects();
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
