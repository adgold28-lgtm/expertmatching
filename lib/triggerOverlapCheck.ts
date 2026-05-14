// Compute the availability overlap between an expert and the project client,
// store the result on ProjectExpert, and create a calendar invite if found.
//
// Never throws — all errors are caught and logged without PII.
// Never logs: names, emails, project content, slot details.

import { getProject, updateExpertStatus, updateProjectFields } from './projectStore';
import { computeOverlap }       from './computeOverlap';
import { fetchCalendlySlots }   from './fetchCalendlySlots';
import { fetchGoogleFreebusy }  from './fetchGoogleFreebusy';
import type { AvailabilitySlot } from '../types';

// ─── Timezone extraction ──────────────────────────────────────────────────────

function extractTimezone(slots: AvailabilitySlot[]): string {
  return slots.find(s => s.timezone)?.timezone ?? 'UTC';
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function triggerOverlapCheck(
  projectId: string,
  expertId:  string,
): Promise<void> {
  try {
    // ── 1. Load project ──────────────────────────────────────────────────
    const project = await getProject(projectId);
    if (!project) {
      console.error('[triggerOverlapCheck] project not found', { projectId });
      return;
    }

    // ── 2. Find the project expert ───────────────────────────────────────
    const pe = project.experts.find(e => e.expert.id === expertId);
    if (!pe) {
      console.error('[triggerOverlapCheck] expert not found in project');
      return;
    }

    // ── 3. Get expert slots ──────────────────────────────────────────────
    let expertSlots: AvailabilitySlot[] = [];

    if (pe.calendarProvider === 'google' && pe.calendarAccessToken && pe.calendarRefreshToken && pe.calendarEmail) {
      expertSlots = await fetchGoogleFreebusy(
        pe.calendarAccessToken,
        pe.calendarRefreshToken,
        pe.calendarEmail,
        14,
        async (newToken, newExpiry) => {
          await updateExpertStatus(projectId, expertId, {
            calendarAccessToken: newToken,
            calendarTokenExpiry: newExpiry,
          });
        },
      );
    } else if (pe.calendarProvider === 'calendly' && pe.calendlyUrl) {
      expertSlots = await fetchCalendlySlots(pe.calendlyUrl);
    } else {
      expertSlots = pe.availabilitySlots ?? [];
    }

    // ── 4. Get client slots ──────────────────────────────────────────────
    let clientSlots: AvailabilitySlot[] = [];

    if (project.clientCalendarProvider === 'google' &&
        project.clientCalendarAccessToken && project.clientCalendarRefreshToken && project.clientCalendarEmail) {
      clientSlots = await fetchGoogleFreebusy(
        project.clientCalendarAccessToken,
        project.clientCalendarRefreshToken,
        project.clientCalendarEmail,
        14,
        async (newToken) => {
          await updateProjectFields(projectId, { clientCalendarAccessToken: newToken });
        },
      );
    } else if (project.clientCalendarProvider === 'calendly' && project.clientCalendlyUrl) {
      clientSlots = await fetchCalendlySlots(project.clientCalendlyUrl);
    } else {
      clientSlots = project.clientAvailabilitySlots ?? [];
    }

    if (expertSlots.length === 0 || clientSlots.length === 0) {
      console.log('[triggerOverlapCheck] insufficient slots for overlap', { projectId });
      await updateExpertStatus(projectId, expertId, {
        overlapResult:    null,
        overlapCheckedAt: Date.now(),
      });
      return;
    }

    // ── 5. Determine timezones ───────────────────────────────────────────
    const expertTimezone = extractTimezone(expertSlots);
    const clientTimezone = extractTimezone(clientSlots);

    // ── 6. Compute overlap ───────────────────────────────────────────────
    const result = await computeOverlap(expertSlots, clientSlots, expertTimezone, clientTimezone);

    // ── 7. Store result on ProjectExpert ─────────────────────────────────
    await updateExpertStatus(projectId, expertId, {
      overlapResult:    result.bestSlot ?? null,
      overlapCheckedAt: Date.now(),
    });

    console.log('[triggerOverlapCheck] overlap computed', {
      projectId,
      found:     result.found,
      slotCount: result.slots.length,
    });

    // ── 8. Act on result ─────────────────────────────────────────────────
    if (result.found && result.bestSlot) {
      try {
        const { createCalendarInvite } = await import('./createCalendarInvite');
        await createCalendarInvite(projectId, expertId, result.bestSlot);
      } catch (err) {
        console.error('[triggerOverlapCheck] createCalendarInvite failed:',
          err instanceof Error ? err.message.slice(0, 120) : 'unknown');
      }
    } else {
      // No overlap found — log only, no PII
      console.log('[triggerOverlapCheck] no overlap found for project', { projectId });
      // Stub: in production, send a "no common time" email to both parties
    }

  } catch (err) {
    // Never throw — just log the error class/message without PII
    console.error('[triggerOverlapCheck] unexpected error:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
  }
}
