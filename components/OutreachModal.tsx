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
    setTimeout(() => setCopied(false), 2000);
  }

  // Parse subject line from message
  const lines = message.split('\n');
  const subjectLine = lines[0]?.startsWith('Subject:') ? lines[0] : null;
  const body = subjectLine ? lines.slice(2).join('\n') : message;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-fade-in"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col animate-slide-up">
        {/* Header */}
        <div className="flex items-start justify-between p-6 border-b border-gray-100">
          <div>
            <h2 className="font-semibold text-gray-900 text-lg">Outreach Message</h2>
            <p className="text-sm text-gray-500 mt-0.5">
              To {expert.name} · {expert.title} at {expert.company}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors p-1 rounded-lg hover:bg-gray-100"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-12 gap-4">
              <div className="relative w-12 h-12">
                <div className="absolute inset-0 rounded-full border-4 border-violet-100"></div>
                <div className="absolute inset-0 rounded-full border-4 border-violet-600 border-t-transparent animate-spin"></div>
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-gray-700">Crafting your message...</p>
                <p className="text-xs text-gray-500 mt-1">Personalizing for {expert.name}&apos;s background</p>
              </div>
            </div>
          ) : error ? (
            <div className="bg-red-50 text-red-700 rounded-xl p-4 text-sm">{error}</div>
          ) : (
            <div className="space-y-4">
              {subjectLine && (
                <div className="bg-violet-50 border border-violet-100 rounded-xl p-3">
                  <p className="text-xs font-semibold text-violet-500 uppercase tracking-wide mb-1">Subject Line</p>
                  <p className="text-sm font-medium text-violet-900">{subjectLine.replace('Subject: ', '')}</p>
                </div>
              )}
              <div className="bg-gray-50 border border-gray-100 rounded-xl p-4">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Message Body</p>
                <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-line">{body}</p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        {!loading && !error && (
          <div className="p-6 border-t border-gray-100 flex gap-3">
            <button
              onClick={handleCopy}
              className="flex-1 bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium py-2.5 px-4 rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              {copied ? (
                <>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  Copied!
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  Copy Message
                </>
              )}
            </button>
            <button
              onClick={onClose}
              className="px-4 py-2.5 text-sm font-medium text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded-xl transition-colors"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
