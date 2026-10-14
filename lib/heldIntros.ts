// lib/heldIntros.ts — the staff queue of intros Matchy could not personalize.
//
// An intro is HELD when no why-them line passed (lib/introPersonalization:
// evidence, then one model call, then the sourced title and company): the
// engagement sits at 'outreach_drafted' with `introNeedsWhyThem: true` and
// nothing has gone to the expert (lib/outreachSteps.hold). Only a platform
// admin can unblock it, by writing the line through
// POST /api/projects/:id/experts/:expertId/outreach/approve { whyThem }.
// This module finds every such engagement, across every project, newest
// first, for /admin/held-intros.
//
// STAFF ONLY. Each item carries the expert's real name, title, company and
// evidence, because the point is that a person reads the background and
// writes the line. It is reached only through GET /api/admin/held-intros,
// behind adminGuard and middleware's admin-only 404. The contact address,
// rates and tokens are deliberately left out: nobody needs them to write a
// sentence.
//
// Read-only. Never logs names, titles, companies or evidence.

import type { EvidenceItem, Project, ProjectExpert } from '../types';
import type { Json } from './supabase/database.types';
import { getServiceRoleClient } from './supabase/admin';
import { getProject, listProjects } from './projectStore';
import { isWalkthrough } from './walkthrough';

// ─── Shape ────────────────────────────────────────────────────────────────────

export interface HeldIntroEvidence {
  claim:       string;
  sourceLabel: string;
  sourceUrl:   string | null;
}

export interface HeldIntro {
  projectId:   string;
  projectName: string;
  expertId:    string;
  name:        string;
  title:       string;
  company:     string;
  location:    string;
  /** The public record the expert was sourced from, when it is a real link. */
  sourceUrl:   string | null;
  sourceLabel: string;
  evidence:    HeldIntroEvidence[];
  /** The subject's domain Matchy already settled on, if any. */
  introDomain: string | null;
  /** The project is in walkthrough: the approve route refuses until it goes live. */
  walkthrough: boolean;
  /** ISO 8601. When the engagement last changed, which for a held intro is when it was held. */
  heldAt:      string;
}

export const HELD_INTROS_DEFAULT_LIMIT = 100;
export const HELD_INTROS_MAX_LIMIT     = 200;

// ─── Pure ─────────────────────────────────────────────────────────────────────

/** Waiting on a person: drafted, and Matchy has no line it trusts. */
export function isHeldIntro(pe: Pick<ProjectExpert, 'status' | 'introNeedsWhyThem'>): boolean {
  return pe.status === 'outreach_drafted' && pe.introNeedsWhyThem === true;
}

function linkOrNull(url: string | undefined | null): string | null {
  const text = (url ?? '').trim();
  return /^https?:\/\/\S+$/i.test(text) ? text : null;
}

function evidenceOf(items: readonly EvidenceItem[] | undefined): HeldIntroEvidence[] {
  return (items ?? [])
    .filter(item => typeof item.claim === 'string' && item.claim.trim())
    .map(item => ({
      claim:       item.claim.trim(),
      sourceLabel: (item.sourceLabel ?? '').trim(),
      sourceUrl:   linkOrNull(item.sourceUrl),
    }));
}

/**
 * One queue item, or null when the engagement is not held. Pure, so the shape
 * staff see is pinned by scripts/test-held-intros.ts.
 */
export function heldIntroFrom(
  project:  { id: string; name: string; walkthrough: boolean },
  pe:       ProjectExpert,
  heldAtMs: number,
): HeldIntro | null {
  if (!isHeldIntro(pe) || !pe.expert?.id) return null;
  const expert = pe.expert;
  return {
    projectId:   project.id,
    projectName: project.name,
    expertId:    expert.id,
    name:        expert.name ?? '',
    title:       expert.title ?? '',
    company:     expert.company ?? '',
    location:    expert.location ?? '',
    sourceUrl:   linkOrNull(expert.source_url),
    sourceLabel: (expert.source_label ?? '').trim(),
    evidence:    evidenceOf(expert.evidenceItems),
    introDomain: pe.introDomain?.trim() || null,
    walkthrough: project.walkthrough,
    heldAt:      new Date(Number.isFinite(heldAtMs) ? heldAtMs : 0).toISOString(),
  };
}

