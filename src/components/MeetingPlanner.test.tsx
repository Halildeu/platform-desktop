// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MeetingPlanner } from './MeetingPlanner';

afterEach(cleanup);

describe('MeetingPlanner', () => {
  it('keeps scheduling fields behind an explicit planning command', () => {
    const onOpen = vi.fn();
    const { rerender } = render(
      <MeetingPlanner
        open={false}
        pending={false}
        sttProvider="internal"
        transcriptionMode="realtime"
        onOpen={onOpen}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Toplantı planla' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('textbox', { name: 'Toplantı başlığı' })).not.toBeInTheDocument();

    rerender(
      <MeetingPlanner
        open
        pending={false}
        sttProvider="internal"
        transcriptionMode="realtime"
        onOpen={onOpen}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByRole('textbox', { name: 'Toplantı başlığı' })).toBeInTheDocument();
    expect(screen.getByLabelText('Başlangıç')).toHaveAttribute('type', 'datetime-local');
    expect(screen.getByLabelText('Bitiş')).toHaveAttribute('type', 'datetime-local');
  });

  it('rejects an end before start and submits canonical ISO instants with provider', () => {
    const onSubmit = vi.fn();
    render(
      <MeetingPlanner
        open
        pending={false}
        sttProvider="internal"
        transcriptionMode="realtime"
        onOpen={vi.fn()}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByRole('textbox', { name: 'Toplantı başlığı' }), {
      target: { value: 'Faz 24 ürün değerlendirmesi' },
    });
    fireEvent.change(screen.getByLabelText('Başlangıç'), {
      target: { value: '2026-08-02T11:00' },
    });
    fireEvent.change(screen.getByLabelText('Bitiş'), {
      target: { value: '2026-08-02T10:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Toplantıyı oluştur' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Bitiş zamanı başlangıç zamanından sonra olmalı.',
    );
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Bitiş'), {
      target: { value: '2026-08-02T12:00' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Transkripsiyon sağlayıcısı' }), {
      target: { value: 'speechmatics' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Toplantıyı oluştur' }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Faz 24 ürün değerlendirmesi',
        scheduledStart: expect.stringMatching(/^2026-08-02T/),
        scheduledEnd: expect.stringMatching(/^2026-08-02T/),
        sttProvider: 'speechmatics',
        transcriptionMode: 'realtime',
      }),
    );
  });
});
