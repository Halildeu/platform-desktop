import type { RecentMeetingSummary } from '../../electron/services/meeting/meeting-client';

export type RecentMeetingsStatus = 'idle' | 'loading' | 'ready' | 'error';

interface MeetingResultPickerProps {
  meetings: RecentMeetingSummary[];
  status: RecentMeetingsStatus;
  error: string | null;
  totalElements: number;
  selectedMeetingId: string | null;
  recordingMeetingId: string | null;
  selectionLocked: boolean;
  onSelect: (meetingId: string) => void;
  onRefresh: () => void;
}

function shortMeetingId(meetingId: string | null): string {
  if (!meetingId) {
    return '-';
  }
  return `${meetingId.slice(0, 8)}...${meetingId.slice(-4)}`;
}

function meetingOptionLabel(meeting: RecentMeetingSummary): string {
  const referenceDate = meeting.scheduledStart ?? meeting.updatedAt;
  const dateLabel = new Date(referenceDate).toLocaleString('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${meeting.title} · ${dateLabel}`;
}

export function MeetingResultPicker({
  meetings,
  status,
  error,
  totalElements,
  selectedMeetingId,
  recordingMeetingId,
  selectionLocked,
  onSelect,
  onRefresh,
}: MeetingResultPickerProps) {
  const selectedIsListed = meetings.some((meeting) => meeting.id === selectedMeetingId);
  const targetsDiffer =
    Boolean(selectedMeetingId) &&
    Boolean(recordingMeetingId) &&
    selectedMeetingId !== recordingMeetingId;

  return (
    <section className="meeting-result-picker" aria-labelledby="meeting-result-picker-title">
      <div className="meeting-result-picker-header">
        <div>
          <h2 id="meeting-result-picker-title">Toplantı listesi</h2>
          <p>
            {status === 'ready'
              ? `${meetings.length} gösteriliyor${
                  totalElements > meetings.length ? ` · toplam ${totalElements}` : ''
                }`
              : 'Kalıcı sonuçlar'}
          </p>
        </div>
        <button
          className="secondary-action compact-action"
          type="button"
          onClick={onRefresh}
          disabled={status === 'loading'}
          aria-label="Toplantıları yenile"
        >
          {status === 'loading' ? 'Yükleniyor...' : 'Yenile'}
        </button>
      </div>

      {status === 'error' ? (
        <p className="meeting-result-picker-error" role="alert">
          {error ?? 'Toplantılar alınamadı.'}
        </p>
      ) : null}

      <label className="meeting-result-picker-field">
        <span>Toplantı seçin</span>
        <select
          aria-label="Görüntülenecek toplantı"
          value={selectedMeetingId ?? ''}
          onChange={(event) => {
            if (event.target.value) {
              onSelect(event.target.value);
            }
          }}
          disabled={selectionLocked || (status === 'loading' && meetings.length === 0)}
        >
          <option value="" disabled>
            {status === 'loading'
              ? 'Toplantılar yükleniyor...'
              : meetings.length === 0
                ? 'Henüz toplantı yok'
                : 'Bir toplantı seçin'}
          </option>
          {!selectedIsListed && selectedMeetingId ? (
            <option value={selectedMeetingId}>
              Mevcut toplantı · {shortMeetingId(selectedMeetingId)}
            </option>
          ) : null}
          {meetings.map((meeting) => (
            <option key={meeting.id} value={meeting.id}>
              {meetingOptionLabel(meeting)}
            </option>
          ))}
        </select>
      </label>

      {selectedMeetingId ? (
        <details className="meeting-target-details">
          <summary>Teknik hedefler</summary>
          <dl className="meeting-targets">
            <div>
              <dt>Görüntülenen</dt>
              <dd>{shortMeetingId(selectedMeetingId)}</dd>
            </div>
            <div>
              <dt>Kayıt hedefi</dt>
              <dd>{shortMeetingId(recordingMeetingId)}</dd>
            </div>
          </dl>
          {targetsDiffer ? (
            <p className="meeting-target-note">Geçmiş çıktı açık; aktif kayıt hedefi değişmedi.</p>
          ) : null}
        </details>
      ) : null}
      {selectionLocked ? (
        <p className="meeting-target-note">
          Kayıt veya sonuç hazırlama sürerken çıktı seçimi kilitli.
        </p>
      ) : null}
    </section>
  );
}
