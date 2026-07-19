import { describe, expect, it } from 'vitest';

import {
  analyzeTranscriptSourceReadiness,
  buildMeetingAiSourcePackage,
  buildTranscriptSourceExport,
  failTranscriptSession,
  finishTranscriptSession,
  initialTranscriptSession,
  markTranscriptBlocked,
  markTranscriptProcessing,
  markTranscriptReady,
  markTranscriptSegmentReviewed,
  markTranscriptWaitingForContract,
  reviewTranscriptSegmentText,
  startTranscriptSession,
  transcriptStatusLabel,
  upsertTranscriptSegment,
} from './session-transcript';

describe('session transcript state', () => {
  it('tracks recorder readiness and active session metadata without transcript content persistence', () => {
    const ready = markTranscriptReady(initialTranscriptSession(), {
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
    });

    expect(ready.lifecycle).toBe('ready');
    expect(ready.meetingId).toBe('22222222-2222-4222-8222-222222222222');

    const recording = startTranscriptSession(ready, {
      sessionId: 'SES-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: true,
      startedAtMs: 1781820000123,
    });

    expect(recording).toMatchObject({
      lifecycle: 'recording',
      sessionId: 'SES-1',
      hasLoopback: true,
      startedAtMs: 1781820000123,
      segments: [],
    });
  });

  it('keeps gateway delivery identity out of the canonical analysis request', () => {
    const canonicalSessionId = '33333333-3333-4333-8333-333333333333';
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: canonicalSessionId,
      gatewaySessionId: 'SES-gateway-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1000,
    });
    const finished = finishTranscriptSession(
      upsertTranscriptSegment(recording, {
        id: 'seg-1',
        speakerLabel: 'Konuşmacı',
        startedAtMs: 2000,
        status: 'final',
        text: 'Canonical oturum kimliği analiz isteğinde korunur ve gateway kimliği sızdırılmaz.',
      }),
      20_000,
    );

    const bundle = buildMeetingAiSourcePackage(finished, 21_000);
    expect(bundle.package.session_id).toBe(canonicalSessionId);
    expect(bundle.package.request.session_id).toBe(canonicalSessionId);
    expect(bundle.json).not.toContain('SES-gateway-1');
  });

  it('blocks analysis when only a local transport session exists', () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: null,
      gatewaySessionId: 'LOCAL-direct-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1000,
    });
    const finished = finishTranscriptSession(
      upsertTranscriptSegment(recording, {
        id: 'seg-1',
        speakerLabel: 'Konuşmacı',
        startedAtMs: 2000,
        status: 'final',
        text: 'Direct stream transkripti görünür kalır ama canonical oturum olmadan analiz edilmez.',
      }),
      20_000,
    );

    const bundle = buildMeetingAiSourcePackage(finished, 21_000);
    expect(bundle.package.request.session_id).toBeNull();
    expect(bundle.package.gate.can_submit).toBe(false);
    expect(bundle.package.gate.blocked_by).toContain('recorder sessionId yok');
  });

  it('orders transcript segments and prevents status regression', () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1000,
    });

    const withDraft = upsertTranscriptSegment(recording, {
      id: 'seg-2',
      speakerLabel: 'Konuşmacı 2',
      startedAtMs: 2000,
      status: 'draft',
      text: 'taslak metin',
    });
    const withEarlierFinal = upsertTranscriptSegment(withDraft, {
      id: 'seg-1',
      speakerLabel: 'Konuşmacı 1',
      startedAtMs: 1500,
      status: 'final',
      text: 'final metin',
    });
    const withStable = upsertTranscriptSegment(withEarlierFinal, {
      id: 'seg-2',
      speakerLabel: 'Konuşmacı 2',
      startedAtMs: 2000,
      status: 'stabilizing',
      text: 'netleşen metin',
    });
    const rejectedRegression = upsertTranscriptSegment(withStable, {
      id: 'seg-2',
      speakerLabel: 'Konuşmacı 2',
      startedAtMs: 2000,
      status: 'draft',
      text: 'geri gelen taslak',
    });

    expect(rejectedRegression.segments.map((item) => item.id)).toEqual(['seg-1', 'seg-2']);
    expect(rejectedRegression.segments[1]).toMatchObject({
      status: 'stabilizing',
      text: 'netleşen metin',
    });
  });

  it('keeps a visible direct-stream draft when the same segment regresses to a short fragment', () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1000,
    });

    const visibleDraft = upsertTranscriptSegment(recording, {
      id: 'stream:1',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 2000,
      status: 'draft',
      source: 'direct-stream',
      text: 'Merhaba sesim geliyor mu beni duyuyor musun',
      elapsedMs: 640,
      rms: 0.04,
      receivedAtMs: 3000,
    });
    const regressedDraft = upsertTranscriptSegment(visibleDraft, {
      id: 'stream:1',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 2400,
      status: 'draft',
      source: 'direct-stream',
      text: 'beni duyuyor',
      elapsedMs: 710,
      rms: 0.05,
      receivedAtMs: 3300,
    });

    expect(regressedDraft.segments).toHaveLength(1);
    expect(regressedDraft.segments[0]).toMatchObject({
      id: 'stream:1',
      status: 'draft',
      source: 'direct-stream',
      text: 'Merhaba sesim geliyor mu beni duyuyor musun',
      startedAtMs: 2000,
      elapsedMs: 710,
      rms: 0.05,
      receivedAtMs: 3300,
    });
  });

  it('keeps visible direct-stream words when a final event is only a short prefix', () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1000,
    });

    const visibleDraft = upsertTranscriptSegment(recording, {
      id: 'stream:1',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 2000,
      status: 'draft',
      source: 'direct-stream',
      text: 'Merhaba sesim geliyor mu',
    });
    const longerDraft = upsertTranscriptSegment(visibleDraft, {
      id: 'stream:1',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 2000,
      status: 'draft',
      source: 'direct-stream',
      text: 'Merhaba sesim geliyor mu beni duyuyor musun',
    });
    const finalCorrection = upsertTranscriptSegment(longerDraft, {
      id: 'stream:1',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 2000,
      status: 'final',
      source: 'direct-stream',
      text: 'Merhaba sesim geliyor mu?',
    });

    expect(longerDraft.segments[0]).toMatchObject({
      status: 'draft',
      text: 'Merhaba sesim geliyor mu beni duyuyor musun',
    });
    expect(finalCorrection.segments[0]).toMatchObject({
      status: 'final',
      text: 'Merhaba sesim geliyor mu beni duyuyor musun',
    });
  });

  it('lets reviewed transcript text replace STT output without changing segment ordering', () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1000,
    });
    const withFirst = upsertTranscriptSegment(recording, {
      id: 'seg-1',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 2000,
      status: 'final',
      source: 'direct-stream',
      text: 'Yanlış çevrilmiş metin',
      receivedAtMs: 2500,
    });
    const withSecond = upsertTranscriptSegment(withFirst, {
      id: 'seg-2',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 3000,
      status: 'final',
      source: 'gateway-events',
      text: 'İkinci satır',
    });

    const reviewed = reviewTranscriptSegmentText(withSecond, {
      id: 'seg-1',
      text: '  Doğru toplantı metni  ',
      reviewedAtMs: 4000,
    });

    expect(reviewed.segments.map((segment) => segment.id)).toEqual(['seg-1', 'seg-2']);
    expect(reviewed.segments[0]).toMatchObject({
      id: 'seg-1',
      status: 'revised',
      source: 'direct-stream',
      text: 'Doğru toplantı metni',
      revisedFromId: 'seg-1',
      receivedAtMs: 4000,
      reviewedAtMs: 4000,
    });
    expect(reviewed.segments[1]).toMatchObject({
      id: 'seg-2',
      status: 'final',
      text: 'İkinci satır',
    });
  });

  it('ignores empty or unknown transcript review updates', () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1000,
    });
    const withSegment = upsertTranscriptSegment(recording, {
      id: 'seg-1',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 2000,
      status: 'final',
      text: 'Kaynak metin',
    });

    expect(reviewTranscriptSegmentText(withSegment, { id: 'seg-1', text: '   ' })).toBe(
      withSegment,
    );
    expect(reviewTranscriptSegmentText(withSegment, { id: 'missing', text: 'Yeni metin' })).toBe(
      withSegment,
    );
  });

  it('marks stable transcript text as reviewed without changing STT output', () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1000,
    });
    const withLiveDraft = upsertTranscriptSegment(recording, {
      id: 'seg-live',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 2000,
      status: 'draft',
      source: 'direct-stream',
      text: 'Canlı kelime akışı sürüyor',
    });
    const withStable = upsertTranscriptSegment(withLiveDraft, {
      id: 'seg-final',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 3000,
      status: 'final',
      source: 'gateway-events',
      text: 'Doğru toplantı satırı',
    });

    const reviewed = markTranscriptSegmentReviewed(withStable, {
      id: 'seg-final',
      reviewedAtMs: 5000,
    });

    expect(reviewed.segments.find((segment) => segment.id === 'seg-final')).toMatchObject({
      status: 'final',
      text: 'Doğru toplantı satırı',
      reviewedAtMs: 5000,
    });
    expect(markTranscriptSegmentReviewed(reviewed, { id: 'seg-live', reviewedAtMs: 6000 })).toBe(
      reviewed,
    );
  });

  it('keeps terminal and error states explicit', () => {
    const finished = finishTranscriptSession(initialTranscriptSession(), 1781820000999);
    expect(finished.lifecycle).toBe('finished');
    expect(finished.finishedAtMs).toBe(1781820000999);

    const failed = failTranscriptSession(finished, 'upload failed');
    expect(failed.lifecycle).toBe('error');
    expect(failed.error).toBe('upload failed');

    const blocked = markTranscriptBlocked(failed, { reason: 'RECORDER_MEETING_ID yok' });
    expect(blocked.lifecycle).toBe('blocked');
    expect(blocked.error).toBe('RECORDER_MEETING_ID yok');
    expect(blocked.segments).toEqual([]);
  });

  it('keeps a degraded live drain in processing without erasing the warning', () => {
    const processing = markTranscriptProcessing(
      initialTranscriptSession(),
      1781820000999,
      'Canlı transkriptin son onayı alınamadı.',
    );

    expect(processing).toMatchObject({
      lifecycle: 'processing',
      finishedAtMs: 1781820000999,
      error: 'Canlı transkriptin son onayı alınamadı.',
    });
  });

  it('treats missing meeting contract as a neutral waiting state', () => {
    const failed = failTranscriptSession(
      upsertTranscriptSegment(initialTranscriptSession(), {
        id: 'seg-1',
        speakerLabel: 'Konuşmacı',
        startedAtMs: 1000,
        status: 'draft',
        text: 'eski satır',
      }),
      'old error',
    );

    const waiting = markTranscriptWaitingForContract(failed, { deviceId: 'desktop-1' });

    expect(waiting.lifecycle).toBe('idle');
    expect(waiting.meetingId).toBeNull();
    expect(waiting.sessionId).toBeNull();
    expect(waiting.deviceId).toBe('desktop-1');
    expect(waiting.error).toBeNull();
    expect(waiting.segments).toEqual([]);
  });

  it('returns Turkish status labels for draft to revised transitions', () => {
    expect(transcriptStatusLabel('draft')).toBe('Taslak');
    expect(transcriptStatusLabel('stabilizing')).toBe('Netleşiyor');
    expect(transcriptStatusLabel('final')).toBe('Final');
    expect(transcriptStatusLabel('revised')).toBe('Revize');
  });

  it('builds source transcript markdown and text exports from real segments', () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000000,
    });
    const withLaterDraft = upsertTranscriptSegment(recording, {
      id: 'seg-2',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820007000,
      status: 'draft',
      text: 'ikinci satır',
    });
    const withEarlierFinal = upsertTranscriptSegment(withLaterDraft, {
      id: 'seg-1',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820002000,
      status: 'final',
      text: 'ilk satır',
    });

    const bundle = buildTranscriptSourceExport(withEarlierFinal, 1781820100000);

    expect(bundle.markdownFileName).toMatch(
      /^meeting-transcript-22222222-2222-4222-8222-222222222222-/,
    );
    expect(bundle.textFileName).toMatch(
      /^meeting-transcript-22222222-2222-4222-8222-222222222222-/,
    );
    expect(bundle.markdown).toContain('# Meeting Transcript');
    expect(bundle.markdown).toContain('## Kaynak Hazırlık');
    expect(bundle.markdown).toContain('- Durum: Kaynak toplanıyor');
    expect(bundle.markdown).toContain('- Sonraki kapı: Kayıt bitişi');
    expect(bundle.markdown).toContain('- Final oranı: %50');
    expect(bundle.markdown.indexOf('ilk satır')).toBeLessThan(
      bundle.markdown.indexOf('ikinci satır'),
    );
    expect(bundle.text).toContain('Kaynak Hazırlık');
    expect(bundle.text).toContain('Sonraki kapı: Kayıt bitişi');
    expect(bundle.text).toContain(`[${new Date(1781820002000).toISOString()} Final]`);
    expect(bundle.text).toContain('Konuşmacı: ilk satır');
  });

  it('builds a meeting-ai analyze source package without fabricating output', () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000000,
    });
    const withFirst = upsertTranscriptSegment(recording, {
      id: 'seg-1',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820002000,
      status: 'final',
      source: 'direct-stream',
      text: 'İlk karar kaynak pakete girer.',
    });
    const withSecond = finishTranscriptSession(
      upsertTranscriptSegment(withFirst, {
        id: 'seg-2',
        speakerLabel: 'Konuşmacı',
        startedAtMs: 1781820017000,
        status: 'final',
        source: 'direct-stream',
        text: 'İkinci satır zamanlı segment olarak taşınır.',
      }),
      1781820020000,
    );

    const reviewed = markTranscriptSegmentReviewed(withSecond, {
      id: 'seg-1',
      reviewedAtMs: 1781820090000,
    });
    const bundle = buildMeetingAiSourcePackage(reviewed, 1781820100000);

    expect(bundle.jsonFileName).toMatch(/^meeting-ai-source-22222222-2222-4222-8222-222222222222-/);
    expect(bundle.package.schema_version).toBe('platform-desktop.meeting-ai-source.v1');
    expect(bundle.package.route).toEqual({
      target: 'backend-gateway -> meeting-ai /analyze',
      client_direct_platform_ai: false,
    });
    expect(bundle.package.gate).toMatchObject({
      status: 'review',
      can_submit: false,
      label: 'Meeting AI kapısı bekliyor',
      blocked_by: ['kaynak kalite kontrolü gerekiyor'],
      contract: {
        submit_via: 'backend-gateway',
        endpoint: 'meeting-ai /analyze',
        direct_platform_ai_allowed: false,
      },
    });
    expect(bundle.package.privacy).toEqual({
      classification: 'confidential_transcript',
      transcript_included: true,
      raw_audio_included: false,
      local_raw_audio_cache: false,
      export_requires_user_action: true,
      kvkk_boundary: 'desktop-source-export',
      consent: {
        required: true,
        version: null,
        text_hash: null,
        locale: null,
      },
    });
    expect(bundle.package.request).toEqual({
      transcript: 'İlk karar kaynak pakete girer.\nİkinci satır zamanlı segment olarak taşınır.',
      meeting_id: '22222222-2222-4222-8222-222222222222',
      session_id: 'SES-1',
      segments: [
        { text: 'İlk karar kaynak pakete girer.', start: 0, end: 15 },
        { text: 'İkinci satır zamanlı segment olarak taşınır.', start: 15 },
      ],
    });
    expect(bundle.package.source_quality.final_count).toBe(2);
    expect(bundle.package.source_quality.word_rate_per_minute).toBeGreaterThan(20);
    expect(bundle.package.source_quality.reviewed_count).toBe(1);
    expect(bundle.package.source_quality.reviewed_ratio).toBe(0.5);
    expect(bundle.package.source_quality.quality_gate).toEqual({
      status: 'review',
      risk: 'low_word_coverage',
      label: 'Kapsam riski',
      action:
        'Mikrofon/direct STT zinciri doğrulanmadan Meeting AI veya ERP/CRM aktarımı yapılmaz.',
    });
    expect(bundle.package.source_quality.warnings).not.toContain('Transkript satırı yok.');
    expect(bundle.json).toContain('"client_direct_platform_ai": false');
    expect(bundle.json).toContain('"reviewed_count": 1');
    expect(bundle.json).toContain('"word_rate_per_minute":');
    expect(bundle.json).toContain('"quality_gate":');
    expect(bundle.json).not.toContain('summaryMarkdown');
    expect(bundle.json).not.toContain('actionItems');
  });

  it('marks meeting-ai package as submittable only when the source gate is ready', () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-2',
      meetingId: '33333333-3333-4333-8333-333333333333',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000000,
    });
    const withFirstSegment = upsertTranscriptSegment(recording, {
      id: 'seg-1',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820003000,
      status: 'final',
      source: 'direct-stream',
      text: 'Canlı toplantı kaydı sırasında transkript kaynağı final satırlarla doğrulandı ve çıktı üretimi için hazırlandı.',
    });
    const withSecondSegment = finishTranscriptSession(
      upsertTranscriptSegment(withFirstSegment, {
        id: 'seg-2',
        speakerLabel: 'Konuşmacı',
        startedAtMs: 1781820021000,
        status: 'final',
        source: 'direct-stream',
        text: 'Toplantı sonrasında özet karar ve aksiyon üretimi transkript kanıtına bağlı şekilde ilerleyecek.',
      }),
      1781820025000,
    );

    const bundle = buildMeetingAiSourcePackage(withSecondSegment, 1781820100000);

    expect(bundle.package.gate).toMatchObject({
      status: 'ready',
      can_submit: true,
      label: 'Meeting AI gönderimine hazır',
      blocked_by: [],
    });
    expect(bundle.package.gate.next_action).toContain('backend gateway');
    expect(bundle.package.source_quality.quality_gate).toMatchObject({
      status: 'ready',
      risk: 'none',
      label: 'Kalite kapısı açık',
    });
    expect(bundle.json).toContain('"can_submit": true');
  });

  it('allows a finished draft-only transcript through the Meeting AI gate with draft-quality labeling', () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-3',
      meetingId: '44444444-4444-4444-8444-444444444444',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000000,
    });
    const withFirstDraft = upsertTranscriptSegment(recording, {
      id: 'seg-1',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820003000,
      status: 'draft',
      source: 'direct-stream',
      text: 'Direct STT final satır üretmese bile kullanıcı uzun toplantı boyunca yeterli taslak kaynak oluşturdu.',
    });
    const finishedDraft = finishTranscriptSession(
      upsertTranscriptSegment(withFirstDraft, {
        id: 'seg-2',
        speakerLabel: 'Konuşmacı',
        startedAtMs: 1781820021000,
        status: 'draft',
        source: 'direct-stream',
        text: 'Meeting AI sonucu final kanıt gibi değil taslak kalite etiketiyle preview olarak sunulmalı.',
      }),
      1781820025000,
    );

    const readiness = analyzeTranscriptSourceReadiness(finishedDraft);
    const bundle = buildMeetingAiSourcePackage(finishedDraft, 1781820100000);

    expect(readiness).toMatchObject({
      level: 'review',
      label: 'Taslak kaynak kullanılabilir',
      nextStepLabel: 'Meeting AI taslak gönderimi',
      finalCount: 0,
      draftCount: 2,
      qualityGate: {
        status: 'ready',
        risk: 'draft_only',
        label: 'Taslak kaliteyle açık',
        action:
          'Backend gateway üzerinden taslak kalite etiketiyle gönderilebilir; final kanıt gibi değerlendirilmez.',
      },
    });
    expect(readiness.warnings).toContain(
      'Final satır yok; Meeting AI sonucu taslak kaliteyle değerlendirilir.',
    );
    expect(bundle.package.gate).toMatchObject({
      status: 'ready',
      can_submit: true,
      label: 'Meeting AI taslak gönderimine hazır',
      blocked_by: [],
    });
    expect(bundle.package.gate.next_action).toContain('taslak kalite');
    expect(bundle.package.source_quality.level).toBe('review');
    expect(bundle.package.source_quality.quality_gate.risk).toBe('draft_only');
    expect(bundle.json).toContain('"can_submit": true');
    expect(bundle.json).toContain('"final_count": 0');
  });

  it('keeps sparse transcript sources in review when word coverage is low', () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-4',
      meetingId: '55555555-5555-4555-8555-555555555555',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000000,
    });
    const withFirstSparseSegment = upsertTranscriptSegment(recording, {
      id: 'seg-1',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820000000,
      status: 'final',
      source: 'direct-stream',
      text: 'Toplantı başladı müşteri ihtiyaçları ve entegrasyon riskleri kısa şekilde not edildi',
    });
    const finishedSparse = finishTranscriptSession(
      upsertTranscriptSegment(withFirstSparseSegment, {
        id: 'seg-2',
        speakerLabel: 'Konuşmacı',
        startedAtMs: 1781820240000,
        status: 'final',
        source: 'direct-stream',
        text: 'Aksiyon sahipleri belirlendi ancak kayıt kapsamı beklenen konuşmayı taşımıyor',
      }),
      1781820245000,
    );

    const readiness = analyzeTranscriptSourceReadiness(finishedSparse);
    const bundle = buildMeetingAiSourcePackage(finishedSparse, 1781820100000);

    expect(readiness).toMatchObject({
      level: 'review',
      label: 'Gözden geçirilmeli',
      wordCount: 20,
      durationMs: 245_000,
      wordRatePerMinute: expect.closeTo(4.9, 1),
      qualityGate: {
        status: 'review',
        risk: 'low_word_coverage',
        label: 'Kapsam riski',
        action:
          'Mikrofon/direct STT zinciri doğrulanmadan Meeting AI veya ERP/CRM aktarımı yapılmaz.',
      },
    });
    expect(readiness.warnings).toContain(
      'Kelime üretim hızı düşük; konuşmanın önemli kısmı transcript kaynağına düşmemiş olabilir.',
    );
    expect(bundle.package.gate).toMatchObject({
      status: 'review',
      can_submit: false,
      label: 'Meeting AI kapısı bekliyor',
      blocked_by: ['kaynak kalite kontrolü gerekiyor'],
    });
    expect(bundle.package.source_quality.word_rate_per_minute).toBeCloseTo(4.9, 1);
    expect(bundle.package.source_quality.quality_gate.risk).toBe('low_word_coverage');
    expect(bundle.json).toContain('"word_rate_per_minute":');
    expect(bundle.json).toContain('"risk": "low_word_coverage"');
  });

  it('uses the finished recording window to flag sparse transcript coverage', () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-5',
      meetingId: '66666666-6666-4666-8666-666666666666',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000000,
    });
    const finishedSparse = finishTranscriptSession(
      upsertTranscriptSegment(recording, {
        id: 'seg-1',
        speakerLabel: 'Konuşmacı',
        startedAtMs: 1781820005000,
        endedAtMs: 1781820006200,
        status: 'final',
        source: 'direct-stream',
        text: 'Uzun konuşmanın yalnız küçük kısmı düştü',
      }),
      1781820120000,
    );

    const readiness = analyzeTranscriptSourceReadiness(finishedSparse);
    const bundle = buildMeetingAiSourcePackage(finishedSparse, 1781820130000);

    expect(readiness).toMatchObject({
      level: 'review',
      label: 'Gözden geçirilmeli',
      wordCount: 6,
      durationMs: 120_000,
      wordRatePerMinute: 3,
      qualityGate: {
        status: 'review',
        risk: 'low_word_coverage',
        label: 'Kapsam riski',
      },
    });
    expect(readiness.warnings).toContain(
      'Kelime üretim hızı düşük; konuşmanın önemli kısmı transcript kaynağına düşmemiş olabilir.',
    );
    expect(bundle.package.source_quality.duration_ms).toBe(120_000);
    expect(bundle.package.source_quality.quality_gate.risk).toBe('low_word_coverage');
    expect(bundle.package.gate).toMatchObject({
      status: 'review',
      can_submit: false,
      blocked_by: ['kaynak kalite kontrolü gerekiyor'],
    });
  });

  it('rejects source export when no transcript segment exists', () => {
    expect(() => buildTranscriptSourceExport(initialTranscriptSession())).toThrow(
      'Transcript source is not ready',
    );
    expect(() => buildMeetingAiSourcePackage(initialTranscriptSession())).toThrow(
      'Transcript source is not ready',
    );
  });

  it('analyzes transcript source readiness without fabricating intelligence output', () => {
    expect(analyzeTranscriptSourceReadiness(initialTranscriptSession())).toMatchObject({
      level: 'empty',
      label: 'Kaynak bekleniyor',
      nextStepLabel: 'Kayıt kaynağı',
      wordCount: 0,
      wordRatePerMinute: null,
      finalCount: 0,
      qualityGate: {
        status: 'blocked',
        risk: 'empty_source',
        label: 'Kaynak kapısı kapalı',
      },
    });

    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1000,
    });
    const collecting = upsertTranscriptSegment(recording, {
      id: 'seg-1',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 2000,
      status: 'draft',
      text: 'kayıt sürerken gelen kısa taslak',
    });

    expect(analyzeTranscriptSourceReadiness(collecting)).toMatchObject({
      level: 'collecting',
      label: 'Kaynak toplanıyor',
      nextStepLabel: 'Kayıt bitişi',
      finalCount: 0,
      draftCount: 1,
      qualityGate: {
        status: 'collecting',
        risk: 'recording_active',
        label: 'Kaynak toplanıyor',
      },
    });

    const finalOnly = finishTranscriptSession(
      upsertTranscriptSegment(recording, {
        id: 'seg-1',
        speakerLabel: 'Konuşmacı',
        startedAtMs: 2000,
        status: 'final',
        text: 'Bu toplantıda canlı transkript doğrulandı ve kayıt çıktısı için kaynak kalite eşiği değerlendirildi.',
      }),
      30_000,
    );
    const reportReady = upsertTranscriptSegment(finalOnly, {
      id: 'seg-2',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 20_000,
      status: 'final',
      text: 'Kullanıcı deneyimi tarafında özet üretmeden önce transkript olgunluğu görünür hale getirilecek.',
    });

    expect(analyzeTranscriptSourceReadiness(reportReady)).toMatchObject({
      level: 'ready',
      label: 'Çıktıya uygun',
      nextStepLabel: 'Meeting AI',
      finalCount: 2,
      draftCount: 0,
      finalRatio: 1,
      wordRatePerMinute: expect.any(Number),
      qualityGate: {
        status: 'ready',
        risk: 'none',
        label: 'Kalite kapısı açık',
      },
    });
  });
});
