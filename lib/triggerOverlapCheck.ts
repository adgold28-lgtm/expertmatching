// Compute the availability overlap between an expert and the project client,
// store the result on ProjectExpert, and create a calendar invite if found.
//
// Never throws — all errors are caught and logged without PII.
// Never logs: names, emails, project content, slot details.

import { getProject, updateExpertStatus, updateProjectFields } from './projectStore';
import { computeOverlap }       from './computeOverlap';
import { fetchCalendlySlots }   from './fetchCalendlySlots';
import { fetchGoogleFreebusy }  from './fetchGoogleFreebusy';
import { createZoomMeeting }    from './createZoomMeeting';
import { generateIcs }          from './generateIcs';
import { sendConfirmationEmail } from './sendAvailabilityRequest';
import type { AvailabilitySlot } from '../types';
import { randomBytes }          from 'crypto';

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
      const slot = result.bestSlot;
      try {
        const durationMin = slot.durationMin ?? 60;

        // Create Zoom meeting
        const zoomMeeting = await createZoomMeeting(
          `Expert Call — ${project.name}`,
          slot.startUtc,
          durationMin,
          pe.expert.name,
        );

        // Build end time from start + duration
        const startMs = new Date(slot.startUtc).getTime();
        const endUtc  = new Date(startMs + durationMin * 60 * 1000).toISOString();

        const joinUrl = zoomMeeting?.joinUrl ?? 'Video call — link to follow';
        const uid     = randomBytes(16).toString('hex');

        // Update ProjectExpert with scheduled status + Zoom details
        await updateExpertStatus(projectId, expertId, {
          status:          'scheduled',
          scheduledTime:   slot.startExpert,
          ...(zoomMeeting ? {
            zoomMeetingId: zoomMeeting.meetingId,
            zoomJoinUrl:   zoomMeeting.joinUrl,
            zoomStartUrl:  zoomMeeting.startUrl,
          } : {}),
        });

        // Generate .ics and send confirmation to both parties
        try {
          const attendees = [
            pe.contactEmail,
            project.clientEmail,
          ].filter((e): e is string => typeof e === 'string' && e.trim().length > 0);

          const organizer = process.env.OUTREACH_FROM_EMAIL?.match(/<(.+)>/)?.[1]
            ?? process.env.OUTREACH_FROM_EMAIL
            ?? 'asher@expertmatch.fit';

          const description = [
            `Expert: ${pe.expert.name}, ${pe.expert.title} at ${pe.expert.company}`,
            '',
            zoomMeeting ? `Join Zoom: ${zoomMeeting.joinUrl}` : '',
            zoomMeeting ? `Meeting ID: ${zoomMeeting.meetingId}` : '',
          ].filter(l => l.length > 0).join('\\n');

          generateIcs({
            title:       `Expert Call — ${project.name}`,
            startUtc:    slot.startUtc,
            endUtc,
            description,
            location:    joinUrl,
            organizer,
            attendees,
            uid,
          });

          if (pe.contactEmail && project.clientEmail) {
            await sendConfirmationEmail(
              pe.contactEmail,
              project.clientEmail,
              {
                title:       `Expert Call — ${project.name}`,
                startUtc:    slot.startUtc,
                endUtc,
                description,
                location:    joinUrl,
                organizer,
                attendees,
                uid,
              },
              pe.expert.name,
              project.clientName ?? 'Client',
            );
          }
        } catch (icsErr) {
          console.error('[triggerOverlapCheck] ICS/confirmation error:',
            icsErr instanceof Error ? icsErr.message.slice(0, 120) : 'unknown');
          // Non-fatal — meeting is already created and status updated
        }

        console.log('[triggerOverlapCheck] scheduled and ICS sent', { projectId, status: 'ok' });
      } catch (err) {
        console.error('[triggerOverlapCheck] scheduling failed:',
          err instanceof Error ? err.message.slice(0, 120) : 'unknown');
      }
    } else {
      // No overlap found — log only, no PII
      console.log('[triggerOverlapCheck] no overlap found for project', { projectId });
    }

  } catch (err) {
    // Never throw — just log the error class/message without PII
    console.error('[triggerOverlapCheck] unexpected error:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
  }
}
