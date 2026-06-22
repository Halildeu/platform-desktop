#!/usr/bin/env bash
# Runner JOB-COMPLETED hook (ACTIONS_RUNNER_HOOK_JOB_COMPLETED).
# Codex 019ee5aa #4 — non-ephemeral runner state-poisoning guard.
# Her job bittiğinde runner process bunu çalıştırır (workflow YAML
# kontrolünde DEĞİL). _work + npm cache + temp wipe → bir sonraki job
# temiz workspace'te başlar (planted-backdoor-for-next-job engellenir).
set -uo pipefail

rm -rf /home/runner/_work/_temp/* 2>/dev/null || true
# Repo workspace içeriğini temizle (checkout zaten fresh yapar; artık + node_modules sil).
find /home/runner/_work -mindepth 1 -maxdepth 2 -name node_modules -prune -exec rm -rf {} + 2>/dev/null || true
rm -rf /home/runner/.npm/_cacache 2>/dev/null || true
rm -rf /home/runner/_work/_actions/_temp* 2>/dev/null || true

echo "[cleanup-hook] _work/_temp + node_modules + npm cache temizlendi."
exit 0
