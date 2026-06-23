// @vitest-environment jsdom

/**
 * KVKK consent diyaloğu testleri (ADR-0030 / cross-AI review M19-3, should-fix).
 *
 * Kapsam: rıza geçerliliği için kritik davranışlar —
 * - İptal kaydı başlatmaz (onAccept çağrılmaz)
 * - Onay kaydı başlatır (onAccept çağrılır)
 * - Escape iptal eder
 * - Modal a11y (role=dialog, aria-modal, focus)
 * - Focus-trap (Tab/Shift+Tab modal içinde döner)
 * - Versiyonlanmış rıza metni gösterilir
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { ConsentDialog, CONSENT_VERSION, CONSENT_TEXT_HASH, CONSENT_LOCALE } from './ConsentDialog';

afterEach(() => {
  cleanup();
});

describe('ConsentDialog', () => {
  it('İptal tıklanınca onCancel çağrılır, onAccept ÇAĞRILMAZ (kayıt başlamaz)', () => {
    const onAccept = vi.fn();
    const onCancel = vi.fn();
    render(<ConsentDialog onAccept={onAccept} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole('button', { name: /İptal/i }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('Onayla tıklanınca onAccept çağrılır (kayıt başlar)', () => {
    const onAccept = vi.fn();
    const onCancel = vi.fn();
    render(<ConsentDialog onAccept={onAccept} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole('button', { name: /Onaylıyorum/i }));

    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('Escape tuşu iptal eder (onCancel), onAccept ÇAĞRILMAZ', () => {
    const onAccept = vi.fn();
    const onCancel = vi.fn();
    render(<ConsentDialog onAccept={onAccept} onCancel={onCancel} />);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('modal a11y: role=dialog + aria-modal + label/description bağları', () => {
    render(<ConsentDialog onAccept={vi.fn()} onCancel={vi.fn()} />);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby', 'consent-title');
    expect(dialog).toHaveAttribute('aria-describedby', 'consent-body');
  });

  it('açılışta odak modal kapsayıcıya/onay butonuna taşınır', () => {
    render(<ConsentDialog onAccept={vi.fn()} onCancel={vi.fn()} />);
    // autoFocus onay butonunda; odak modal sınırları içinde olmalı.
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('focus-trap: son elemandan Tab ilk elemana döner', () => {
    render(<ConsentDialog onAccept={vi.fn()} onCancel={vi.fn()} />);

    const cancelBtn = screen.getByRole('button', { name: /İptal/i });
    const acceptBtn = screen.getByRole('button', { name: /Onaylıyorum/i });

    // Son odaklanabilir eleman (accept) üzerindeyken Tab → ilk elemana (cancel) sarmalı.
    acceptBtn.focus();
    expect(document.activeElement).toBe(acceptBtn);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });
    expect(document.activeElement).toBe(cancelBtn);
  });

  it('focus-trap: ilk elemandan Shift+Tab son elemana döner', () => {
    render(<ConsentDialog onAccept={vi.fn()} onCancel={vi.fn()} />);

    const cancelBtn = screen.getByRole('button', { name: /İptal/i });
    const acceptBtn = screen.getByRole('button', { name: /Onaylıyorum/i });

    cancelBtn.focus();
    expect(document.activeElement).toBe(cancelBtn);
    fireEvent.keyDown(screen.getByRole('dialog'), {
      key: 'Tab',
      shiftKey: true,
    });
    expect(document.activeElement).toBe(acceptBtn);
  });

  it('versiyonlanmış rıza metni gösterilir (ispat değeri)', () => {
    render(<ConsentDialog onAccept={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(new RegExp(CONSENT_VERSION))).toBeInTheDocument();
  });

  it('consent sabitleri ispat zinciri için sabit kalır', () => {
    expect(CONSENT_VERSION).toBe('1.0.0');
    expect(CONSENT_TEXT_HASH).toMatch(/^sha256:/);
    expect(CONSENT_LOCALE).toBe('tr-TR');
  });
});
