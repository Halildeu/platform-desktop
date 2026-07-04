import { describe, expect, it } from 'vitest';

import {
  bindMeetingIntelligenceTarget,
  buildIntelligenceExport,
  failMeetingIntelligence,
  initialMeetingIntelligence,
  markIntelligenceRecording,
  markIntelligenceWaiting,
  setMeetingIntelligenceResult,
} from './meeting-intelligence';

const RESULT = {
  summaryMarkdown: 'Güvenli pilot için recorder akışı ve direct-STT kanıtı ayrıldı.',
  generatedAtMs: 1782741600000,
  providerLabel: 'meeting-ai pilot',
  citationCoverage: 1,
  decisions: [
    {
      id: 'dec-1',
      title: 'Desktop recorder fresh login ile tekrar denenecek',
      owner: 'Zeynep',
      status: 'accepted' as const,
      citations: [{ segmentId: 'seg-1', startedAtMs: 30_000, endedAtMs: 42_000 }],
    },
  ],
  actionItems: [
    {
      id: 'act-1',
      title: 'audio_record rolü yeni token claim özetinde doğrulanacak',
      assignee: 'Zeynep',
      dueDate: '2026-06-30',
      status: 'open' as const,
      priority: 'high' as const,
      citations: [{ segmentId: 'seg-2', startedAtMs: 64_000 }],
    },
  ],
};

