// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MeetingResultPicker } from './MeetingResultPicker';

const VIEWER_ID = '33333333-3333-4333-8333-333333333333';
const RECORDER_ID = '22222222-2222-4222-8222-222222222222';

const MEETING = {
  id: VIEWER_ID,
  title: 'Kalıcı ürün değerlendirmesi',
  status: 'COMPLETED',
  scheduledStart: '2026-07-11T19:00:00.000Z',
  scheduledEnd: '2026-07-11T20:00:00.000Z',
  createdAt: '2026-07-11T18:55:00.000Z',
  updatedAt: '2026-07-11T20:00:00.000Z',
};

afterEach(cleanup);

describe('MeetingResultPicker', () => {
  it('offers the rest of the list and a title search beyond the first page', () => {
    const onLoadMore = vi.fn();
    const onSearch = vi.fn();
    render(
      <MeetingResultPicker
        meetings={[MEETING]}
        status="ready"
        error={null}
        totalElements={287}
        selectedMeetingId={null}
        recordingMeetingId={null}
        selectionLocked={false}
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
        onLoadMore={onLoadMore}
        onSearch={onSearch}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Daha fazla yükle (286 daha)' }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Toplantı başlığında ara' }), {
      target: { value: 'test2persembe' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ara' }));
    expect(onSearch).toHaveBeenCalledWith('test2persembe');
  });

  it('shows the active filter and clears it', () => {
    const onSearch = vi.fn();
    render(
      <MeetingResultPicker
        meetings={[MEETING]}
        status="ready"
        error={null}
        totalElements={1}
        selectedMeetingId={null}
        recordingMeetingId={null}
        selectionLocked={false}
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
        onLoadMore={vi.fn()}
        titleQuery="Kalıcı"
        onSearch={onSearch}
      />,
    );

    expect(screen.getByText('“Kalıcı” için 1 gösteriliyor')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Daha fazla yükle/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Temizle' }));
    expect(onSearch).toHaveBeenCalledWith('');
  });

  it('renders bounded meeting metadata and keeps viewer and recorder targets explicit', () => {
    const onSelect = vi.fn();
    render(
      <MeetingResultPicker
        meetings={[MEETING]}
        status="ready"
        error={null}
        totalElements={1}
        selectedMeetingId={VIEWER_ID}
        recordingMeetingId={RECORDER_ID}
        selectionLocked={false}
        onSelect={onSelect}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByRole('option', { name: /Kalıcı ürün değerlendirmesi/ })).toBeInTheDocument();
    expect(screen.getByText('33333333...3333')).toBeInTheDocument();
    expect(screen.getByText('22222222...2222')).toBeInTheDocument();
    expect(
      screen.getByText('Geçmiş çıktı açık; aktif kayıt hedefi değişmedi.'),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: VIEWER_ID } });
    expect(onSelect).toHaveBeenCalledWith(VIEWER_ID);
  });

  it('locks selection for the entire recording lifecycle while leaving refresh state visible', () => {
    render(
      <MeetingResultPicker
        meetings={[MEETING]}
        status="ready"
        error={null}
        totalElements={1}
        selectedMeetingId={VIEWER_ID}
        recordingMeetingId={RECORDER_ID}
        selectionLocked
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByRole('combobox')).toBeDisabled();
    expect(
      screen.getByText('Kayıt veya sonuç hazırlama sürerken çıktı seçimi kilitli.'),
    ).toBeInTheDocument();
  });

  it('preserves an unlisted selected meeting and exposes list errors without hiding it', () => {
    render(
      <MeetingResultPicker
        meetings={[]}
        status="error"
        error="Toplantılar alınamadı: network=UND_ERR_SOCKET"
        totalElements={0}
        selectedMeetingId={VIEWER_ID}
        recordingMeetingId={RECORDER_ID}
        selectionLocked={false}
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('network=UND_ERR_SOCKET');
    expect(screen.getByRole<HTMLSelectElement>('combobox').value).toBe(VIEWER_ID);
    expect(screen.getByRole('option', { name: /Mevcut toplantı/ })).toBeInTheDocument();
  });
});
