#!/usr/bin/env bash
# platform-desktop BUILD-only self-hosted runner entrypoint.
#
# Codex 019ee5aa SECURITY review absorb — deploy runner'dan (entrypoint.sh
# PAT-loop) AYRI, daha kilitli model:
#   - PAT YOK: container'da uzun-ömürlü credential bulunmaz. Registration
#     tek-seferlik token ile (host-side `gh api` üretir, .env'e 1h TTL).
#   - Non-ephemeral: .runner state persist → restart'ta yeniden registration
#     gerekmez (runner kendi job-listen credential'ı ile dinler).
#   - Job-completed hook ile her job sonrası _work wipe (state-poisoning guard).
#
# Required env:
#   RUNNER_REPO                 — Halildeu/platform-desktop
#   RUNNER_REGISTRATION_TOKEN   — tek-seferlik (sadece ilk config; sonra .runner)
#   RUNNER_NAME, RUNNER_LABELS  — kimlik + label

set -euo pipefail
cd /home/runner

: "${RUNNER_REPO:?RUNNER_REPO required}"
RUNNER_NAME="${RUNNER_NAME:-staging-sw-desktop-ci}"
RUNNER_LABELS="${RUNNER_LABELS:-self-hosted,staging-sw,platform-desktop-ci}"

# Runner-controlled cleanup hook — workflow YAML bunu devre dışı bırakamaz
# (job bittiğinde runner process çalıştırır). RO-mount + _work dışında.
export ACTIONS_RUNNER_HOOK_JOB_COMPLETED=/home/runner/hooks/cleanup.sh

if [ ! -f .runner ]; then
  : "${RUNNER_REGISTRATION_TOKEN:?RUNNER_REGISTRATION_TOKEN required for first registration}"
  echo "[desktop-ci] İlk registration (tek-seferlik token)..."
  ./config.sh \
    --url "https://github.com/${RUNNER_REPO}" \
    --token "${RUNNER_REGISTRATION_TOKEN}" \
    --name "${RUNNER_NAME}" \
    --labels "${RUNNER_LABELS}" \
    --work _work \
    --unattended \
    --replace
  echo "[desktop-ci] Registered: ${RUNNER_NAME} (labels: ${RUNNER_LABELS})"
else
  echo "[desktop-ci] Zaten configured (.runner mevcut); registration atlanıyor."
fi

# Token'ı env'den düşür (config sonrası gereksiz — child job process'lerine sızmasın).
unset RUNNER_REGISTRATION_TOKEN

echo "[desktop-ci] run.sh — job dinleniyor (non-ephemeral)."
exec ./run.sh
