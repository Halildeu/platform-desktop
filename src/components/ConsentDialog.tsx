/**
 * KVKK rıza diyaloğu (ADR-0030).
 *
 * Kayıt başlamadan önce kullanıcıdan açık onay alır.
 * KVKK Md.5: kişisel veri işleme ancak açık rıza ile mümkündür.
 */

export interface ConsentDialogProps {
  onAccept: () => void;
  onCancel: () => void;
}

export function ConsentDialog({ onAccept, onCancel }: ConsentDialogProps): React.ReactElement {
  return (
    <div className="consent-overlay">
      <div className="consent-dialog">
        <h2>Ses Kaydı Onayı</h2>
        <p>
          Bu toplantının ses kaydı yapılacaktır. Kayıt, mikrofon ve varsa sistem
          sesi (toplantı uygulaması) verilerini içerir.
        </p>
        <ul>
          <li>Ses verileri şifreli olarak sunucuya iletilir.</li>
          <li>Kayıt yalnızca toplantı süresince aktiftir.</li>
          <li>Veriler KVKK kapsamında işlenir ve korunur.</li>
          <li>Cihazınızda ses verisi saklanmaz.</li>
        </ul>
        <p className="consent-legal">
          Devam ederek ses kaydı yapılmasını ve verilerinizin yukarıda belirtilen
          amaçlarla işlenmesini kabul etmiş olursunuz (KVKK Md. 5).
        </p>
        <div className="consent-actions">
          <button type="button" className="consent-cancel" onClick={onCancel}>
            İptal
          </button>
          <button type="button" className="consent-accept" onClick={onAccept}>
            Onaylıyorum — Kaydı Başlat
          </button>
        </div>
      </div>
    </div>
  );
}
