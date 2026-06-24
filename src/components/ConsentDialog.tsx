/**
 * KVKK rıza diyaloğu (ADR-0030).
 *
 * Kayıt başlamadan önce kullanıcıdan açık onay alır.
 * KVKK Md.5: kişisel veri işleme ancak açık rıza ile mümkündür.
 */

import { useEffect, useRef, useCallback, type ReactElement } from 'react';

export const CONSENT_VERSION = '1.0.0';
export const CONSENT_LOCALE = 'tr-TR';
export const CONSENT_INTRO =
  'Bu toplantının ses kaydı yapılacaktır. Kayıt, mikrofon ve varsa sistem sesi (toplantı uygulaması) verilerini içerir.';
export const CONSENT_BULLETS = [
  'Ses verileri şifreli olarak sunucuya iletilir.',
  'Kayıt yalnızca toplantı süresince aktiftir.',
  'Veriler KVKK kapsamında işlenir ve korunur.',
  'Cihazınızda ses verisi saklanmaz.',
] as const;
export const CONSENT_LEGAL =
  'Devam ederek ses kaydı yapılmasını ve verilerinizin yukarıda belirtilen amaçlarla işlenmesini kabul etmiş olursunuz (KVKK Md. 5).';
export const CONSENT_TEXT_TR = [CONSENT_INTRO, ...CONSENT_BULLETS, CONSENT_LEGAL].join('\n');
export const CONSENT_TEXT_HASH =
  'sha256:23e2c410ce570d2827a1049e58b398b0e4440357f7217f2fb51cedca16df1c62';

export interface ConsentDialogProps {
  onAccept: () => void;
  onCancel: () => void;
}

export function ConsentDialog({ onAccept, onCancel }: ConsentDialogProps): ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<Element | null>(null);

  useEffect(() => {
    previousFocusRef.current = document.activeElement;
    dialogRef.current?.focus();

    return () => {
      if (previousFocusRef.current instanceof HTMLElement) {
        previousFocusRef.current.focus();
      }
    };
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
        return;
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [onCancel],
  );

  return (
    <div className="consent-overlay" aria-hidden="false">
      <div
        ref={dialogRef}
        className="consent-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="consent-title"
        aria-describedby="consent-body"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <h2 id="consent-title">Ses Kaydı Onayı</h2>
        <div id="consent-body">
          <p>{CONSENT_INTRO}</p>
          <ul>
            {CONSENT_BULLETS.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="consent-legal">{CONSENT_LEGAL}</p>
          <p className="consent-version">Rıza metni sürümü: {CONSENT_VERSION}</p>
        </div>
        <div className="consent-actions">
          <button type="button" className="consent-cancel" onClick={onCancel}>
            İptal
          </button>
          <button type="button" className="consent-accept" onClick={onAccept} autoFocus>
            Onaylıyorum — Kaydı Başlat
          </button>
        </div>
      </div>
    </div>
  );
}