describe('meeting intelligence state and exports', () => {
  it('tracks recorder lifecycle without inventing an intelligence result', () => {
    const bound = bindMeetingIntelligenceTarget(initialMeetingIntelligence(), {
      meetingId: '22222222-2222-4222-8222-222222222222',
    });
    expect(bound).toMatchObject({
      status: 'idle',
      meetingId: '22222222-2222-4222-8222-222222222222',
      result: null,
    });

    const recording = markIntelligenceRecording(bound, {
      meetingId: '22222222-2222-4222-8222-222222222222',
      sessionId: 'SES-1',
    });
    expect(recording).toMatchObject({ status: 'recording', sessionId: 'SES-1' });

    const waiting = markIntelligenceWaiting(recording);
    expect(waiting).toMatchObject({ status: 'waiting', result: null });

    const failed = failMeetingIntelligence(waiting, 'meeting-ai unavailable');
    expect(failed).toMatchObject({ status: 'error', error: 'meeting-ai unavailable' });
  });

  it('clears the missing meeting blocker when a canonical meetingId arrives', () => {
    const blocked = bindMeetingIntelligenceTarget(initialMeetingIntelligence(), {
      meetingId: null,
    });

    const bound = bindMeetingIntelligenceTarget(blocked, {
      meetingId: '33333333-3333-4333-8333-333333333333',
    });

    expect(bound).toMatchObject({
      status: 'idle',
      error: null,
      meetingId: '33333333-3333-4333-8333-333333333333',
    });
  });

  it('builds markdown and CSV exports from approved intelligence output', () => {
    const ready = setMeetingIntelligenceResult(
      {
        ...initialMeetingIntelligence(),
        meetingId: '22222222-2222-4222-8222-222222222222',
        sessionId: 'SES-1',
      },
      RESULT,
    );

    const bundle = buildIntelligenceExport(ready, 1782741700000);

    expect(bundle.markdownFileName).toMatch(
      /^meeting-intelligence-22222222-2222-4222-8222-222222222222-/,
    );
    expect(bundle.csvFileName).toMatch(
      /^meeting-intelligence-actions-22222222-2222-4222-8222-222222222222-/,
    );
    expect(bundle.integrationJsonFileName).toMatch(
      /^meeting-output-integration-22222222-2222-4222-8222-222222222222-/,
    );
    expect(bundle.markdown).toContain('# Meeting Intelligence');
    expect(bundle.markdown).toContain('Citation coverage: 100%');
    expect(bundle.markdown).toContain('Desktop recorder fresh login ile tekrar denenecek');
    expect(bundle.markdown).toContain('[0:30-0:42]');
    expect(bundle.csv).toContain(
      'action,act-1,audio_record rolü yeni token claim özetinde doğrulanacak,Zeynep,2026-06-30,Açık,high,1:04',
    );

    const integrationPackage = JSON.parse(bundle.integrationJson) as Record<string, unknown>;
    expect(integrationPackage).toMatchObject({
      schema_version: 'platform-desktop.meeting-output-integration.v1',
      package_type: 'reviewed_meeting_intelligence',
      display_title: 'Meeting Intelligence · 22222222-2222-4222-8222-222222222222',
      meeting_id: '22222222-2222-4222-8222-222222222222',
      session_id: 'SES-1',
      exported_at: '2026-06-29T14:01:40.000Z',
      privacy: {
        classification: 'confidential_meeting_intelligence',
        raw_audio_included: false,
        raw_transcript_included: false,
      },
      route: {
        target: 'Generic ERP/CRM meeting workspace',
        expected_authority: 'backend-gateway / meeting-service integration adapter',
        desktop_direct_backend_mutation: false,
      },
      adapter_contract: {
        version: 'platform.erp-crm.meeting-output.v1',
        vendor_specific: false,
        idempotency_key: expect.stringMatching(
          /^meeting-output:22222222-2222-4222-8222-222222222222:SES-1:2026-06-29T14:00:00\.000Z:fnv1a64:[a-f0-9]{16}$/,
        ),
        content_fingerprint: expect.stringMatching(/^fnv1a64:[a-f0-9]{16}$/),
        write_policy: 'review_before_write',
        source_system: 'platform-meeting-intelligence',
        supported_objects: ['meeting_note', 'decision_record', 'action_task'],
      },
      sync_policy: {
        mode: 'upsert_by_idempotency_key',
        requires_human_review: true,
        desktop_mutates_erp_crm: false,
        failure_mode: 'fail_closed',
      },
      handoff_readiness: {
        status: 'ready',
        can_handoff: true,
        blockers: [],
        warnings: [],
      },
    });
    const adapterContract = integrationPackage.adapter_contract as Record<string, string>;
    expect(adapterContract.idempotency_key).toContain(adapterContract.content_fingerprint);
    expect(integrationPackage.field_mappings).toMatchObject({
      mapping_type: 'field_pointer',
      meeting_note: {
        external_key: 'meeting_id',
        title: 'display_title',
        body: 'summary_markdown',
        source_refs: 'citations',
      },
      decision_record: {
        external_key: 'decision.id',
        title: 'decision.title',
        owner: 'decision.owner',
        status: 'decision.status',
        source_refs: 'decision.citations',
      },
      action_task: {
        external_key: 'action.id',
        title: 'action.title',
        assignee: 'action.assignee',
        due_date: 'action.due_date',
        status: 'action.status',
        priority: 'action.priority',
        source_refs: 'action.citations',
      },
    });
    expect(bundle.integrationJson).toContain('"import_targets": [');
    expect(bundle.integrationJson).toContain('"meeting.decisions"');
    expect(bundle.integrationJson).toContain('"owner": "Zeynep"');
    expect(bundle.integrationJson).toContain('"status_label": "Karar"');
    expect(bundle.integrationJson).not.toContain('"transcript"');
    expect(bundle.integrationJson).not.toContain('"raw_audio":');
  });

  it('keeps the ERP CRM handoff contract vendor neutral', () => {
    const ready = setMeetingIntelligenceResult(
      {
        ...initialMeetingIntelligence(),
        meetingId: '22222222-2222-4222-8222-222222222222',
        sessionId: 'SES-1',
      },
      RESULT,
    );

    const bundle = buildIntelligenceExport(ready, 1782741700000);
    const integrationPackage = JSON.parse(bundle.integrationJson) as {
      route: { target: string };
      adapter_contract: {
        vendor_specific: boolean;
        source_system: string;
      };
    };

    expect(integrationPackage.route.target).toBe('Generic ERP/CRM meeting workspace');
    expect(integrationPackage.adapter_contract).toMatchObject({
      vendor_specific: false,
      source_system: 'platform-meeting-intelligence',
    });
    expect(bundle.integrationJson.toLowerCase()).not.toContain('workcube');
  });

  it('marks ERP CRM handoff as review required when open action ownership is incomplete', () => {
    const ready = setMeetingIntelligenceResult(
      {
        ...initialMeetingIntelligence(),
        meetingId: '22222222-2222-4222-8222-222222222222',
        sessionId: 'SES-1',
      },
      {
        ...RESULT,
        citationCoverage: 0.4,
        decisions: [
          {
            ...RESULT.decisions[0],
            owner: undefined,
            citations: [],
          },
        ],
        actionItems: [
          {
            ...RESULT.actionItems[0],
            assignee: undefined,
            dueDate: undefined,
            citations: [],
          },
        ],
      },
    );

    const integrationPackage = JSON.parse(buildIntelligenceExport(ready).integrationJson) as {
      handoff_readiness: {
        status: string;
        can_handoff: boolean;
        blockers: Array<{ code: string; severity: string; label: string; count?: number }>;
        warnings: Array<{ code: string; severity: string; label: string; count?: number }>;
      };
    };

    expect(integrationPackage.handoff_readiness).toMatchObject({
      status: 'needs_review',
      can_handoff: false,
    });
    expect(integrationPackage.handoff_readiness.blockers).toEqual(
      expect.arrayContaining([
        {
          code: 'missing_action_assignee',
          severity: 'blocker',
          label: '1 açık aksiyonda sahip eksik',
          count: 1,
        },
        {
          code: 'missing_decision_owner',
          severity: 'blocker',
          label: '1 kararda sahip eksik',
          count: 1,
        },
      ]),
    );
    expect(integrationPackage.handoff_readiness.warnings).toEqual(
      expect.arrayContaining([
        {
          code: 'missing_action_due_date',
          severity: 'warning',
          label: '1 açık aksiyonda tarih eksik',
          count: 1,
        },
        {
          code: 'missing_source_reference',
          severity: 'warning',
          label: '2 karar/aksiyonda kaynak referansı eksik',
          count: 2,
        },
        {
          code: 'low_citation_coverage',
          severity: 'warning',
          label: 'Kaynak kapsamı %50 altında',
        },
      ]),
    );
  });

  it('normalizes citation coverage bounds for ERP CRM handoff readiness', () => {
    const buildPackage = (
      citationCoverage: number,
    ): { handoff_readiness: { can_handoff: boolean; warnings: Array<{ code: string }> } } => {
      const ready = setMeetingIntelligenceResult(
        {
          ...initialMeetingIntelligence(),
          meetingId: '22222222-2222-4222-8222-222222222222',
          sessionId: 'SES-1',
        },
        {
          ...RESULT,
          citationCoverage,
        },
      );
      return JSON.parse(buildIntelligenceExport(ready).integrationJson) as {
        handoff_readiness: {
          can_handoff: boolean;
          warnings: Array<{ code: string }>;
        };
      };
    };

    expect(buildPackage(1.4).handoff_readiness).toMatchObject({
      can_handoff: true,
      warnings: [],
    });
    expect(buildPackage(-0.2).handoff_readiness).toMatchObject({
      can_handoff: false,
      warnings: expect.arrayContaining([
        expect.objectContaining({ code: 'low_citation_coverage' }),
      ]),
    });
    expect(buildPackage(Number.NaN).handoff_readiness).toMatchObject({
      can_handoff: false,
      warnings: expect.arrayContaining([
        expect.objectContaining({ code: 'unknown_citation_coverage' }),
      ]),
    });
  });

  it('blocks ERP CRM handoff when the meeting summary is blank', () => {
    const ready = setMeetingIntelligenceResult(
      {
        ...initialMeetingIntelligence(),
        meetingId: '22222222-2222-4222-8222-222222222222',
        sessionId: 'SES-1',
      },
      {
        ...RESULT,
        summaryMarkdown: '   ',
      },
    );

    const integrationPackage = JSON.parse(buildIntelligenceExport(ready).integrationJson) as {
      handoff_readiness: {
        can_handoff: boolean;
        blockers: Array<{ code: string; severity: string; label: string }>;
      };
    };

    expect(integrationPackage.handoff_readiness).toMatchObject({
      can_handoff: false,
      blockers: expect.arrayContaining([
        expect.objectContaining({
          code: 'missing_summary',
          severity: 'blocker',
          label: 'Toplantı özeti boş',
        }),
      ]),
    });
  });

  it('rejects exports before intelligence output is ready', () => {
    expect(() => buildIntelligenceExport(initialMeetingIntelligence())).toThrow(
      'Meeting intelligence output is not ready',
    );
  });
});