/** Newest first; ties keep a stable order by project then expert. */
export function sortHeldIntros(items: HeldIntro[]): HeldIntro[] {
  return [...items].sort((a, b) =>
    b.heldAt.localeCompare(a.heldAt)
    || a.projectId.localeCompare(b.projectId)
    || a.expertId.localeCompare(b.expertId));
}

export function clampHeldIntroLimit(raw: string | null | undefined): number {
  const parsed = raw ? Number.parseInt(raw, 10) : HELD_INTROS_DEFAULT_LIMIT;
  if (!Number.isFinite(parsed) || parsed <= 0) return HELD_INTROS_DEFAULT_LIMIT;
  return Math.min(parsed, HELD_INTROS_MAX_LIMIT);
}

// ─── Lookup ───────────────────────────────────────────────────────────────────

/**
 * Every held intro, newest first. Throws on a database error so the route can
 * answer 500 and the page can offer "Try again"; an empty queue and a broken
 * one must not look the same to the person clearing it.
 */
export async function listHeldIntros(limit = HELD_INTROS_DEFAULT_LIMIT): Promise<HeldIntro[]> {
  const db = getServiceRoleClient();
  if (!db) return listHeldIntrosFromStore(limit);

  // `introNeedsWhyThem` rides in project_experts.data (lib/projectStore,
  // PROMOTED_EXPERT_KEYS), so it is filtered on the jsonb key; `status` is a
  // real column.
  const { data: rows, error } = await db
    .from('project_experts')
    .select('project_id, expert_id, status, data, updated_at')
    .eq('status', 'outreach_drafted')
    .filter('data->>introNeedsWhyThem', 'eq', 'true')
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`held intros read failed: ${error.message.slice(0, 80)}`);
  if (!rows || rows.length === 0) return [];

  const projectIds = Array.from(new Set(rows.map(row => row.project_id)));
  const { data: projects, error: projectError } = await db
    .from('projects')
    .select('id, name, brief')
    .in('id', projectIds);
  if (projectError) throw new Error(`held intro projects read failed: ${projectError.message.slice(0, 80)}`);

  const projectById = new Map((projects ?? []).map(p => [p.id, {
    id:          p.id,
    name:        p.name,
    walkthrough: isWalkthrough(briefWalkthrough(p.brief)),
  }]));

  const items: HeldIntro[] = [];
  for (const row of rows) {
    const project = projectById.get(row.project_id);
    if (!project) continue;
    const data = (row.data ?? {}) as unknown as Omit<ProjectExpert, 'status' | 'contactEmail'>;
    const pe: ProjectExpert = { ...data, status: row.status as ProjectExpert['status'] };
    const item = heldIntroFrom(project, pe, Date.parse(row.updated_at));
    if (item) items.push(item);
  }
  return sortHeldIntros(items);
}

/** `projects.brief` is jsonb; walkthrough is the one key this needs from it. */
function briefWalkthrough(brief: Json): Pick<Project, 'walkthrough'> {
  if (brief && typeof brief === 'object' && !Array.isArray(brief)) {
    const value = (brief as Record<string, unknown>).walkthrough;
    return { walkthrough: typeof value === 'boolean' ? value : undefined };
  }
  return { walkthrough: undefined };
}

/**
 * Local development without Supabase: the in-memory store has no query
 * language, so walk it. Never reached in production (the store itself refuses
 * to start there without Supabase).
 */
async function listHeldIntrosFromStore(limit: number): Promise<HeldIntro[]> {
  const summaries = await listProjects();
  const items: HeldIntro[] = [];
  for (const summary of summaries) {
    const project = await getProject(summary.id);
    if (!project) continue;
    const meta = { id: project.id, name: project.name, walkthrough: isWalkthrough(project) };
    for (const pe of project.experts) {
      const item = heldIntroFrom(meta, pe, pe.updatedAt);
      if (item) items.push(item);
    }
  }
  return sortHeldIntros(items).slice(0, limit);
}
