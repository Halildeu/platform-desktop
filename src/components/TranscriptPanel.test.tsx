// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { buildTranscriptTurns, TranscriptPanel } from './TranscriptPanel';
import {
  collapseAssembledFragments,
  initialTranscriptSession,
  startTranscriptSession,
  type TranscriptSegment,
  upsertTranscriptSegment,
} from '../transcript/session-transcript';

async function switchToRowsView(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: 'Satırlar' }));
}

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

  it('renders newest transcript segment first while keeping statuses visible', async () => {
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
    await switchToRowsView();

    expect(screen.getByText('Direct stream')).toBeInTheDocument();
    expect(screen.getByText('Kelime akışı aktif')).toBeInTheDocument();
    expect(screen.getByText(clock(1781820065123))).toBeInTheDocument();
    const articles = screen.getAllByRole('article');
    expect(articles).toHaveLength(2);
    expect(articles[0]).toHaveTextContent('İlk karar kaydedildi');
    expect(articles[0]).toHaveTextContent('Final');
    expect(articles[0]).toHaveTextContent('Gateway');
    expect(articles[0]).not.toHaveClass('segment-live');
    expect(articles[1]).toHaveTextContent('İkinci cümle işleniyor');
    expect(articles[1]).toHaveTextContent('Taslak');
    expect(articles[1]).toHaveTextContent('Direct STT');
    expect(articles[1]).toHaveTextContent('Canlı');
    expect(articles[1]).toHaveClass('segment-live');
    expect(articles[1]).toHaveTextContent('180 ms');
  });

  it('groups adjacent gateway segments from the same speaker into one visible turn', async () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-SPEECHMATICS',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000000,
    });
    const first = upsertTranscriptSegment(recording, {
      id: 'gateway:0',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820001000,
      status: 'final',
      text: 'İlk düşünce aynı konuşmacıya ait.',
      source: 'gateway-events',
    });
    const second = upsertTranscriptSegment(first, {
      id: 'gateway:1',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820003000,
      status: 'final',
      text: 'Devamı yeni kart yerine aynı turn içinde kalır.',
      source: 'gateway-events',
    });
    const speakerChange = upsertTranscriptSegment(second, {
      id: 'gateway:2',
      speakerLabel: 'Konuşmacı 2',
      startedAtMs: 1781820005000,
      status: 'final',
      text: 'Konuşmacı değişince yeni turn açılır.',
      source: 'gateway-events',
    });

    render(<TranscriptPanel session={speakerChange} />);
    await switchToRowsView();

    const turns = screen.getAllByRole('article');
    expect(turns).toHaveLength(2);
    expect(turns[0]).toHaveTextContent('İlk düşünce aynı konuşmacıya ait.');
    expect(turns[0]).toHaveTextContent('Devamı yeni kart yerine aynı turn içinde kalır.');
    expect(turns[1]).toHaveTextContent('Konuşmacı değişince yeni turn açılır.');
    expect(
      [...turns[0].querySelectorAll('.transcript-turn-paragraph > p')].map(
        (paragraph) => paragraph.textContent,
      ),
    ).toEqual([
      'İlk düşünce aynı konuşmacıya ait.',
      'Devamı yeni kart yerine aynı turn içinde kalır.',
    ]);
    expect(within(turns[0]).getByText('2 paragraf')).toBeInTheDocument();
    expect(within(turns[0]).getAllByRole('time')).toHaveLength(2);
  });

  it('defaults to the fluent view: sentence-bounded flow with an inline live tail', () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-FLUENT',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000000,
    });
    const first = upsertTranscriptSegment(recording, {
      id: 'gateway:f0',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820001000,
      status: 'final',
      text: 'Bu toplantıda bütçe ve',
      source: 'gateway-events',
    });
    const second = upsertTranscriptSegment(first, {
      id: 'gateway:f1',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820003000,
      status: 'final',
      text: 'proje planını değerlendiriyoruz.',
      source: 'gateway-events',
    });
    const withTail = upsertTranscriptSegment(second, {
      id: 'gateway:f2',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820005000,
      status: 'draft',
      text: 'şimdi görev dağılımına',
      source: 'gateway-events',
    });

    render(<TranscriptPanel session={withTail} />);

    const flow = screen.getByTestId('turn-flow');
    const paragraphs = flow.querySelectorAll('.turn-flow-paragraph');
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]).toHaveTextContent(
      'Bu toplantıda bütçe ve proje planını değerlendiriyoruz.',
    );
    const tail = screen.getByTestId('turn-flow-tail');
    expect(tail).toHaveTextContent('şimdi görev dağılımına');
    expect(screen.queryByRole('button', { name: 'Metni düzelt' })).toBeNull();
  });

  it('keeps canonical input order for equal timestamps and splits source or silence boundaries', () => {
    const turns = buildTranscriptTurns([
      {
        id: 'gateway:session:window:10',
        speakerLabel: 'Konuşmacı',
        startedAtMs: 1000,
        status: 'final',
        text: 'Önce gelen',
        source: 'gateway-events',
      },
      {
        id: 'gateway:session:window:2',
        speakerLabel: 'Konuşmacı',
        startedAtMs: 1000,
        status: 'final',
        text: 'Sonra gelen',
        source: 'gateway-events',
      },
      {
        id: 'direct:1',
        speakerLabel: 'Konuşmacı',
        startedAtMs: 2000,
        status: 'draft',
        text: 'Direct ayrı kalır',
        source: 'direct-stream',
      },
      {
        id: 'gateway:session:window:11',
        speakerLabel: 'Konuşmacı',
        startedAtMs: 40_000,
        status: 'final',
        text: 'Uzun sessizlikten sonra ayrı kalır',
        source: 'gateway-events',
      },
    ]);

    expect(turns).toHaveLength(3);
    expect(turns[0].segments.map((segment) => segment.id)).toEqual([
      'gateway:session:window:2',
      'gateway:session:window:10',
    ]);
    expect(turns[1].segments.map((segment) => segment.id)).toEqual(['direct:1']);
    expect(turns[2].segments.map((segment) => segment.id)).toEqual(['gateway:session:window:11']);
  });

  it('uses source-audio silence and bounded blocks for the production single-speaker stream', () => {
    const longSegment: TranscriptSegment = {
      id: 'gateway:session:window:0',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 0,
      endedAtMs: 60_000,
      timingBasis: 'source',
      status: 'final',
      text: 'Uzun açıklama',
      source: 'gateway-events',
    };
    const continuousSegment: TranscriptSegment = {
      ...longSegment,
      id: 'gateway:session:window:1',
      startedAtMs: 60_100,
      endedAtMs: 61_000,
      text: 'Kısa sessizlikten sonra devam',
    };
    const boundedSegments = Array.from({ length: 41 }, (_, index) => ({
      ...longSegment,
      id: `gateway:bounded:window:${index}`,
      startedAtMs: index * 1_000,
      endedAtMs: index * 1_000 + 900,
      text: `Paragraf ${index}`,
    }));

    expect(buildTranscriptTurns([longSegment, continuousSegment])).toHaveLength(1);
    expect(buildTranscriptTurns(boundedSegments).map((turn) => turn.segments.length)).toEqual([
      40, 1,
    ]);
  });

  it('keeps non-window equal-timestamp events in arrival order', () => {
    const sameTimestamp = 1781820001000;
    const turns = buildTranscriptTurns([
      {
        id: 'event:z-first-arrival',
        speakerLabel: 'Konuşmacı',
        startedAtMs: sameTimestamp,
        status: 'final',
        text: 'İlk gelen',
        source: 'gateway-events',
      },
      {
        id: 'event:a-second-arrival',
        speakerLabel: 'Konuşmacı',
        startedAtMs: sameTimestamp,
        status: 'final',
        text: 'İkinci gelen',
        source: 'gateway-events',
      },
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0].segments.map((segment) => segment.id)).toEqual([
      'event:z-first-arrival',
      'event:a-second-arrival',
    ]);
  });

  it('keeps same-timestamp source boundaries on distinct turn identities', () => {
    const sameTimestamp = 1781820001000;
    const turns = buildTranscriptTurns([
      {
        id: 'gateway:session:window:0',
        speakerLabel: 'Konuşmacı',
        startedAtMs: sameTimestamp,
        status: 'final',
        text: 'Gateway satırı',
        source: 'gateway-events',
      },
      {
        id: 'stream:0',
        speakerLabel: 'Konuşmacı',
        startedAtMs: sameTimestamp,
        status: 'draft',
        text: 'Direct satırı',
        source: 'direct-stream',
      },
    ]);

    expect(turns).toHaveLength(2);
    expect(new Set(turns.map((turn) => turn.id)).size).toBe(2);
  });

  it('groups adjacent direct-stream segments into the same live turn', () => {
    const turns = buildTranscriptTurns([
      {
        id: 'stream:0',
        speakerLabel: 'Konuşmacı',
        startedAtMs: 1000,
        status: 'final',
        text: 'Canlı cümlenin ilk bölümü',
        source: 'direct-stream',
      },
      {
        id: 'stream:1',
        speakerLabel: 'Konuşmacı',
        startedAtMs: 2000,
        status: 'draft',
        text: 'Canlı cümlenin devamı',
        source: 'direct-stream',
      },
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0].segments).toHaveLength(2);
  });

  it('groups adjacent segments when their source is not yet classified', () => {
    const turns = buildTranscriptTurns([
      {
        id: 'unclassified:0',
        speakerLabel: 'Konuşmacı',
        startedAtMs: 1000,
        status: 'final',
        text: 'İlk sınıflandırılmamış parça',
      },
      {
        id: 'unclassified:1',
        speakerLabel: 'Konuşmacı',
        startedAtMs: 2000,
        status: 'final',
        text: 'Devam eden sınıflandırılmamış parça',
      },
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0].segments).toHaveLength(2);
  });

  it('enforces exact silence and maximum-span turn boundaries', () => {
    const base: TranscriptSegment = {
      id: 'gateway:boundary:window:0',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 0,
      endedAtMs: 1000,
      timingBasis: 'source',
      status: 'final',
      text: 'Başlangıç',
      source: 'gateway-events',
    };
    const exactGap = {
      ...base,
      id: 'gateway:boundary:window:1',
      startedAtMs: 31_000,
      endedAtMs: 32_000,
      text: 'Tam eşik',
    };
    const overGap = {
      ...base,
      id: 'gateway:boundary:window:4',
      startedAtMs: 31_001,
      endedAtMs: 32_001,
      text: 'Eşik üstü',
    };
    const longBase = {
      ...base,
      endedAtMs: 119_500,
    };
    const exactSpan = {
      ...base,
      id: 'gateway:boundary:window:2',
      startedAtMs: 120_000,
      endedAtMs: 120_500,
      text: 'Tam span',
    };
    const overSpan = {
      ...base,
      id: 'gateway:boundary:window:3',
      startedAtMs: 120_001,
      endedAtMs: 120_500,
      text: 'Span üstü',
    };

    expect(buildTranscriptTurns([base, exactGap])).toHaveLength(1);
    expect(buildTranscriptTurns([base, overGap])).toHaveLength(2);
    expect(buildTranscriptTurns([longBase, exactSpan])).toHaveLength(1);
    expect(buildTranscriptTurns([longBase, overSpan])).toHaveLength(2);
  });

  it('keeps turn identities unique when the segment cap splits equal timestamps', () => {
    const equalTimestampSegments: TranscriptSegment[] = Array.from({ length: 41 }, (_, index) => ({
      id: `gateway:equal-cap:window:${index}`,
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1000,
      endedAtMs: 2000,
      timingBasis: 'source',
      status: 'final',
      text: `Paragraf ${index}`,
      source: 'gateway-events',
    }));

    const turns = buildTranscriptTurns(equalTimestampSegments);

    expect(turns.map((turn) => turn.segments.length)).toEqual([40, 1]);
    expect(new Set(turns.map((turn) => turn.id)).size).toBe(2);
  });

  it('keeps the turn DOM identity when an assembled utterance replaces its first fragment', () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-STABLE-TURN',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000000,
    });
    const firstFragment = upsertTranscriptSegment(recording, {
      id: 'gateway:fragment',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820001000,
      status: 'draft',
      text: 'İlk parça',
      source: 'gateway-events',
    });
    const withContinuation = upsertTranscriptSegment(firstFragment, {
      id: 'gateway:continuation',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820002000,
      status: 'final',
      text: 'Devam',
      source: 'gateway-events',
    });
    const { rerender } = render(<TranscriptPanel session={withContinuation} />);
    const originalTurn = screen.getByRole('article');
    const collapsed = collapseAssembledFragments(withContinuation, ['gateway:fragment']);
    const withUtterance = upsertTranscriptSegment(collapsed, {
      id: 'gateway:utterance',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820001000,
      status: 'utterance',
      text: 'İlk parça tamamlandı.',
      source: 'gateway-events',
    });

    rerender(<TranscriptPanel session={withUtterance} />);

    expect(screen.getByRole('article')).toBe(originalTurn);
  });

  it('keeps the turn DOM identity when an earlier segment joins the same turn', () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-EARLIER-TURN',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000000,
    });
    const later = upsertTranscriptSegment(recording, {
      id: 'gateway:earlier-turn:window:1',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820002000,
      status: 'final',
      text: 'Sonradan görülen paragraf',
      source: 'gateway-events',
    });
    const { rerender } = render(<TranscriptPanel session={later} />);
    const originalTurn = screen.getByRole('article');
    const withEarlier = upsertTranscriptSegment(later, {
      id: 'gateway:earlier-turn:window:0',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820001000,
      status: 'final',
      text: 'Daha erken gelen paragraf',
      source: 'gateway-events',
    });

    rerender(<TranscriptPanel session={withEarlier} />);

    expect(screen.getByRole('article')).toBe(originalTurn);
    expect(originalTurn).toHaveTextContent('Daha erken gelen paragraf');
    expect(originalTurn).toHaveTextContent('Sonradan görülen paragraf');
  });

  it('keeps later turn DOM identities when a new turn is inserted in the middle', () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-MIDDLE-TURN',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000000,
    });
    const first = upsertTranscriptSegment(recording, {
      id: 'gateway:middle:window:0',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820001000,
      status: 'final',
      text: 'İlk turn',
      source: 'gateway-events',
    });
    const last = upsertTranscriptSegment(first, {
      id: 'gateway:middle:window:2',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820080000,
      status: 'final',
      text: 'Son turn',
      source: 'gateway-events',
    });
    const { rerender } = render(<TranscriptPanel session={last} />);
    const originalLastTurn = screen.getAllByRole('article')[1];
    const withMiddle = upsertTranscriptSegment(last, {
      id: 'gateway:middle:window:1',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820040000,
      status: 'final',
      text: 'Araya giren turn',
      source: 'gateway-events',
    });

    rerender(<TranscriptPanel session={withMiddle} />);

    expect(screen.getAllByRole('article')).toHaveLength(3);
    expect(screen.getByText('Son turn').closest('article')).toBe(originalLastTurn);
  });

  it('stops following the latest paragraph while the user reads earlier transcript', async () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-SCROLL-GUARD',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000000,
    });
    const first = upsertTranscriptSegment(recording, {
      id: 'gateway:scroll:window:0',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820001000,
      status: 'final',
      text: 'İlk paragraf',
      source: 'gateway-events',
    });
    const { rerender } = render(<TranscriptPanel session={first} />);
    const list = document.querySelector('.transcript-list') as HTMLDivElement;
    Object.defineProperties(list, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    });
    fireEvent.scroll(list);
    const second = upsertTranscriptSegment(first, {
      id: 'gateway:scroll:window:1',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820002000,
      status: 'final',
      text: 'Yeni paragraf',
      source: 'gateway-events',
    });

    rerender(<TranscriptPanel session={second} />);

    expect(list.scrollTop).toBe(100);

    await userEvent.type(screen.getByPlaceholderText('Transkriptte ara'), 'İlk');
    expect(list.scrollTop).toBe(100);
    await userEvent.clear(screen.getByPlaceholderText('Transkriptte ara'));
    expect(list.scrollTop).toBe(100);

    list.scrollTop = 800;
    fireEvent.scroll(list);
    const third = upsertTranscriptSegment(second, {
      id: 'gateway:scroll:window:2',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820003000,
      status: 'final',
      text: 'En alta dönünce izlenen paragraf',
      source: 'gateway-events',
    });
    rerender(<TranscriptPanel session={third} />);

    expect(list.scrollTop).toBe(800);
  });

  it('keeps following live text when the latest segment grows under the same id', () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-LIVE-TAIL',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000000,
    });
    const partial = upsertTranscriptSegment(recording, {
      id: 'gateway:live-tail:window:0',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820001000,
      status: 'draft',
      text: 'Canlı cümle',
      source: 'gateway-events',
      receivedAtMs: 1781820001100,
    });
    const { rerender } = render(<TranscriptPanel session={partial} />);
    const list = document.querySelector('.transcript-list') as HTMLDivElement;
    Object.defineProperties(list, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, writable: true, value: 800 },
    });
    const expanded = upsertTranscriptSegment(partial, {
      id: 'gateway:live-tail:window:0',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820001000,
      status: 'draft',
      text: 'Canlı cümle büyümeye devam ediyor',
      source: 'gateway-events',
      receivedAtMs: 1781820001500,
    });

    rerender(<TranscriptPanel session={expanded} />);

    expect(list.scrollTop).toBe(800);
  });

  it('keeps review and edit actions bound to the selected paragraph segment', async () => {
    const onSegmentReviewed = vi.fn();
    const onSegmentTextChange = vi.fn();
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-EDIT-TURN',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000000,
    });
    const first = upsertTranscriptSegment(recording, {
      id: 'gateway:first',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820001000,
      status: 'final',
      text: 'İlk paragraf',
      source: 'gateway-events',
    });
    const second = upsertTranscriptSegment(first, {
      id: 'gateway:second',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820002000,
      status: 'final',
      text: 'İkinci paragraf',
      source: 'gateway-events',
    });

    render(
      <TranscriptPanel
        session={second}
        onSegmentReviewed={onSegmentReviewed}
        onSegmentTextChange={onSegmentTextChange}
      />,
    );
    await switchToRowsView();

    const paragraphs = document.querySelectorAll('.transcript-turn-paragraph');
    expect(paragraphs).toHaveLength(2);
    await userEvent.click(
      within(paragraphs[1] as HTMLElement).getByRole('button', { name: 'İncelendi' }),
    );
    expect(onSegmentReviewed).toHaveBeenCalledWith('gateway:second');

    await userEvent.click(
      within(paragraphs[1] as HTMLElement).getByRole('button', { name: 'Metni düzelt' }),
    );
    const editor = within(paragraphs[1] as HTMLElement).getByLabelText('Transkript metni');
    await userEvent.clear(editor);
    await userEvent.type(editor, 'İkinci paragraf düzeltildi');
    await userEvent.click(
      within(paragraphs[1] as HTMLElement).getByRole('button', { name: 'Kaydet' }),
    );
    expect(onSegmentTextChange).toHaveBeenCalledWith(
      'gateway:second',
      'İkinci paragraf düzeltildi',
    );
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
    expect(within(flowHealth).getByText('Metin kapsamı düşük')).toBeInTheDocument();
    expect(within(flowHealth).getByText('1.9 satır/dk')).toBeInTheDocument();
    expect(within(flowHealth).getByText('16')).toBeInTheDocument();
    expect(within(flowHealth).getByText('15 kelime/dk')).toBeInTheDocument();
    expect(within(flowHealth).getByText('Direct 1 / Gateway 1')).toBeInTheDocument();
    expect(
      within(flowHealth).getByText(
        'Kayıt penceresine göre kelime üretim hızı düşük; konuşmanın önemli kısmı transcript akışına düşmüyor olabilir.',
      ),
    ).toBeInTheDocument();
    expect(within(flowHealth).getByText('Sonraki aksiyon')).toBeInTheDocument();
    expect(
      within(flowHealth).getByText(
        'Tanıyı kopyalayın; kaynak kalite gate’i bu transcripti review’da tutar, çıktı üretimi öncesi mikrofon/direct STT zinciri doğrulanmalı.',
      ),
    ).toBeInTheDocument();
  });

  it('searches long transcript rows without changing chronological order', async () => {
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
    const chronologicalArticles = screen.getAllByRole('article');
    expect(chronologicalArticles[0]).toHaveTextContent('Bütçe onayı');
    expect(chronologicalArticles.at(-1)).toHaveTextContent('Revize karar satırı');

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
    expect(directArticles[0]).toHaveTextContent('Canlı direct draft satırı');
    expect(directArticles[1]).toHaveTextContent('Direct revize toplantı satırı');
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
    await switchToRowsView();

    const articles = screen.getAllByRole('article');
    expect(within(articles[1]).queryByRole('button', { name: 'Metni düzelt' })).toBeNull();
    expect(within(articles[1]).queryByRole('button', { name: 'İncelendi' })).toBeNull();

    await userEvent.click(within(articles[0]).getByRole('button', { name: 'İncelendi' }));
    expect(onSegmentReviewed).toHaveBeenCalledWith('seg-final');

    await userEvent.click(within(articles[0]).getByRole('button', { name: 'Metni düzelt' }));
    const editor = within(articles[0]).getByLabelText('Transkript metni');
    await userEvent.clear(editor);
    await userEvent.type(editor, 'Düzeltilmiş toplantı satırı');
    await userEvent.click(within(articles[0]).getByRole('button', { name: 'Kaydet' }));

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
      timingBasis: 'source',
      status: 'final',
      text: 'İlk gündem maddesi konuşuldu',
      source: 'gateway-events',
    });
    const withSecondSpeaker = upsertTranscriptSegment(withFirstSpeaker, {
      id: 'seg-2',
      speakerLabel: 'Konuşmacı 2',
      startedAtMs: 1781820004000,
      endedAtMs: 1781820009000,
      timingBasis: 'source',
      status: 'final',
      text: 'İkinci konuşmacı aksiyonları anlattı',
      source: 'gateway-events',
    });
    const withSpeakerReturn = upsertTranscriptSegment(withSecondSpeaker, {
      id: 'seg-3',
      speakerLabel: 'Konuşmacı 1',
      startedAtMs: 1781820009000,
      endedAtMs: 1781820011000,
      timingBasis: 'source',
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
    expect(articles[0]).toHaveTextContent('İlk gündem maddesi konuşuldu');
    expect(articles.at(-1)).toHaveTextContent('Kapanış notu alındı');

    await userEvent.click(screen.getByRole('button', { name: 'Etiketleri sıfırla' }));
    expect(screen.queryByRole('button', { name: 'Etiketleri sıfırla' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Konuşmacı adı: Konuşmacı 1')).toHaveValue('Konuşmacı 1');
  });

  it('does not count silence between paragraphs as speaker talk time', () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-SPEAKER-DURATION',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000000,
    });
    const withFirst = upsertTranscriptSegment(recording, {
      id: 'gateway:duration:window:0',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820001000,
      endedAtMs: 1781820002000,
      timingBasis: 'source',
      status: 'final',
      text: 'İlk kısa paragraf',
      source: 'gateway-events',
    });
    const withSecond = upsertTranscriptSegment(withFirst, {
      id: 'gateway:duration:window:1',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820012000,
      endedAtMs: 1781820013000,
      timingBasis: 'source',
      status: 'final',
      text: 'Sessizlikten sonraki paragraf',
      source: 'gateway-events',
    });

    render(<TranscriptPanel session={withSecond} />);

    expect(screen.getByText('100% · 1 tur · 2 sn')).toBeInTheDocument();
  });

  it('does not count delivery latency as source speaker duration', () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-DELIVERY-DURATION',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000000,
    });
    const directPreview = upsertTranscriptSegment(recording, {
      id: 'direct:delivery',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820001000,
      endedAtMs: 1781820011000,
      timingBasis: 'delivery',
      status: 'final',
      text: 'Teslim gecikmeli önizleme',
      source: 'direct-stream',
    });
    const canonical = upsertTranscriptSegment(directPreview, {
      id: 'gateway:duration-source:window:0',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820012000,
      endedAtMs: 1781820014000,
      timingBasis: 'source',
      status: 'final',
      text: 'Kaynak zamanlı kalıcı satır',
      source: 'gateway-events',
    });

    render(<TranscriptPanel session={canonical} />);

    expect(screen.getByText('100% · 2 tur · 2 sn')).toBeInTheDocument();
  });

  it('does not render zero-valued speaker analytics without source timing', () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-DELIVERY-ONLY',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000000,
    });
    const deliveryOnly = upsertTranscriptSegment(recording, {
      id: 'direct:delivery-only',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820001000,
      endedAtMs: 1781820011000,
      timingBasis: 'delivery',
      status: 'final',
      text: 'Yalnız teslimat zamanlı önizleme',
      source: 'direct-stream',
    });

    render(<TranscriptPanel session={deliveryOnly} />);

    expect(screen.queryByLabelText('Konuşma dağılımı pasta grafiği')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Konuşmacı zaman çizgisi')).not.toBeInTheDocument();
    expect(screen.getByText('1 tur · kaynak zamanlaması bekleniyor')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Konuşmacı süreleri ve söz kesme sinyali için kaynak zamanlaması bekleniyor.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Kaynak zamanlaması olmadan overlap sonucu üretilmez.'),
    ).toBeInTheDocument();
  });

  it('keeps delivery-only speakers out of source-timed analytics in a mixed session', () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-MIXED-SPEAKER-TIMING',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000000,
    });
    const deliverySpeaker = upsertTranscriptSegment(recording, {
      id: 'direct:delivery-speaker',
      speakerLabel: 'Konuşmacı direct',
      startedAtMs: 1781820001000,
      endedAtMs: 1781820011000,
      timingBasis: 'delivery',
      status: 'final',
      text: 'Teslimat saatli önizleme',
      source: 'direct-stream',
    });
    const sourceSpeaker = upsertTranscriptSegment(deliverySpeaker, {
      id: 'gateway:source-speaker:window:0',
      speakerLabel: 'Konuşmacı gateway',
      startedAtMs: 1781820012000,
      endedAtMs: 1781820014000,
      timingBasis: 'source',
      status: 'final',
      text: 'Kaynak saatli kalıcı satır',
      source: 'gateway-events',
    });

    render(<TranscriptPanel session={sourceSpeaker} />);

    expect(screen.getByLabelText('Konuşma dağılımı pasta grafiği')).toBeInTheDocument();
    expect(screen.getByText('1 tur · kaynak zamanlaması bekleniyor')).toBeInTheDocument();
    expect(screen.getByText('100% · 1 tur · 2 sn')).toBeInTheDocument();
    expect(screen.queryByText('0% · 1 tur · -')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Konuşmacı zaman çizgisi').children).toHaveLength(1);
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
      timingBasis: 'source',
      status: 'final',
      text: 'Konuşmacı uzun bir açıklama yapıyor',
      source: 'gateway-events',
    });
    const withOverlap = upsertTranscriptSegment(withFirstSpeaker, {
      id: 'seg-2',
      speakerLabel: 'Konuşmacı 2',
      startedAtMs: 1781820004500,
      endedAtMs: 1781820007000,
      timingBasis: 'source',
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
        'Kayıt penceresine göre kelime üretim hızı düşük; konuşmanın önemli kısmı transcript akışına düşmüyor olabilir.',
      ),
    ).toBeInTheDocument();
    expect(
      within(flowHealth).getByText(
        'Tanıyı kopyalayın; kaynak kalite gate’i bu transcripti review’da tutar, çıktı üretimi öncesi mikrofon/direct STT zinciri doğrulanmalı.',
      ),
    ).toBeInTheDocument();
  });

  it('flags low word coverage after speech capture becomes quiet but the recording window stays sparse', () => {
    const recording = startTranscriptSession(initialTranscriptSession(), {
      sessionId: 'SES-1',
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'desktop-1',
      hasLoopback: false,
      startedAtMs: 1781820000000,
    });
    const withSparseTranscript = upsertTranscriptSegment(recording, {
      id: 'seg-1',
      speakerLabel: 'Konuşmacı',
      startedAtMs: 1781820040000,
      status: 'final',
      text: 'Kısa çıktı',
      source: 'direct-stream',
      receivedAtMs: 1781820041200,
    });

    render(
      <TranscriptPanel
        session={withSparseTranscript}
        stream={{
          directConfigured: true,
          directReady: true,
          directActive: true,
          audioRms: 0.001,
          audioActive: false,
          lastAudioAtMs: 1781820065000,
          disabledReason: null,
        }}
      />,
    );

    const flowHealth = screen.getByLabelText('Transkript akış kalitesi');
    expect(within(flowHealth).getByText('Metin kapsamı düşük')).toBeInTheDocument();
    expect(within(flowHealth).getByText('1.8 kelime/dk')).toBeInTheDocument();
    expect(
      within(flowHealth).getByText(
        'Kayıt penceresine göre kelime üretim hızı düşük; konuşmanın önemli kısmı transcript akışına düşmüyor olabilir.',
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
