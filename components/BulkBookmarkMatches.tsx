'use client';

import { Fragment, useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { ProjectExpert } from '../types';
import {
  BULK_BOOKMARK_CONCURRENCY,
  isBulkBookmarkable,
  postBookmark,
  retryableIds,
  runBulkBookmark,
  summarizeBulkBookmark,
} from '../lib/bulkBookmark';

// -----------------------------------------------------------------------------
// The Matches grid, plus "Select" mode: the project owner (or staff) ticks
// several cards and bookmarks them in one go (launch pack, 2026-10-14; the
// founder's Test A needs 100 intros from two briefs).
//
// There is no bulk endpoint. Each expert goes through the SAME single
// bookmark route a card's own button uses, two at a time, so every gate on it
// (owner check, walkthrough, the card on file, the rate band, the
// do-not-contact lists) applies unchanged. lib/bulkBookmark.ts decides what
// each answer means: wait out a 429, skip a do-not-contact expert, stop when
// the account cannot reach experts. When a bookmark lands the card flips to
// "Bookmarked" exactly as a single click does (founder feedback 2026-09-09,
// item 4: one click and nothing after); the only words are the bar's progress
// and its one summary line at the end.
//
// The running batch lives in a small module-level store keyed by project, not
// in this component's state: switching to Conversations unmounts the Matches
// section, and the batch must neither restart nor vanish when the client
// comes back. Collaborators never see select mode (canSelect is false for
// them) and the route refuses them anyway.
// -----------------------------------------------------------------------------

/** What a card needs to take part in select mode. Spread onto ProjectExpertCard. */
export interface CardSelection {
  /** Show the checkbox: select mode is on and the card offers Bookmark. */
  selectable:     boolean;
  selected:       boolean;
  onToggleSelect: () => void;
  /** A batch is running: the card's own Bookmark and Pass wait for it. */
  locked:         boolean;
}

interface Props {
  projectId:      string;
  /** The cards on screen, filters and sort applied. */
  shown:          ProjectExpert[];
  /** Every expert on the project, so a selection survives a filter change. */
  all:            ProjectExpert[];
  /** Owner or staff. Collaborators read Matches and never see select mode. */
  canSelect:      boolean;
  onExpertUpdate: (updated: ProjectExpert) => void;
  /** Called once when a batch ends. */
  onBatchEnd?:    () => void;
  renderCard:     (pe: ProjectExpert, selection: CardSelection) => ReactNode;
}

// ─── The batch, per project, outside React ───────────────────────────────────

interface BatchState {
  running:  boolean;
  stopping: boolean;
  waiting:  boolean;
  done:     number;
  total:    number;
  summary:  string | null;
  /** Experts to leave selected when the batch ends: never reached, or didn't go through. */
  retry:    string[];
}

const IDLE: BatchState = { running: false, stopping: false, waiting: false, done: 0, total: 0, summary: null, retry: [] };

const batches   = new Map<string, BatchState>();
const cancelled = new Set<string>();
const listeners = new Set<() => void>();

function setBatch(projectId: string, next: BatchState): void {
  batches.set(projectId, next);
  listeners.forEach(listener => listener());
}

function patchBatch(projectId: string, patch: Partial<BatchState>): void {
  setBatch(projectId, { ...(batches.get(projectId) ?? IDLE), ...patch });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// ─── Styling, shared with the header's navy-and-gold ─────────────────────────

const BAR_BUTTON =
  'text-[10px] uppercase tracking-widest text-cream/80 hover:text-cream border border-cream/25 hover:border-cream/60 px-3 py-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-1 focus-visible:ring-gold';
const BAR_PRIMARY =
  'text-[10px] uppercase tracking-widest bg-gold text-navy font-semibold px-4 py-2 hover:bg-gold/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-1 focus-visible:ring-cream';

// ─── Component ────────────────────────────────────────────────────────────────

export default function BulkBookmarkMatches({
  projectId,
  shown,
  all,
  canSelect,
  onExpertUpdate,
  onBatchEnd,
  renderCard,
}: Props) {
  const batch = useSyncExternalStore(
    subscribe,
    () => batches.get(projectId) ?? IDLE,
    () => IDLE,
  );

  // Coming back to Matches mid-batch (or to its summary) reopens the bar.
  const [selectMode, setSelectMode] = useState(() => batch.running || batch.summary !== null);
  const [selected,   setSelected]   = useState<string[]>(() => batch.retry);

  const byId = useMemo(() => new Map(all.map(pe => [pe.expert.id, pe])), [all]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  // Only what can still be bookmarked counts: a card that flipped to
  // Bookmarked (here or in another tab) drops out of the batch on its own.
  const queue = selected.filter(id => {
    const pe = byId.get(id);
    return !!pe && isBulkBookmarkable(pe.status);
  });
  const shownBookmarkable = shown.filter(pe => isBulkBookmarkable(pe.status)).map(pe => pe.expert.id);
  const allShownSelected  = shownBookmarkable.length > 0 && shownBookmarkable.every(id => selectedSet.has(id));

  const active     = (canSelect && selectMode) || batch.running;
  const count      = queue.length;
  const progressed = batch.total > 0 ? Math.round((batch.done / batch.total) * 100) : 0;

  // Leaving the page mid-batch would drop the rest silently; ask first.
  useEffect(() => {
    if (!batch.running) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [batch.running]);

  const toggle = useCallback((expertId: string) => {
    if (batches.get(projectId)?.running) return;
    setSelected(prev => (prev.includes(expertId) ? prev.filter(id => id !== expertId) : [...prev, expertId]));
  }, [projectId]);

  function selectAllShown() {
    setSelected(prev => [...prev, ...shownBookmarkable.filter(id => !prev.includes(id))]);
  }

  function clearSelection() {
    setSelected([]);
  }

  function leaveSelectMode() {
    if (batch.running) return;
    setSelectMode(false);
    setSelected([]);
    setBatch(projectId, IDLE);
  }

  function stop() {
    cancelled.add(projectId);
    patchBatch(projectId, { stopping: true });
  }

  async function bookmarkSelected() {
    if (count === 0 || batches.get(projectId)?.running) return;

    const ids    = [...queue];
    const before = new Map(ids.map(id => [id, byId.get(id)]));
    cancelled.delete(projectId);
    setBatch(projectId, { ...IDLE, running: true, total: ids.length });

    const result = await runBulkBookmark(ids, {
      bookmarkOne:  expertId => postBookmark(projectId, expertId),
      concurrency:  BULK_BOOKMARK_CONCURRENCY,
      shouldCancel: () => cancelled.has(projectId),
      onWaiting:    waiting => patchBatch(projectId, { waiting }),
      onResult:     (item, done) => {
        patchBatch(projectId, { done });
        if (item.kind !== 'bookmarked') return;
        // The route answers with the expert as this viewer may see them, the
        // same object a single bookmark puts on the card.
        const prior = before.get(item.expertId);
        const next  = item.projectExpert
          ?? (prior ? { ...prior, status: 'bookmarked' as const, updatedAt: Date.now() } : null);
        if (next) onExpertUpdate(next);
      },
    });

    const retry = retryableIds(result);
    cancelled.delete(projectId);
    setBatch(projectId, {
      ...IDLE,
      done:    result.results.length,
      total:   result.total,
      summary: summarizeBulkBookmark(result),
      retry,
    });
    setSelected(retry);
    onBatchEnd?.();
  }

  const selectionFor = (pe: ProjectExpert): CardSelection => ({
    selectable:     active && canSelect && isBulkBookmarkable(pe.status),
    selected:       selectedSet.has(pe.expert.id),
    onToggleSelect: () => toggle(pe.expert.id),
    locked:         batch.running,
  });

  return (
    <div className="space-y-4">
      {/* The way in. Hidden from collaborators, and when nothing on screen can be bookmarked. */}
      {canSelect && !active && shownBookmarkable.length > 0 && (
        <div className="flex items-center justify-end gap-3 flex-wrap">
          <p className="text-[11px] text-muted" style={{ fontWeight: 300 }}>
            Bookmark several at once.
          </p>
          <button
            type="button"
            onClick={() => setSelectMode(true)}
            className="text-[10px] uppercase tracking-widest text-navy border border-navy/30 hover:border-navy px-3 py-1.5 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-gold"
            style={{ letterSpacing: '0.12em' }}
          >
            Select
          </button>
        </div>
      )}
      {active && !batch.running && (
        <p className="text-[11px] text-muted" style={{ fontWeight: 300 }}>
          Tick the experts worth a call, then bookmark them together.
        </p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
        {shown.map(pe => (
          <Fragment key={pe.expert.id}>{renderCard(pe, selectionFor(pe))}</Fragment>
        ))}
      </div>

      {/* Room under the last row so the bar never covers a card. */}
      {active && <div className="h-36 sm:h-20" aria-hidden="true" />}

      {active && (
        <div
          className="fixed inset-x-0 bottom-0 z-40 bg-navy border-t-2 border-gold"
          role="region"
          aria-label="Bookmark several experts"
        >
          <div className="max-w-6xl mx-auto px-4 sm:px-10 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex-1 min-w-0" aria-live="polite">
              {batch.running ? (
                <>
                  <p className="flex items-center gap-2 text-xs text-cream">
                    <span
                      className="inline-block w-3 h-3 border border-gold border-t-transparent rounded-full animate-spin shrink-0"
                      aria-hidden="true"
                    />
                    {batch.stopping
                      ? 'Stopping after the ones in progress…'
                      : `Bookmarking ${Math.min(batch.done + 1, batch.total)} of ${batch.total}`}
                    {batch.waiting && !batch.stopping && (
                      <span className="text-cream/60">· waiting a few seconds</span>
                    )}
                  </p>
                  <div className="mt-2 h-0.5 bg-cream/15" aria-hidden="true">
                    <div className="h-full bg-gold transition-all duration-300" style={{ width: `${progressed}%` }} />
                  </div>
                </>
              ) : (
                <>
                  {batch.summary && (
                    <p className="text-xs text-cream leading-relaxed">{batch.summary}</p>
                  )}
                  <p
                    className={`text-[10px] uppercase tracking-widest ${batch.summary ? 'text-gold/70 mt-1' : 'text-gold/90'}`}
                    style={{ letterSpacing: '0.14em' }}
                  >
                    {count === 0 ? 'None selected' : `${count} selected`}
                  </p>
                </>
              )}
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              {batch.running ? (
                <button type="button" onClick={stop} disabled={batch.stopping} className={BAR_BUTTON} style={{ letterSpacing: '0.12em' }}>
                  Stop
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={selectAllShown}
                    disabled={allShownSelected || shownBookmarkable.length === 0}
                    className={BAR_BUTTON}
                    style={{ letterSpacing: '0.12em' }}
                  >
                    Select all shown
                  </button>
                  <button
                    type="button"
                    onClick={clearSelection}
                    disabled={selected.length === 0}
                    className={BAR_BUTTON}
                    style={{ letterSpacing: '0.12em' }}
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    onClick={() => { void bookmarkSelected(); }}
                    disabled={count === 0}
                    className={BAR_PRIMARY}
                    style={{ letterSpacing: '0.12em' }}
                  >
                    {count > 0 ? `Bookmark ${count}` : 'Bookmark'}
                  </button>
                  <button
                    type="button"
                    onClick={leaveSelectMode}
                    className={BAR_BUTTON}
                    style={{ letterSpacing: '0.12em' }}
                  >
                    Done
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
