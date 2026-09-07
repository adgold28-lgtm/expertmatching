'use client';

// Conversations — the client's half of the relay. Left: every expert the
// client has bookmarked, with the stage and an unread dot. Right: the thread.
// Above both, the two project settings that govern what Matchy does on its own.
//
// This tab replaces Outreach and Screen for clients (docs/MATCHY_SPEC.md,
// "UI"). Staff keep those tabs; nothing here is staff-only except the settings
// strip, which is owner-or-staff because only an owner may send.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project, ProjectExpert } from '../types';
import { CLIENT_STATUS_META, hasConversation } from './matchyStatus';
import ConversationThread from './ConversationThread';
import MatchySettingsStrip from './MatchySettingsStrip';
import MatchyLine from './MatchyLine';

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  projectId:       string;
  project:         Project;
  /** Owner or staff — the only people who may send to an expert. */
  canSend:         boolean;
  /**
   * Thread to open on mount and whenever it changes — set by "Open" on a card
   * in Matches. Ignored when the expert has no thread; the first one wins then.
   */
  selectedExpertId?: string;
  onExpertUpdate:  (updated: ProjectExpert) => void;
  onProjectUpdate: (project: Project) => void;
  /** Sends the client back to Matches from the empty state. */
  onGoToMatches:   () => void;
}

// ─── "Last opened" memory ─────────────────────────────────────────────────────
//
// Per browser, per project: expertId → unix ms of the last time this viewer
// opened that thread. Only drives the unread dot, so a blocked or cleared
// store costs nothing but an extra dot.

type OpenedMap = Record<string, number>;

const openedKey = (projectId: string) => `expertmatch.threads.opened.${projectId}`;

function readOpened(projectId: string): OpenedMap {
  try {
    const raw = window.localStorage.getItem(openedKey(projectId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: OpenedMap = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[id] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writeOpened(projectId: string, map: OpenedMap): void {
  try {
    window.localStorage.setItem(openedKey(projectId), JSON.stringify(map));
  } catch {
    // Storage blocked — the dot just stays until the page reloads.
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ConversationsPanel({
  projectId,
  project,
  canSend,
  selectedExpertId,
  onExpertUpdate,
  onProjectUpdate,
  onGoToMatches,
}: Props) {
  const threads = useMemo(
    () => project.experts
      .filter(pe => hasConversation(pe.status))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
    [project.experts],
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [opened,     setOpened]     = useState<OpenedMap>({});
  // Newest inbound message per expert, learned when a thread is read. Layered
  // on top of `replyDetectedAt` so the dot is right even for relayed messages
  // that never set that field.
  const [inboundAt,  setInboundAt]  = useState<Record<string, number>>({});

  // Reading storage during render would desync the server-rendered markup.
  useEffect(() => { setOpened(readOpened(projectId)); }, [projectId]);

  // Open the first thread once there is one, and never strand the pane on an
  // expert that has left the cohort.
  useEffect(() => {
    if (threads.length === 0) { setSelectedId(null); return; }
    setSelectedId(prev => (prev && threads.some(t => t.expert.id === prev)) ? prev : threads[0].expert.id);
  }, [threads]);

  // A request from outside ("Open" on a card in Matches) wins over the default
  // first thread — but only once per id, so a later click in the list or a
  // project refresh does not snap the pane back.
  const appliedRequest = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!selectedExpertId) { appliedRequest.current = undefined; return; }
    if (appliedRequest.current === selectedExpertId) return;
    if (!threads.some(t => t.expert.id === selectedExpertId)) return;
    appliedRequest.current = selectedExpertId;
    setSelectedId(selectedExpertId);
  }, [selectedExpertId, threads]);

  const markOpened = useCallback((expertId: string) => {
    setOpened(prev => {
      const next = { ...prev, [expertId]: Date.now() };
      writeOpened(projectId, next);
      return next;
    });
  }, [projectId]);

  // Opening a thread clears its dot.
  useEffect(() => {
    if (selectedId) markOpened(selectedId);
  }, [selectedId, markOpened]);

  const handleInboundSeen = useCallback((expertId: string, ms: number) => {
    setInboundAt(prev => (prev[expertId] === ms ? prev : { ...prev, [expertId]: ms }));
  }, []);

  function isUnread(pe: ProjectExpert): boolean {
    const latest = Math.max(pe.replyDetectedAt ?? 0, inboundAt[pe.expert.id] ?? 0);
    if (latest === 0) return false;
    return latest > (opened[pe.expert.id] ?? 0);
  }

  const selected = threads.find(t => t.expert.id === selectedId) ?? null;

  return (
    <div className="space-y-5">

      {/* ── Project settings (owner / staff) ── */}
      {canSend && (
        <MatchySettingsStrip projectId={projectId} project={project} onUpdate={onProjectUpdate} />
      )}

      {threads.length === 0 ? (
        <div className="py-14 max-w-md mx-auto space-y-4 text-center">
          <MatchyLine variant="card" tone="quiet" className="text-left">
            No conversations yet. Bookmark someone in Matches and I&apos;ll write to them.
          </MatchyLine>
          <button
            type="button"
            onClick={onGoToMatches}
            className="text-xs text-muted hover:text-navy underline underline-offset-2"
          >
            Go to Matches
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(220px,280px)_1fr] gap-5 items-start">

          {/* ── Left: the list ── */}
          <div className="border border-frame bg-surface divide-y divide-frame max-h-[640px] overflow-y-auto">
            {threads.map(pe => {
              const pill     = CLIENT_STATUS_META[pe.status];
              const active   = pe.expert.id === selectedId;
              const unread   = isUnread(pe);
              return (
                <button
                  key={pe.expert.id}
                  type="button"
                  onClick={() => setSelectedId(pe.expert.id)}
                  aria-current={active}
                  className={`w-full text-left px-3.5 py-3 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-gold ${
                    active ? 'bg-cream' : 'hover:bg-cream/60'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {unread
                      ? <span aria-label="Unread reply" className="shrink-0 w-1.5 h-1.5 rounded-full bg-gold" />
                      : <span aria-hidden className="shrink-0 w-1.5 h-1.5" />}
                    <p className={`text-[12px] truncate ${active ? 'text-navy font-medium' : 'text-ink'}`}>
                      {pe.expert.name}
                    </p>
                  </div>
                  <div className="pl-3.5 mt-1">
                    <span className={`inline-block text-[9px] px-1.5 py-0.5 border font-medium uppercase tracking-wider ${pill.classes}`}>
                      {pill.label}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>

          {/* ── Right: the thread ── */}
          {selected && (
            <ConversationThread
              key={selected.expert.id}
              projectId={projectId}
              projectExpert={selected}
              canSend={canSend}
              onExpertUpdate={onExpertUpdate}
              onInboundSeen={handleInboundSeen}
            />
          )}
        </div>
      )}
    </div>
  );
}
