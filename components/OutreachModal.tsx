'use client';

import { useEffect, useState } from 'react';
import { Expert } from '../types';

interface Props {
  expert: Expert;
  query: string;
  onClose: () => void;
}

export default function OutreachModal({ expert, query, onClose }: Props) {
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    async function generate() {
      try {
        const res = await fetch('/api/generate-outreach', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expert, query }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        setMessage(data.message);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to generate outreach');
      } finally {
        setLoading(false);
      }
    }
    generate();
  }, [expert, query]);

  function handleCopy() {
    navigator.clipboard.writeText(message);
    setCopied(true);
    setTimeout(() => setCopied(false), 2200);
  }

  const lines = message.split('\n');
  const subjectLine = lines[0]?.startsWith('Subject:') ? lines[0].replace('Subject: ', '') : null;
  const body = subjectLine ? lines.slice(2).join('\n') : message;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6 animate-fade-in"
      style={{ background: 'rgba(11,31,59,0.55)' }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="bg-white w-full sm:max-w-2xl max-h-[92vh] flex flex-col animate-slide-up"
        style={{ border: '1px solid #DDE2E8', borderTop: '3px solid #C6A75E' }}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-7 py-5 border-b border-[#DDE2E8]">
          <div>
            <h2 className="font-display text-xl font-semibold text-navy tracking-wide">
              Outreach Draft
            </h2>
            <p className="text-xs text-muted mt-1">
              {expert.name} · {expert.title}, {expert.company}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:text-navy transition-colors p-1 mt-0.5"
            aria-label="Close"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-7 py-6">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16 gap-5">
              <div className="relative w-10 h-10">
                <div className="absolute inset-0 rounded-full border-2 border-[#DDE2E8]" />
                <div className="absolute inset-0 rounded-full border-2 border-navy border-t-transparent animate-spin-slow" />
              </div>
              <div className="text-center">
                <p className="text-sm text-ink font-medium">Composing message...</p>
                <p className="text-xs text-muted mt-1">Calibrating to {expert.name.split(' ')[0]}&apos;s profile</p>
              </div>
            </div>
          ) : error ? (
            <div className="border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
          ) : (
            <div className="space-y-5">
              {subjectLine && (
                <div>
                  <p className="text-[10px] uppercase tracking-widest text-muted font-medium mb-2">Subject Line</p>
                  <div className="border-l-2 border-gold pl-4 py-1">
                    <p className="text-sm font-medium text-navy">{subjectLine}</p>
                  </div>
                </div>
              )}
              <div>
                <p className="text-[10px] uppercase tracking-widest text-muted font-medium mb-3">Message</p>
                <p className="text-sm text-ink leading-relaxed whitespace-pre-line" style={{ fontWeight: 300 }}>
                  {body}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        {!loading && !error && (
          <div className="px-7 py-5 border-t border-[#DDE2E8] flex gap-3">
            <button
              onClick={handleCopy}
              className="flex-1 bg-navy hover:bg-navy-light text-cream text-xs font-medium uppercase tracking-widest py-3 transition-colors flex items-center justify-center gap-2"
              style={{ letterSpacing: '0.12em' }}
            >
              {copied ? (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  Copied
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  Copy to Clipboard
                </>
              )}
            </button>
            <button
              onClick={onClose}
              className="px-5 py-3 text-xs font-medium text-muted hover:text-navy uppercase tracking-widest border border-[#DDE2E8] hover:border-navy transition-colors"
              style={{ letterSpacing: '0.12em' }}
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
