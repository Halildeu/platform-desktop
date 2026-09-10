// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanonicalSourcePanel, CitationLinks } from './CanonicalSourcePanel';
import {
  applyMeetingOutputSourceEvidenceReadiness,
  formatCitationTime,
} from '../intelligence/meeting-intelligence';

const source = {
  meetingId: 'meeting',
  analysisRunId: 'run',
  sessionId: 'session',
  finalizationVersion: 2,
  transcriptSha256: 'hash',
  sentences: [{ index: 4, text: 'Synthetic source sentence.', sha256: 'exact-hash' }],
};
const citation = {
  segmentId: 'meeting-ai:4',
  startedAtMs: 1789046520809,
  sourceIndex: 4,
  sourceHash: 'exact-hash',
};
afterEach(cleanup);
describe('canonical source navigation', () => {
  it('does not turn source retrieval into ERP/CRM handoff approval', () => {
    const readiness = applyMeetingOutputSourceEvidenceReadiness(
      { status: 'ready', canHandoff: true, blockers: [], warnings: [] },
      {
        transcript: null,
        canonical_source: {
          analysis_run_id: 'run',
          session_id: 'session',
          finalization_version: 1,
          transcript_sha256: 'hash',
          raw_transcript_included: false,
        },
      },
    );
    expect(readiness.canHandoff).toBe(false);
    expect(readiness.warnings[0].code).toBe('unknown_source_freshness');
  });
  it('uses source ordinal rather than treating epoch seconds as elapsed minutes', () => {
    expect(formatCitationTime(citation)).toBe('Kaynak #5');
    expect(formatCitationTime({ segmentId: 'live:1', startedAtMs: 12000 })).toBe('0:12');
  });
  it('focuses and scrolls to the exact matching sentence on source activation', () => {
    render(
      <>
        <CitationLinks citations={[citation]} source={source} />
        <CanonicalSourcePanel source={source} status="ready" onRetry={vi.fn()} />
      </>,
    );
    const row = screen.getByRole('listitem');
    row.scrollIntoView = vi.fn();
    fireEvent.click(screen.getByRole('link', { name: 'Kaynak #5' }));
    expect(document.activeElement).toBe(row);
    expect(row.scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
  });
  it('never links a mismatched hash or absent snapshot', () => {
    const view = render(
      <CitationLinks citations={[{ ...citation, sourceHash: 'wrong' }]} source={source} />,
    );
    expect(screen.queryByRole('link')).toBeNull();
    view.rerender(<CitationLinks citations={[citation]} source={null} />);
    expect(screen.queryByRole('link')).toBeNull();
  });
  it('provides an honest failure and explicit retry', () => {
    const retry = vi.fn();
    render(<CanonicalSourcePanel source={null} status="error" onRetry={retry} />);
    expect(screen.getByRole('status').textContent).toContain('Kaynak okunamadı');
    fireEvent.click(screen.getByRole('button', { name: 'Kaynağı yeniden yükle' }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
