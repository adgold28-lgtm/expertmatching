'use client';

// Client scheduling section for the Deliver tab.
// Manages client email/name capture, availability request, and status display.
// Never logs: client email, name, or token data.

import { useState } from 'react';
import type { Project } from '../types';

interface Props {
  projectId:       string;
  project:         Project;
  onProjectUpdate: (updated: Project) => void;
}

export default function ClientSchedulingSection({ projectId, project, onProjectUpdate }: Props) {
  const [email,    setEmail]    = useState(project.clientEmail    ?? '');
  const [name,     setName]     = useState(project.clientName     ?? '');
  const [saving,   setSaving]   = useState(false);
  const [saveErr,  setSaveErr]  = useState('');
  const [saved,    setSaved]    = useState(false);
  const [sending,  setSending]  = useState(false);
  const [sendErr,  setSendErr]  = useState('');
  const [sent,     setSent]     = useState(false);

  const hasClientSaved = !!(project.clientEmail);
  const hasRequested   = !!(project.clientAvailabilityTokenHash);
  const hasSubmitted   = !!(project.clientAvailabilitySubmitted);

  const labelClass = 'block text-[10px] uppercase tracking-widest text-muted font-medium mb-1.5';
  const inputClass = 'w-full px-3 py-2.5 text-sm border border-frame bg-cream focus:outline-none focus:border-navy text-ink';

  async function handleSave() {
    setSaving(true);
    setSaveErr('');
    setSaved(false);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ clientEmail: email.trim(), clientName: name.trim() }),
      });
      const data = await res.json() as { project?: Project; error?: string };
      if (!res.ok || !data.project) {
        setSaveErr(data.error ?? 'Failed to save. Please try again.');
        return;
      }
      onProjectUpdate(data.project);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      setSaveErr('Network error. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function handleRequestAvailability() {
    setSending(true);
    setSendErr('');
    setSent(false);
    try {
      const res = await fetch(`/api/projects/${projectId}/request-client-availability`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          clientEmail: project.clientEmail,
          clientName:  project.clientName,
        }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        const msg = data.error === 'rate_limited'
          ? 'Too many requests. Please wait an hour and try again.'
          : (data.error ?? 'Failed to send. Please try again.');
        setSendErr(msg);
        return;
      }
      // Optimistically reflect the sent state
      onProjectUpdate({
        ...project,
        clientAvailabilitySubmitted: false,
      });
      setSent(true);
    } catch {
      setSendErr('Network error. Please try again.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="border border-frame bg-cream p-6 space-y-5">
      <div>
        <p className="text-[10px] uppercase tracking-widest text-navy font-semibold mb-0.5" style={{ letterSpacing: '0.16em' }}>
          Client Scheduling
        </p>
        <p className="text-[11px] text-muted leading-relaxed">
          Collect the client&apos;s availability, then match it against expert slots to find a call time.
        </p>
      </div>

      {/* State 1: no client email saved — show input form */}
      {!hasClientSaved && (
        <div className="space-y-4">
          <div>
            <label className={labelClass}>Client Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Sarah Johnson"
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Client Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="client@company.com"
              className={inputClass}
            />
          </div>
          {saveErr && <p className="text-xs text-red-600">{saveErr}</p>}
          <div className="flex items-center gap-3">
            <button
              onClick={handleSave}
              disabled={saving || !email.trim() || !name.trim()}
              className="bg-navy text-cream text-[10px] uppercase tracking-widest px-4 py-2 hover:bg-navy/90 disabled:opacity-40 transition-colors"
              style={{ letterSpacing: '0.12em' }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            {saved && <span className="text-[10px] text-green-700">Saved ✓</span>}
          </div>
        </div>
      )}

      {/* State 2: email saved, not yet requested */}
      {hasClientSaved && !hasRequested && !sent && (
        <div className="space-y-4">
          <div className="flex items-center gap-4 text-sm">
            <div>
              <span className="text-[10px] uppercase tracking-widest text-muted" style={{ letterSpacing: '0.1em' }}>Client</span>
              <p className="text-navy font-medium mt-0.5">{project.clientName}</p>
              <p className="text-muted text-xs">{project.clientEmail}</p>
            </div>
            <button
              onClick={() => { onProjectUpdate({ ...project, clientEmail: null, clientName: null }); }}
              className="text-[10px] text-muted hover:text-red-600 underline ml-auto"
            >
              Edit
            </button>
          </div>
          {sendErr && <p className="text-xs text-red-600">{sendErr}</p>}
          <button
            onClick={handleRequestAvailability}
            disabled={sending}
            className="bg-navy text-cream text-[10px] uppercase tracking-widest px-4 py-2 hover:bg-navy/90 disabled:opacity-40 transition-colors"
            style={{ letterSpacing: '0.12em' }}
          >
            {sending ? 'Sending…' : 'Request Client Availability'}
          </button>
        </div>
      )}

      {/* State 3: requested / sent — awaiting response */}
      {(hasRequested || sent) && !hasSubmitted && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-amber-400" />
            <p className="text-sm text-amber-700 font-medium">Requested — awaiting response</p>
          </div>
          <p className="text-[11px] text-muted">
            Availability request sent to <span className="text-navy">{project.clientName}</span>.
            This page will update once they submit.
          </p>
          {sendErr && <p className="text-xs text-red-600">{sendErr}</p>}
          <button
            onClick={handleRequestAvailability}
            disabled={sending}
            className="text-[10px] uppercase tracking-widest text-muted border border-frame hover:border-navy hover:text-navy px-3 py-1.5 transition-colors"
            style={{ letterSpacing: '0.12em' }}
          >
            {sending ? 'Sending…' : 'Resend Request'}
          </button>
        </div>
      )}

      {/* State 4: submitted */}
      {hasSubmitted && (
        <div className="flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
          <p className="text-sm text-green-700 font-medium">&#x2713; Received — availability on file</p>
        </div>
      )}
    </div>
  );
}
