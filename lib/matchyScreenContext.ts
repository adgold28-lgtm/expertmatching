// lib/matchyScreenContext.ts — the two client-side names the compliance screen
// needs, loaded once per request.
//
// Shared by the client-write routes under
// app/api/projects/[projectId]/experts/[expertId]/messages/ (the send and the
// draft). Lived in messages/route.ts until the draft route needed it too; Next
// rejects non-handler exports from route files, so it moved here.
//
// Never logs: the firm name, the client's name, the email.

import { getFirm, getUser } from './firmStore';
import type { Project } from '../types';

export interface ScreenContext {
  clientFirmName: string | undefined;
  clientFullName: string | undefined;
}

/**
 * The firm name and the client's real name — the two things the compliance
 * screen needs to stop an identity crossing the wall. Best-effort on both: a
 * name we do not have is a check the screen cannot run, not a reason to fail.
 */
export async function loadScreenContext(project: Project, fallbackEmail: string): Promise<ScreenContext> {
  const firm = await getFirm(project.firmDomain).catch(() => null);

  let clientFullName = project.clientName?.trim() || undefined;
  if (!clientFullName) {
    const owner = await getUser(project.ownerEmail || fallbackEmail).catch(() => null);
    const parts = [owner?.firstName, owner?.lastName].filter(Boolean);
    if (parts.length > 0) clientFullName = parts.join(' ');
  }

  return {
    clientFirmName: firm?.name?.trim() || undefined,
    clientFullName,
  };
}
