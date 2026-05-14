'use client';

// PDF export for project briefs.
// Zero LLM calls, zero external I/O — pure client-side rendering via @react-pdf/renderer.
// Call downloadProjectBriefPdf(project) from any event handler; it generates and downloads.

import React from 'react';
import {
  Document,
  Page,
  View,
  Text,
  StyleSheet,
  pdf,
} from '@react-pdf/renderer';
import type { Project } from '../types';

// ─── Colors ───────────────────────────────────────────────────────────────────

const C = {
  navy:   '#0f172a',
  teal:   '#0d9488',
  white:  '#ffffff',
  slate:  '#64748b',
  light:  '#f8fafc',
  border: '#e2e8f0',
  ink:    '#1e293b',
  muted:  '#94a3b8',
};

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  page: {
    fontFamily:      'Helvetica',
    backgroundColor: C.white,
    paddingBottom:   54,
  },

  // ── Header ──
  header: {
    backgroundColor:  C.navy,
    paddingHorizontal: 36,
    paddingTop:        26,
    paddingBottom:     20,
  },
  headerRow: {
    flexDirection:  'row',
    justifyContent: 'space-between',
    alignItems:     'flex-start',
  },
  wordmark: {
    color:        C.white,
    fontSize:     10,
    fontFamily:   'Helvetica-Bold',
    letterSpacing: 2.5,
  },
  headerRight: {
    alignItems: 'flex-end',
    maxWidth:   240,
  },
  projectName: {
    color:     C.muted,
    fontSize:  9,
    textAlign: 'right',
  },
  headerDate: {
    color:     '#475569',
    fontSize:  7.5,
    marginTop: 4,
  },

  // ── Body ──
  body: {
    paddingHorizontal: 36,
    paddingTop:        26,
  },

  // ── Section ──
  section: {
    marginBottom: 22,
  },
  sectionLabel: {
    fontSize:          7,
    color:             C.teal,
    fontFamily:        'Helvetica-Bold',
    letterSpacing:     1.8,
    marginBottom:      8,
    paddingBottom:     5,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },

  // ── Research question ──
  questionText: {
    fontSize:   11,
    color:      C.ink,
    lineHeight: 1.65,
  },

  // ── Summary pills ──
  pillRow: {
    flexDirection: 'row',
    marginBottom:  14,
  },
  pill: {
    marginRight: 18,
    alignItems:  'center',
  },
  pillCount: {
    fontSize:   20,
    fontFamily: 'Helvetica-Bold',
    color:      C.navy,
  },
  pillLabel: {
    fontSize:      7,
    color:         C.slate,
    letterSpacing: 0.6,
  },

  // ── Expert card ──
  expertRow: {
    marginBottom:    8,
    padding:         10,
    borderWidth:     1,
    borderColor:     C.border,
    backgroundColor: C.light,
  },
  expertTop: {
    flexDirection:  'row',
    justifyContent: 'space-between',
    alignItems:     'flex-start',
    marginBottom:   5,
  },
  expertLeft: {
    flex:        1,
    marginRight: 12,
  },
  expertName: {
    fontSize:   9.5,
    fontFamily: 'Helvetica-Bold',
    color:      C.navy,
  },
  expertMeta: {
    fontSize:  7.5,
    color:     C.slate,
    marginTop: 2,
  },
  expertRight: {
    alignItems: 'flex-end',
  },
  scoreHigh: {
    fontSize:   13,
    fontFamily: 'Helvetica-Bold',
    color:      '#15803d',
  },
  scoreMid: {
    fontSize:   13,
    fontFamily: 'Helvetica-Bold',
    color:      '#b45309',
  },
  scoreLow: {
    fontSize:   13,
    fontFamily: 'Helvetica-Bold',
    color:      C.slate,
  },
  conflictText: {
    fontSize:  6.5,
    color:     C.slate,
    marginTop: 3,
  },
  justification: {
    fontSize:   8,
    color:      C.ink,
    lineHeight: 1.55,
  },

  // ── Screening rows ──
  screenRow: {
    flexDirection:     'row',
    justifyContent:    'space-between',
    paddingVertical:   6,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  screenLeft: {
    flex:        1,
    marginRight: 12,
  },
  screenName: {
    fontSize:   8.5,
    fontFamily: 'Helvetica-Bold',
    color:      C.ink,
  },
  screenNotes: {
    fontSize:   7.5,
    color:      C.slate,
    marginTop:  2,
    lineHeight: 1.45,
  },
  screenVerdictPass: {
    fontSize:   7.5,
    fontFamily: 'Helvetica-Bold',
    color:      '#15803d',
    textAlign:  'right',
    width:      44,
  },
  screenVerdictFail: {
    fontSize:   7.5,
    fontFamily: 'Helvetica-Bold',
    color:      '#dc2626',
    textAlign:  'right',
    width:      44,
  },
  screenVerdictPending: {
    fontSize:  7.5,
    color:     C.slate,
    textAlign: 'right',
    width:     44,
  },

  // ── Outreach ──
  outreachGroup: {
    marginBottom: 10,
  },
  outreachStatus: {
    fontSize:      7,
    color:         C.teal,
    fontFamily:    'Helvetica-Bold',
    letterSpacing: 0.8,
    marginBottom:  4,
  },
  outreachExpert: {
    fontSize:     8.5,
    color:        C.ink,
    marginBottom: 3,
    marginLeft:   10,
  },

  // ── Footer ──
  footer: {
    position:          'absolute',
    bottom:            18,
    left:              36,
    right:             36,
    flexDirection:     'row',
    justifyContent:    'space-between',
    borderTopWidth:    1,
    borderTopColor:    C.border,
    paddingTop:        6,
  },
  footerText: {
    fontSize: 7,
    color:    C.slate,
  },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const OUTREACH_STATUSES = [
  'contact_found', 'outreach_drafted', 'contacted', 'replied', 'scheduled', 'completed',
] as const;

const OUTREACH_LABEL: Record<string, string> = {
  contact_found:    'Contact Found',
  outreach_drafted: 'Outreach Drafted',
  contacted:        'Contacted',
  replied:          'Replied',
  scheduled:        'Scheduled',
  completed:        'Completed',
};

// ─── PDF Document ─────────────────────────────────────────────────────────────

function BriefDocument({ project, today }: { project: Project; today: string }) {
  // Recommended = everyone not yet in the pipeline or explicitly rejected
  const recommended = project.experts.filter(pe =>
    pe.status !== 'discovered' && pe.status !== 'rejected',
  );

  // Screened = has a non-default screeningStatus
  const screened = project.experts.filter(pe =>
    pe.screeningStatus && pe.screeningStatus !== 'not_screened',
  );

  const passCount = screened.filter(pe =>
    pe.screeningStatus === 'screened' || pe.screeningStatus === 'client_ready',
  ).length;
  const failCount = screened.filter(pe =>
    pe.screeningStatus === 'rejected_after_screen',
  ).length;
  const pendingCount = screened.length - passCount - failCount;

  const outreachExperts = project.experts.filter(pe =>
    (OUTREACH_STATUSES as readonly string[]).includes(pe.status),
  );

  const outreachByStatus = OUTREACH_STATUSES.reduce<Record<string, typeof outreachExperts>>(
    (acc, st) => { acc[st] = outreachExperts.filter(pe => pe.status === st); return acc; },
    {},
  );

  return (
    <Document>
      <Page size="A4" style={s.page}>

        {/* ── Header ── */}
        <View style={s.header}>
          <View style={s.headerRow}>
            <Text style={s.wordmark}>EXPERTMATCH</Text>
            <View style={s.headerRight}>
              <Text style={s.projectName}>{project.name}</Text>
              <Text style={s.headerDate}>{today}</Text>
            </View>
          </View>
        </View>

        {/* ── Body ── */}
        <View style={s.body}>

          {/* 1 — Research Question */}
          <View style={s.section}>
            <Text style={s.sectionLabel}>RESEARCH QUESTION</Text>
            <Text style={s.questionText}>{project.researchQuestion}</Text>
          </View>

          {/* 2 — Recommended Experts */}
          {recommended.length > 0 && (
            <View style={s.section}>
              <Text style={s.sectionLabel}>RECOMMENDED EXPERTS</Text>
              {recommended.map(pe => {
                const { expert } = pe;
                const score      = expert.relevance_score ?? 0;
                const scoreStyle = score >= 80 ? s.scoreHigh : score >= 65 ? s.scoreMid : s.scoreLow;
                return (
                  <View key={expert.id} style={s.expertRow}>
                    <View style={s.expertTop}>
                      <View style={s.expertLeft}>
                        <Text style={s.expertName}>{expert.name}</Text>
                        <Text style={s.expertMeta}>{expert.title} · {expert.company}</Text>
                      </View>
                      <View style={s.expertRight}>
                        {score > 0 && <Text style={scoreStyle}>{score}</Text>}
                        {pe.conflictRisk && pe.conflictRisk !== 'unknown' && (
                          <Text style={s.conflictText}>Conflict: {pe.conflictRisk}</Text>
                        )}
                      </View>
                    </View>
                    <Text style={s.justification}>{expert.justification}</Text>
                  </View>
                );
              })}
            </View>
          )}

          {/* 3 — Screening Summary */}
          {screened.length > 0 && (
            <View style={s.section}>
              <Text style={s.sectionLabel}>SCREENING SUMMARY</Text>
              <View style={s.pillRow}>
                <View style={s.pill}>
                  <Text style={s.pillCount}>{passCount}</Text>
                  <Text style={s.pillLabel}>PASSED</Text>
                </View>
                <View style={s.pill}>
                  <Text style={s.pillCount}>{failCount}</Text>
                  <Text style={s.pillLabel}>FAILED</Text>
                </View>
                <View style={s.pill}>
                  <Text style={s.pillCount}>{pendingCount}</Text>
                  <Text style={s.pillLabel}>PENDING</Text>
                </View>
              </View>
              {screened.map(pe => {
                const isPass =
                  pe.screeningStatus === 'screened' || pe.screeningStatus === 'client_ready';
                const isFail = pe.screeningStatus === 'rejected_after_screen';
                const verdictStyle = isPass
                  ? s.screenVerdictPass
                  : isFail
                    ? s.screenVerdictFail
                    : s.screenVerdictPending;
                const verdictLabel = isPass ? 'PASS' : isFail ? 'FAIL' : 'PENDING';
                return (
                  <View key={pe.expert.id} style={s.screenRow}>
                    <View style={s.screenLeft}>
                      <Text style={s.screenName}>{pe.expert.name} · {pe.expert.company}</Text>
                      {pe.screeningNotes ? (
                        <Text style={s.screenNotes}>{pe.screeningNotes}</Text>
                      ) : null}
                    </View>
                    <Text style={verdictStyle}>{verdictLabel}</Text>
                  </View>
                );
              })}
            </View>
          )}

          {/* 4 — Outreach Status */}
          {outreachExperts.length > 0 && (
            <View style={s.section}>
              <Text style={s.sectionLabel}>OUTREACH STATUS</Text>
              {OUTREACH_STATUSES.map(st => {
                const group = outreachByStatus[st];
                if (!group || group.length === 0) return null;
                return (
                  <View key={st} style={s.outreachGroup}>
                    <Text style={s.outreachStatus}>{OUTREACH_LABEL[st].toUpperCase()}</Text>
                    {group.map(pe => (
                      <Text key={pe.expert.id} style={s.outreachExpert}>
                        {pe.expert.name} · {pe.expert.company}
                      </Text>
                    ))}
                  </View>
                );
              })}
            </View>
          )}

        </View>

        {/* ── Footer (fixed — repeats on every page) ── */}
        <View style={s.footer} fixed>
          <Text style={s.footerText}>Generated by ExpertMatch · {today}</Text>
          <Text
            style={s.footerText}
            render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`}
          />
        </View>

      </Page>
    </Document>
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function downloadProjectBriefPdf(project: Project): Promise<void> {
  const today = new Date().toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  const blob = await pdf(<BriefDocument project={project} today={today} />).toBlob();
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${project.name.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 60)}-brief.pdf`;
  a.click();
  URL.revokeObjectURL(url);
}
