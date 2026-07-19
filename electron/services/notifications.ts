/**
 * Native OS notifications — #6. KVKK: transcript/audio içeriği asla
 * bildirim metnine konmaz, sadece durum (started/finished/error).
 */

import { Notification } from 'electron';

function notify(title: string, body: string, silent = false): void {
  if (!Notification.isSupported()) {
    return;
  }
  new Notification({ title, body, silent }).show();
}

export function notifyRecordingStarted(): void {
  notify('Kayıt başladı', 'Toplantı kaydı ve canlı transkript aktif.');
}

export function notifyRecordingFinished(): void {
  notify('Kayıt tamamlandı', 'Kayıt gönderildi, toplantı çıktısı hazırlanıyor.');
}

export function notifyRecordingDegraded(): void {
  notify(
    'Kayıt gönderildi',
    'Canlı transkriptin son onayı alınamadı; kalıcı toplantı sonucu işleniyor.',
    true,
  );
}

export function notifyRecordingError(message: string): void {
  // message zaten transcript-free hata sınıfı/kodu (App.tsx aynı kuralı uyguluyor).
  notify('Kayıt hatası', message, true);
}
