// Zoom meeting → project + expert lookup.
//
// The Zoom webhook fires twice per call (meeting.started, meeting.ended) and
// only knows the meeting id. The old resolution was a full listProjects() scan
// with a getProject() per project — every project loaded from Postgres on every
// event. This asks the database instead.
//
// Where the meeting id lives: `project_experts.data->>zoomMeetingId`. Only
// `status` and `contact_email` are promoted to real columns (PROMOTED_EXPERT_KEYS
// in lib/projectStore.ts); every other ProjectExpert field — zoomMeetingId
// included, written as a string by lib/createZoomMeeting.ts — is stored in the
// `data` JSON blob.
//
// The scan is kept as a fallback for the case where the JSON filter errors
// (an unexpected PostgREST rejection, or the in-memory dev store, which has no
// database behind it at all).
//
// NEVER log: expert names, project names, meeting topics. Meeting ids are safe.

import { getProject, listProjects } from './projectStore';
import { getServiceRoleClient } from './supabase/admin';

export interface ZoomExpertRef {
  projectId: string;
  expertId:  string;
}

/** Fallback: the original O(n) scan over every project. Small n by design. */
async function scanForMeetingId(meetingId: string): Promise<ZoomExpertRef | null> {
  const summaries = await listProjects();
  for (const summary of summaries) {
    const project = await getProject(summary.id);
    if (!project) continue;
    for (const pe of project.experts) {
      if (pe.zoomMeetingId === meetingId) {
        return { projectId: project.id, expertId: pe.expert.id };
      }
    }
  }
  return null;
}

/**
 * The project + expert whose scheduled call carries this Zoom meeting id, or
 * null when no expert has it. Never throws.
 */
export async function findProjectExpertByZoomMeetingId(
  meetingId: string,
): Promise<ZoomExpertRef | null> {
  if (!meetingId) return null;

  const db = getServiceRoleClient();
  if (db) {
    try {
      const { data, error } = await db
        .from('project_experts')
        .select('project_id, expert_id')
        .filter('data->>zoomMeetingId', 'eq', meetingId)
        .limit(1);

      if (!error) {
        // The query is authoritative: no row means no such meeting. Falling back
        // to a scan here would just repeat the work the index already did.
        const hit = data?.[0];
        return hit ? { projectId: hit.project_id, expertId: hit.expert_id } : null;
      }
      console.error('[zoomLookup] meeting query failed:', error.message.slice(0, 120));
    } catch (err) {
      console.error('[zoomLookup] meeting query error:',
        err instanceof Error ? err.message.slice(0, 120) : String(err));
    }
  }

  try {
    return await scanForMeetingId(meetingId);
  } catch (err) {
    console.error('[zoomLookup] scan failed:',
      err instanceof Error ? err.message.slice(0, 120) : String(err));
    return null;
  }
}
