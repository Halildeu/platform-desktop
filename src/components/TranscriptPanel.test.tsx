// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { TranscriptPanel } from './TranscriptPanel';
import {
  initialTranscriptSession,
  startTranscriptSession,
  upsertTranscriptSegment,
} from '../transcript/session-transcript';

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
  } else {
    delete (navigator as { clipboard?: Clipboard }).clipboard;
  }
});

describe('TranscriptPanel', () => {
  function clock(ms: number): string {
    return new Date(ms).toLocaleTimeString('tr-TR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  it('renders recorder session metadata without fake transcript content', () => {
    const session = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: true,
      startedAtMs: 1781820000123,
    });

    render(<TranscriptPanel session={session} />);

    expect(screen.getByRole('heading', { name: 'Canlı Transkript' })).toBeInTheDocument();
    expect(screen.getByText('Oturum SES-1')).toBeInTheDocument();
    expect(screen.getByText('Kayıt')).toBeInTheDocument();
    expect(screen.getByText('Mikrofon + sistem sesi')).toBeInTheDocument();
    expect(screen.getByText('Gateway event')).toBeInTheDocument();
    expect(screen.getByText('Batch/poll akışı')).toBeInTheDocument();
    expect(screen.getByText('Son ses')).toBeInTheDocument();
    expect(screen.getByText('Son metin')).toBeInTheDocument();
    expect(screen.getByText('Gecikme')).toBeInTheDocument();
    expect(screen.getByText('Transkript akışı bekleniyor')).toBeInTheDocument();
    expect(screen.queryByText('örnek transcript')).not.toBeInTheDocument();
  });

  it('does not report direct stream as connecting before recorder starts', () => {
    render(
      <TranscriptPanel
        session={initialTranscriptSession()}
        stream={{
          directConfigured: true,
          directStatus: { status: 'connecting' },
          directActive: false,
          disabledReason: null,
        }}
      />,
    );

    expect(screen.getByText('Recorder oturumu yok')).toBeInTheDocument();
    expect(screen.getByText('Direct stream')).toBeInTheDocument();
    expect(screen.getByText('Kayıt başlayınca bağlanacak')).toBeInTheDocument();
    expect(screen.queryByText('Bağlantı kuruluyor')).not.toBeInTheDocument();
  });

  it('runs direct stream preflight before recording starts', async () => {
    const onPreflight = vi.fn();

    render(
      <TranscriptPanel
        session={initialTranscriptSession()}
        stream={{
          directConfigured: true,
          directActive: false,
          disabledReason: null,
          preflight: {
            status: 'idle',
            message: null,
            checkedAtMs: null,
            elapsedMs: null,
            stage: null,
          },
          onPreflight,
        }}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Bağlantı testi' }));

    expect(onPreflight).toHaveBeenCalledTimes(1);
  });

  it('renders direct stream preflight result', () => {
    render(
      <TranscriptPanel
        session={initialTranscriptSession()}
        stream={{
          directConfigured: true,
          directActive: false,
          disabledReason: null,
          preflight: {
            status: 'ready',
            message: 'Direct STT stream hazir.',
            checkedAtMs: 1781820000000,
            elapsedMs: 240,
            stage: 'live_model',
          },
          onPreflight: vi.fn(),
        }}
      />,
    );

    expect(screen.getByText('Direct STT stream hazir. · 240 ms')).toBeInTheDocument();
  });

  it('renders capture worklet preflight separately from direct stream readiness', () => {
    render(
      <TranscriptPanel
        session={initialTranscriptSession()}
        stream={{
          directConfigured: true,
          directActive: false,
          disabledReason: null,
          capturePreflight: {
            status: 'ready',
            message: 'Ses işleyici hazır.',
            checkedAtMs: 1781820000000,
            elapsedMs: 12,
            moduleUrl: 'file:///app/dist/pcm-worklet.js',
          },
          preflight: {
            status: 'ready',
            message: 'Direct STT stream hazir.',
            checkedAtMs: 1781820000000,
            elapsedMs: 240,
            stage: 'live_model',
          },
          onPreflight: vi.fn(),
        }}
      />,
    );

    expect(screen.getByText('Ses işleyici')).toBeInTheDocument();
    expect(screen.getAllByText('Hazır').length).toBeGreaterThan(0);
    expect(screen.getByText('Ses işleyici hazır. · 12 ms')).toBeInTheDocument();
    expect(screen.getByText('Direct STT stream hazir. · 240 ms')).toBeInTheDocument();
  });

  it('renders direct stream preflight error', () => {
    render(
      <TranscriptPanel
        session={initialTranscriptSession()}
        stream={{
          directConfigured: true,
          directActive: false,
          disabledReason: null,
          preflight: {
            status: 'error',
            message: 'Direct STT baglanti hatasi.',
            checkedAtMs: 1781820000000,
            elapsedMs: null,
            stage: null,
          },
          onPreflight: vi.fn(),
        }}
      />,
    );

    expect(screen.getByText('Direct STT baglanti hatasi.')).toHaveClass('inline-error');
  });

  it('renders newest transcript segment first while keeping statuses visible', () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000123,
    });
    const withLaterDraft = upsertTranscriptSegment(recording, {
      id: 'seg-2',
      speakerLabel: 'Konuşmacı 2',
      startedAtMs: 1781820060000,
      status: 'draft',
      text: 'İkinci cümle işleniyor',
      source: 'direct-stream',
      elapsedMs: 180,
      receivedAtMs: 1781820065123,
    });
    const withEarlierFinal = upsertTranscriptSegment(withLaterDraft, {
      id: 'seg-1',
      speakerLabel: 'Konuşmacı 1',
      startedAtMs: 1781820030000,
      status: 'final',
      text: 'İlk karar kaydedildi',
      source: 'gateway-events',
    });

    render(
      <TranscriptPanel
        session={withEarlierFinal}
        stream={{ directConfigured: true, directActive: true, disabledReason: null }}
      />,
    );

    expect(screen.getByText('Direct stream')).toBeInTheDocument();
    expect(screen.getByText('Kelime akışı aktif')).toBeInTheDocument();
    expect(screen.getByText(clock(1781820065123))).toBeInTheDocument();
    const articles = screen.getAllByRole('article');
    expect(articles).toHaveLength(2);
    expect(articles[0]).toHaveTextContent('İkinci cümle işleniyor');
    expect(articles[0]).toHaveTextContent('Taslak');
    expect(articles[0]).toHaveTextContent('Direct STT');
    expect(articles[0]).toHaveTextContent('Canlı');
    expect(articles[0]).toHaveClass('segment-live');
    expect(articles[0]).toHaveTextContent('180 ms');
    expect(articles[1]).toHaveTextContent('İlk karar kaydedildi');
    expect(articles[1]).toHaveTextContent('Final');
    expect(articles[1]).toHaveTextContent('Gateway');
    expect(articles[1]).not.toHaveClass('segment-live');
  });

  it('renders transcript flow health metrics for live coverage triage', () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000123,
    });
    const withDirectSegment = upsertTranscriptSegment(recording, {
      id: 'seg-1',
      speakerLabel: 'Konuşmacı 1',
      startedAtMs: 1781820003000,
      status: 'final',
      text: 'İlk konuşma geldi ve müşteri aksiyonları net şekilde kaydedildi',
      source: 'direct-stream',
      receivedAtMs: 1781820030123,
    });
    const withGatewaySegment = upsertTranscriptSegment(withDirectSegment, {
      id: 'seg-2',
      speakerLabel: 'Konuşmacı 2',
      startedAtMs: 1781820060000,
      status: 'final',
      text: 'İkinci konuşma geldi kararlar ve sahipler doğrulandı',
      source: 'gateway-events',
      receivedAtMs: 1781820061123,
    });

    render(
      <TranscriptPanel
        session={withGatewaySegment}
        stream={{
          directConfigured: true,
          directReady: true,
          directActive: true,
          audioRms: 0.026,
          audioActive: true,
          lastAudioAtMs: 1781820062123,
          disabledReason: null,
        }}
      />,
    );

    const flowHealth = screen.getByLabelText('Transkript akış kalitesi');
    expect(within(flowHealth).getByText('Akış takipte')).toBeInTheDocument();
    expect(within(flowHealth).getByText('1.9 satır/dk')).toBeInTheDocument();
    expect(within(flowHealth).getByText('16')).toBeInTheDocument();
    expect(within(flowHealth).getByText('15 kelime/dk')).toBeInTheDocument();
    expect(within(flowHealth).getByText('Direct 1 / Gateway 1')).toBeInTheDocument();
    expect(
      within(flowHealth).getByText('Ses ve transcript zamanı birlikte ilerliyor.'),
    ).toBeInTheDocument();
    expect(within(flowHealth).getByText('Sonraki aksiyon')).toBeInTheDocument();
    expect(
      within(flowHealth).getByText(
        'Kayıt sonrası toplantı çıktısını kaynak kanıtıyla review’a alın.',
      ),
    ).toBeInTheDocument();
  });

  it('searches long transcript rows without changing newest-first order', async () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000123,
    });
    const withFirst = upsertTranscriptSegment(recording, {
      id: 'seg-1',
      speakerLabel: 'Konuşmacı 1',
      startedAtMs: 1781820030000,
      status: 'final',
      text: 'Bütçe onayı ve müşteri aksiyonu konuşuldu',
      source: 'gateway-events',
    });
    const withSecond = upsertTranscriptSegment(withFirst, {
      id: 'seg-2',
      speakerLabel: 'Konuşmacı 2',
      startedAtMs: 1781820040000,
      status: 'final',
      text: 'Risk listesi tekrar değerlendirildi',
      source: 'direct-stream',
    });
    const withThird = upsertTranscriptSegment(withSecond, {
      id: 'seg-3',
      speakerLabel: 'Konuşmacı 3',
      startedAtMs: 1781820050000,
      status: 'revised',
      text: 'Revize karar satırı kesinleşti',
      source: 'direct-stream',
    });

    render(<TranscriptPanel session={withThird} />);

    expect(
      screen.getByText(
        'Görünen 3/3 · Final 2 · Revize 1 · İncelenen 1 · Kontrol bekleyen 2 · Taslak 0 · Direct 2 · Gateway 1',
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('article')[0]).toHaveTextContent('Revize karar satırı');

    await userEvent.type(screen.getByPlaceholderText('Transkriptte ara'), 'bütçe');

    const searchedArticles = screen.getAllByRole('article');
    expect(searchedArticles).toHaveLength(1);
    expect(searchedArticles[0]).toHaveTextContent('Bütçe onayı');
    expect(
      screen.getByText(
        'Görünen 1/3 · Final 2 · Revize 1 · İncelenen 1 · Kontrol bekleyen 2 · Taslak 0 · Direct 2 · Gateway 1',
      ),
    ).toBeInTheDocument();

    await userEvent.clear(screen.getByPlaceholderText('Transkriptte ara'));
    await userEvent.type(screen.getByPlaceholderText('Transkriptte ara'), 'bulunmayan');

    expect(screen.queryAllByRole('article')).toHaveLength(0);
    expect(screen.getByText('Filtreyle eşleşen satır yok')).toBeInTheDocument();
  });

  it('filters transcript rows by review status and source', async () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000123,
    });
    const withDraft = upsertTranscriptSegment(recording, {
      id: 'seg-draft',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820030000,
      status: 'draft',
      text: 'Canlı direct draft satırı',
      source: 'direct-stream',
    });
    const withFinal = upsertTranscriptSegment(withDraft, {
      id: 'seg-final',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820040000,
      status: 'final',
      text: 'Gateway final toplantı satırı',
      source: 'gateway-events',
    });
    const withRevised = upsertTranscriptSegment(withFinal, {
      id: 'seg-revised',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820050000,
      status: 'revised',
      text: 'Direct revize toplantı satırı',
      source: 'direct-stream',
    });

    render(<TranscriptPanel session={withRevised} />);

    await userEvent.click(screen.getByRole('button', { name: 'Kontrol bekleyen' }));

    const pendingArticles = screen.getAllByRole('article');
    expect(pendingArticles).toHaveLength(1);
    expect(pendingArticles[0]).toHaveTextContent('Gateway final toplantı satırı');
    expect(screen.queryByText('Canlı direct draft satırı')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'İncelenen' }));

    const reviewedArticles = screen.getAllByRole('article');
    expect(reviewedArticles).toHaveLength(1);
    expect(reviewedArticles[0]).toHaveTextContent('Direct revize toplantı satırı');

    await userEvent.click(screen.getByRole('button', { name: 'Revizeler' }));

    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.getByText('Direct revize toplantı satırı')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revizeler' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Direct kaynak' }));

    const directArticles = screen.getAllByRole('article');
    expect(directArticles).toHaveLength(2);
    expect(directArticles[0]).toHaveTextContent('Direct revize toplantı satırı');
    expect(directArticles[1]).toHaveTextContent('Canlı direct draft satırı');
    expect(screen.queryByText('Gateway final toplantı satırı')).not.toBeInTheDocument();
  });

  it('lets users review stable transcript text without editing the live direct draft', async () => {
    const onSegmentTextChange = vi.fn();
    const onSegmentReviewed = vi.fn();
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000123,
    });
    const withLiveDraft = upsertTranscriptSegment(recording, {
      id: 'seg-live',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820060000,
      status: 'draft',
      text: 'Canlı akış sürüyor',
      source: 'direct-stream',
      receivedAtMs: 1781820065123,
    });
    const withStableSegment = upsertTranscriptSegment(withLiveDraft, {
      id: 'seg-final',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820030000,
      status: 'final',
      text: 'Yanlış yazılan toplantı satırı',
      source: 'gateway-events',
    });

    render(
      <TranscriptPanel
        session={withStableSegment}
        stream={{ directConfigured: true, directActive: true, disabledReason: null }}
        onSegmentTextChange={onSegmentTextChange}
        onSegmentReviewed={onSegmentReviewed}
      />,
    );

    const articles = screen.getAllByRole('article');
    expect(within(articles[0]).queryByRole('button', { name: 'Metni düzelt' })).toBeNull();
    expect(within(articles[0]).queryByRole('button', { name: 'İncelendi' })).toBeNull();

    await userEvent.click(within(articles[1]).getByRole('button', { name: 'İncelendi' }));
    expect(onSegmentReviewed).toHaveBeenCalledWith('seg-final');

    await userEvent.click(within(articles[1]).getByRole('button', { name: 'Metni düzelt' }));
    const editor = within(articles[1]).getByLabelText('Transkript metni');
    await userEvent.clear(editor);
    await userEvent.type(editor, 'Düzeltilmiş toplantı satırı');
    await userEvent.click(within(articles[1]).getByRole('button', { name: 'Kaydet' }));

    expect(onSegmentTextChange).toHaveBeenCalledWith('seg-final', 'Düzeltilmiş toplantı satırı');
  });

  it('renders speaker timeline distribution and lets reviewed labels drive the transcript view', async () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000000,
    });
    const withFirstSpeaker = upsertTranscriptSegment(recording, {
      id: 'seg-1',
      speakerLabel: 'Konuşmacı 1',
      startedAtMs: 1781820000000,
      endedAtMs: 1781820004000,
      status: 'final',
      text: 'İlk gündem maddesi konuşuldu',
      source: 'gateway-events',
    });
    const withSecondSpeaker = upsertTranscriptSegment(withFirstSpeaker, {
      id: 'seg-2',
      speakerLabel: 'Konuşmacı 2',
      startedAtMs: 1781820004000,
      endedAtMs: 1781820009000,
      status: 'final',
      text: 'İkinci konuşmacı aksiyonları anlattı',
      source: 'gateway-events',
    });
    const withSpeakerReturn = upsertTranscriptSegment(withSecondSpeaker, {
      id: 'seg-3',
      speakerLabel: 'Konuşmacı 1',
      startedAtMs: 1781820009000,
      endedAtMs: 1781820011000,
      status: 'final',
      text: 'Kapanış notu alındı',
      source: 'gateway-events',
    });

    render(<TranscriptPanel session={withSpeakerReturn} />);

    expect(screen.getByRole('heading', { name: 'Konuşmacı Görünümü' })).toBeInTheDocument();
    expect(screen.getByLabelText('Konuşma dağılımı pasta grafiği')).toBeInTheDocument();
    expect(screen.getByLabelText('Konuşmacı zaman çizgisi')).toBeInTheDocument();
    expect(screen.getByText('55% · 2 tur · 6 sn')).toBeInTheDocument();
    expect(screen.getByText('45% · 1 tur · 5 sn')).toBeInTheDocument();
    expect(screen.getByText('Kesin overlap sinyali yok.')).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText('Konuşmacı adı: Konuşmacı 1'));
    await userEvent.type(screen.getByLabelText('Konuşmacı adı: Konuşmacı 1'), 'Halil Bey');

    expect(screen.getByRole('button', { name: 'Etiketleri sıfırla' })).toBeInTheDocument();
    expect(screen.getAllByText('Halil Bey').length).toBeGreaterThan(0);
    const articles = screen.getAllByRole('article');
    expect(articles[0]).toHaveTextContent('Halil Bey');
    expect(articles[0]).toHaveTextContent('Kapanış notu alındı');

    await userEvent.click(screen.getByRole('button', { name: 'Etiketleri sıfırla' }));
    expect(screen.queryByRole('button', { name: 'Etiketleri sıfırla' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Konuşmacı adı: Konuşmacı 1')).toHaveValue('Konuşmacı 1');
  });

  it('surfaces interruption signals only when segment timing overlaps', () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000000,
    });
    const withFirstSpeaker = upsertTranscriptSegment(recording, {
      id: 'seg-1',
      speakerLabel: 'Konuşmacı 1',
      startedAtMs: 1781820000000,
      endedAtMs: 1781820005000,
      status: 'final',
      text: 'Konuşmacı uzun bir açıklama yapıyor',
      source: 'gateway-events',
    });
    const withOverlap = upsertTranscriptSegment(withFirstSpeaker, {
      id: 'seg-2',
      speakerLabel: 'Konuşmacı 2',
      startedAtMs: 1781820004500,
      endedAtMs: 1781820007000,
      status: 'final',
      text: 'İkinci konuşmacı araya giriyor',
      source: 'gateway-events',
    });

    render(<TranscriptPanel session={withOverlap} />);

    expect(screen.getByText('Söz kesme sinyali')).toBeInTheDocument();
    expect(
      screen.getByText((content) =>
        content.includes('Konuşmacı 2, Konuşmacı 1 üzerine <1 sn bindi'),
      ),
    ).toBeInTheDocument();
  });

  it('copies a non-content diagnostic snapshot for live transcript triage', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000123,
    });
    const withTranscript = upsertTranscriptSegment(recording, {
      id: 'stream:1',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820001000,
      status: 'draft',
      text: 'Bu hassas transcript metni snapshot içine girmemeli',
      source: 'direct-stream',
      receivedAtMs: 1781820002000,
    });

    render(
      <TranscriptPanel
        session={withTranscript}
        stream={{
          directConfigured: true,
          directReady: true,
          directActive: true,
          capturePreflight: {
            status: 'ready',
            message: 'Ses işleyici hazır.',
            checkedAtMs: 1781820000000,
            elapsedMs: 12,
            moduleUrl: 'file:///app/dist/pcm-worklet.js',
          },
          audioRms: 0.026,
          audioActive: true,
          lastAudioAtMs: 1781820003000,
          disabledReason: null,
        }}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Tanı kopyala' }));

    expect(writeText).toHaveBeenCalledTimes(1);
    const snapshot = String(writeText.mock.calls[0]?.[0]);
    expect(snapshot).toContain('meeting-intelligence.transcript.diagnostics.v1');
    expect(snapshot).toContain('lifecycle=recording');
    expect(snapshot).toContain('directReady=true');
    expect(snapshot).toContain('audioCapturePreflight=ready');
    expect(snapshot).toContain('audioCaptureWorklet=file:///app/dist/pcm-worklet.js');
    expect(snapshot).toContain('audioRms=0.026');
    expect(snapshot).toContain('flow.health=Akış takipte');
    expect(snapshot).toContain('flow.risk=none');
    expect(snapshot).toContain(
      'flow.nextAction=Kayıt sonrası toplantı çıktısını kaynak kanıtıyla review’a alın.',
    );
    expect(snapshot).toContain('flow.segmentDensityPerMinute=-');
    expect(snapshot).toContain('flow.wordsPerMinute=-');
    expect(snapshot).toContain('segments.total=1');
    expect(snapshot).toContain('segments.draft=1');
    expect(snapshot).toContain('segments.direct=1');
    expect(snapshot).toContain('words.total=7');
    expect(snapshot).not.toContain('Bu hassas transcript metni');
    expect(await screen.findByText('Tanı panoya kopyalandı.')).toBeInTheDocument();
  });

  it('distinguishes direct stream ready from first transcript event', () => {
    const session = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000123,
    });

    render(
      <TranscriptPanel
        session={session}
        stream={{
          directConfigured: true,
          directReady: true,
          directActive: false,
          audioRms: 0.021,
          audioActive: true,
          lastAudioAtMs: 1781820004123,
          disabledReason: null,
        }}
      />,
    );

    expect(screen.getByText('Direct stream')).toBeInTheDocument();
    expect(screen.getByText('Ses alınıyor, kelime bekleniyor')).toBeInTheDocument();
    expect(screen.getByText('Alınıyor · RMS 0.021')).toBeInTheDocument();
    expect(screen.getByText(clock(1781820004123))).toBeInTheDocument();
    expect(screen.getByText('İlk metin bekleniyor')).toBeInTheDocument();
    const flowHealth = screen.getByLabelText('Transkript akış kalitesi');
    expect(within(flowHealth).getByText('Ses var, metin yok')).toBeInTheDocument();
    expect(within(flowHealth).getByText('0')).toBeInTheDocument();
    expect(within(flowHealth).getByText('Direct 0 / Gateway 0')).toBeInTheDocument();
    expect(
      within(flowHealth).getByText(
        'Mikrofon sesi görülüyor ancak henüz transcript satırı alınmadı.',
      ),
    ).toBeInTheDocument();
    expect(
      within(flowHealth).getByText(
        'Mikrofon girişini ve direct STT bağlantısını kontrol edin; durum sürerse tanıyı kopyalayın.',
      ),
    ).toBeInTheDocument();
  });

  it('surfaces direct stream reconnect state for operator triage', () => {
    const session = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000123,
    });

    render(
      <TranscriptPanel
        session={session}
        stream={{
          directConfigured: true,
          directReady: false,
          directStatus: {
            status: 'reconnecting',
            attempt: 2,
            maxAttempts: 8,
            retryDelayMs: 500,
            reason: 'bağlantı kapandı',
          },
          directActive: false,
          audioRms: 0.018,
          audioActive: true,
          lastAudioAtMs: 1781820010123,
          disabledReason: null,
        }}
      />,
    );

    expect(screen.getByText('Direct stream')).toBeInTheDocument();
    expect(screen.getByText('Yeniden bağlanıyor (2/8)')).toBeInTheDocument();
    expect(screen.getByText('Alınıyor · RMS 0.018')).toBeInTheDocument();
  });

  it('highlights transcript lag when audio is active but text is stale', () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000123,
    });
    const withTranscript = upsertTranscriptSegment(recording, {
      id: 'seg-1',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820001000,
      status: 'draft',
      text: 'İlk canlı metin geldi',
      source: 'direct-stream',
      receivedAtMs: 1781820002000,
    });

    render(
      <TranscriptPanel
        session={withTranscript}
        stream={{
          directConfigured: true,
          directReady: true,
          directActive: false,
          audioRms: 0.024,
          audioActive: true,
          lastAudioAtMs: 1781820009000,
          disabledReason: null,
        }}
      />,
    );

    expect(screen.getByText('Metin gecikiyor (7 sn)')).toBeInTheDocument();
    expect(screen.getByText('Gecikiyor · 7 sn')).toHaveClass('stream-lag-warning');
    const flowHealth = screen.getByLabelText('Transkript akış kalitesi');
    expect(within(flowHealth).getByText('Metin gecikiyor')).toBeInTheDocument();
    expect(
      within(flowHealth).getByText(
        'Ses zamanı metinden önde; stream backlog, ağ veya model kuyruğu kontrol edilmeli.',
      ),
    ).toBeInTheDocument();
    expect(
      within(flowHealth).getByText(
        'Tanıyı kopyalayın; direct STT backlog, ağ gecikmesi ve model kuyruğu metrikleriyle karşılaştırın.',
      ),
    ).toBeInTheDocument();
  });

  it('flags low word coverage when audio is active but transcript text is sparse', () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000000,
    });
    const withFirstSparseSegment = upsertTranscriptSegment(recording, {
      id: 'seg-1',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820010000,
      status: 'draft',
      text: 'Merhaba',
      source: 'direct-stream',
      receivedAtMs: 1781820010200,
    });
    const withSparseTranscript = upsertTranscriptSegment(withFirstSparseSegment, {
      id: 'seg-2',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820058000,
      status: 'draft',
      text: 'Tamam',
      source: 'direct-stream',
      receivedAtMs: 1781820059200,
    });

    render(
      <TranscriptPanel
        session={withSparseTranscript}
        stream={{
          directConfigured: true,
          directReady: true,
          directActive: true,
          audioRms: 0.032,
          audioActive: true,
          lastAudioAtMs: 1781820060000,
          disabledReason: null,
        }}
      />,
    );

    const flowHealth = screen.getByLabelText('Transkript akış kalitesi');
    expect(within(flowHealth).getByText('Metin kapsamı düşük')).toBeInTheDocument();
    expect(within(flowHealth).getByText('2')).toBeInTheDocument();
    expect(within(flowHealth).getByText('2.0 kelime/dk')).toBeInTheDocument();
    expect(
      within(flowHealth).getByText(
        'Ses var ama kelime üretim hızı düşük; konuşmanın önemli kısmı transcript akışına düşmüyor olabilir.',
      ),
    ).toBeInTheDocument();
    expect(
      within(flowHealth).getByText(
        'Tanıyı kopyalayın; kaynak kalite gate’i bu transcripti review’da tutar, çıktı üretimi öncesi mikrofon/direct STT zinciri doğrulanmalı.',
      ),
    ).toBeInTheDocument();
  });

  it('does not show transcript lag while capture is silent', () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000123,
    });
    const withTranscript = upsertTranscriptSegment(recording, {
      id: 'seg-1',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820001000,
      status: 'final',
      text: 'Son metin geldi',
      source: 'direct-stream',
      receivedAtMs: 1781820002000,
    });

    render(
      <TranscriptPanel
        session={withTranscript}
        stream={{
          directConfigured: true,
          directReady: true,
          directActive: true,
          audioRms: 0.004,
          audioActive: false,
          lastAudioAtMs: 1781820011000,
          disabledReason: null,
        }}
      />,
    );

    expect(screen.getByText('Sessiz · RMS 0.004')).toBeInTheDocument();
    expect(screen.queryByText(/Gecikiyor/)).not.toBeInTheDocument();
  });

  it('hides stale direct STT preflight text once recording stream is active', () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000123,
    });

    render(
      <TranscriptPanel
        session={recording}
        stream={{
          directConfigured: true,
          directReady: true,
          directActive: true,
          disabledReason: null,
          preflight: {
            status: 'checking',
            message: 'Direct STT kayıt sırasında bağlanacak...',
            checkedAtMs: null,
            elapsedMs: null,
            stage: null,
          },
        }}
      />,
    );

    expect(screen.getByText('Kelime akışı aktif')).toBeInTheDocument();
    expect(screen.queryByText('Direct STT kayıt sırasında bağlanacak...')).not.toBeInTheDocument();
  });
});
