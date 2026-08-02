import { useState, type FormEvent } from 'react';

import type { SttProvider, TranscriptionMode } from '../audio/capture';

export interface MeetingPlan {
  title: string;
  description: string;
  scheduledStart: string;
  scheduledEnd: string;
  sttProvider: SttProvider;
  transcriptionMode: TranscriptionMode;
}

interface MeetingPlannerProps {
  open: boolean;
  pending: boolean;
  sttProvider: SttProvider;
  transcriptionMode: TranscriptionMode;
  onOpen: () => void;
  onCancel: () => void;
  onSubmit: (plan: MeetingPlan) => void;
}

function toLocalDateTimeValue(date: Date): string {
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function defaultSchedule(): { start: string; end: string } {
  const start = new Date();
  start.setSeconds(0, 0);
  start.setMinutes(Math.ceil(start.getMinutes() / 15) * 15 + 15);
  const end = new Date(start.getTime() + 60 * 60_000);
  return {
    start: toLocalDateTimeValue(start),
    end: toLocalDateTimeValue(end),
  };
}

export function MeetingPlanner({
  open,
  pending,
  sttProvider,
  transcriptionMode,
  onOpen,
  onCancel,
  onSubmit,
}: MeetingPlannerProps) {
  const [{ start, end }] = useState(defaultSchedule);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [scheduledStart, setScheduledStart] = useState(start);
  const [scheduledEnd, setScheduledEnd] = useState(end);
  const [provider, setProvider] = useState<SttProvider>(sttProvider);
  const [mode, setMode] = useState<TranscriptionMode>(transcriptionMode);
  const [validationError, setValidationError] = useState('');

  if (!open) {
    return (
      <button className="primary-action" type="button" onClick={onOpen}>
        Toplantı planla
      </button>
    );
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const normalizedTitle = title.trim();
    const startAt = new Date(scheduledStart);
    const endAt = new Date(scheduledEnd);
    if (!normalizedTitle) {
      setValidationError('Toplantı başlığı gerekli.');
      return;
    }
    if (!Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime())) {
      setValidationError('Geçerli bir başlangıç ve bitiş zamanı seçin.');
      return;
    }
    if (endAt.getTime() <= startAt.getTime()) {
      setValidationError('Bitiş zamanı başlangıç zamanından sonra olmalı.');
      return;
    }
    setValidationError('');
    onSubmit({
      title: normalizedTitle,
      description: description.trim(),
      scheduledStart: startAt.toISOString(),
      scheduledEnd: endAt.toISOString(),
      sttProvider: provider,
      transcriptionMode: mode,
    });
  };

  return (
    <form
      className="meeting-planner"
      aria-labelledby="meeting-planner-title"
      onSubmit={handleSubmit}
    >
      <div className="meeting-planner-heading">
        <div>
          <h2 id="meeting-planner-title">Toplantı planla</h2>
          <p>Takvim bilgisini ve kayıt tercihini belirleyin.</p>
        </div>
        <button className="secondary-action compact-action" type="button" onClick={onCancel}>
          Vazgeç
        </button>
      </div>

      <label className="meeting-planner-field meeting-planner-field--wide">
        <span>Toplantı başlığı</span>
        <input
          type="text"
          value={title}
          maxLength={512}
          autoComplete="off"
          required
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>

      <label className="meeting-planner-field meeting-planner-field--wide">
        <span>Açıklama</span>
        <textarea
          value={description}
          maxLength={4000}
          rows={3}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>

      <div className="meeting-planner-grid">
        <label className="meeting-planner-field">
          <span>Başlangıç</span>
          <input
            type="datetime-local"
            value={scheduledStart}
            required
            onChange={(event) => setScheduledStart(event.target.value)}
          />
        </label>
        <label className="meeting-planner-field">
          <span>Bitiş</span>
          <input
            type="datetime-local"
            value={scheduledEnd}
            required
            onChange={(event) => setScheduledEnd(event.target.value)}
          />
        </label>
        <label className="meeting-planner-field meeting-planner-field--wide">
          <span>Transkripsiyon sağlayıcısı</span>
          <select
            value={provider}
            onChange={(event) => setProvider(event.target.value as SttProvider)}
          >
            <option value="internal">Dahili STT</option>
            <option value="speechmatics">Speechmatics</option>
          </select>
        </label>
        <fieldset className="meeting-planner-field meeting-planner-field--wide transcription-mode-field">
          <legend>Transkript görünümü</legend>
          <div className="segmented-control">
            <label>
              <input
                type="radio"
                name="transcription-mode"
                value="realtime"
                checked={mode === 'realtime'}
                onChange={() => setMode('realtime')}
              />
              <span>Anlık</span>
            </label>
            <label>
              <input
                type="radio"
                name="transcription-mode"
                value="balanced"
                checked={mode === 'balanced'}
                onChange={() => setMode('balanced')}
              />
              <span>Dengeli</span>
            </label>
          </div>
        </fieldset>
      </div>

      {validationError ? (
        <p className="meeting-planner-error" role="alert">
          {validationError}
        </p>
      ) : null}

      <div className="meeting-planner-actions">
        <button className="primary-action" type="submit" disabled={pending || !title.trim()}>
          {pending ? 'Oluşturuluyor...' : 'Toplantıyı oluştur'}
        </button>
      </div>
    </form>
  );
}
