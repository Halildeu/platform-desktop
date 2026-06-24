# AGENTS.md — platform-desktop

Bu dosya repo içindeki en yüksek öncelikli giriş yüzeyidir.

## 1. Okuma Sırası

1. `AGENTS.md`
2. Global `~/.claude/CLAUDE.md` HARD RULE seti
3. `CLAUDE.md` (repo-specific tamamlayıcı)
4. `README.md` (proje + ekosistem haritası)

Soru tipine göre otoriter kaynak:

- **Mimari karar**: `docs/adr/*.md`
- **Aktif iş**: [Project #4 platform-ai Faz 24](https://github.com/users/Halildeu/projects/4) (Hedef Repo: platform-desktop filter)
- **Audio contract**: `platform-backend/audio-gateway-service/docs/contract-v1.md`
- **KVKK boundary**: `platform-k8s-gitops/docs/adr/0030-kvkk-meeting-intelligence-boundary.md`

## 2. Repo Kimliği

- Bu repo `platform-desktop` Electron + React + TypeScript **kaynak kod + image build** repo'sudur
- Manifest/GitOps `platform-k8s-gitops` (audio-gateway-service overlay)
- Backend Spring Boot `platform-backend`
- STT/AI Python `platform-ai`
- Frontend MFE patterns `platform-web/apps/mfe-meeting`

## 3. HARD RULE (özet)

Global `~/.claude/CLAUDE.md` HARD RULE seti aynen geçerli. Repo özel öne çıkanlar:

- **Electron security**: `contextIsolation: true` + `nodeIntegration: false` + preload bridge zorunlu
- **PII/KVKK boundary**: Ses + transcript hassas; lokal disk cache YASAK default
- **Audio API**: `getUserMedia` → AudioWorklet → PCM16 → IPC → WebSocket
- **Cross-platform parity**: macOS/Windows/Linux her PR CI build sanity
- **Code signing**: Unsigned binary production'da YASAK
- **Cross-AI Peer Review**: Provider-level — Electron repo'da Codex review thread zorunlu
- **Türkçe cevap default**
- **Her İş Project Board'a** (Project #4 Hedef Repo: platform-desktop)

## 4. Çalışma Disiplini

- Yeni feature öncesi mevcut Electron pattern reference alınır
- Audio API değişimi ADR + PoC ölçüm gerektirir (yetersiz buffer = ses kaybı = ürün kalitesi)
- IPC bridge minimal — context'i sızdırma
- Cross-repo değişim (örn. audio-gateway contract update) eş-zamanlı PR
- Codex iter sırasında plan-time AGREE → direkt impl
