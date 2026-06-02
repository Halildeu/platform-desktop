# platform-desktop

Meeting Intelligence Desktop Client — Workcube ERP ekosistemine entegre **Electron + React + TypeScript** masaüstü uygulaması.

## Amaç

Toplantı katılımcıları için masaüstü deneyimi (mac/Windows/Linux):

- 🎙️ Mikrofon ses yakalama (getUserMedia + WebRTC)
- 📡 WebSocket akış → `audio-gateway-service` (platform-backend)
- 📝 Canlı geçici transkript + kesinleşmiş metin
- 🗣️ Konuşmacı ayrımı (diarization render)
- 📋 Özet + karar + aksiyon paneli
- 🔔 Sistem tepsisi entegrasyonu + bildirimler
- 🔐 Keycloak SSO (OAuth2 PKCE flow)

Faz 24 M6 Integration kapsamında konumlanır.

## Repo Konumu (Workcube ekosistem haritası)

| Repo | Rol |
|---|---|
| **platform-desktop** (bu) | Electron + React desktop client (mac/Windows/Linux) |
| [platform-mobile](https://github.com/Halildeu/platform-mobile) | React Native + Expo mobile client (planlı) |
| [platform-ai](https://github.com/Halildeu/platform-ai) | Python servisleri — STT, diarization, meeting-ai |
| [platform-backend](https://github.com/Halildeu/platform-backend) | Spring Boot — `audio-gateway-service` + `meeting-service` + `transcript-service` |
| [platform-web](https://github.com/Halildeu/platform-web) | React + Single-SPA — `mfe-meeting` MFE (paralel) |
| [platform-k8s-gitops](https://github.com/Halildeu/platform-k8s-gitops) | GitOps desired-state |

## Stack

| Katman | Teknoloji |
|---|---|
| **Shell** | Electron 31+ (main + preload + renderer processes) |
| **UI** | React 19 + TypeScript |
| **Build** | Vite (renderer) + electron-builder (packaging) |
| **State** | Redux Toolkit (platform-web reuse) |
| **Audio** | getUserMedia + Web Audio API + AudioWorklet |
| **Network** | WebSocket (`/api/meeting-audio/sessions/{id}/stream`) |
| **Auth** | Keycloak OAuth2 PKCE (`keycloak-js` + custom URI scheme callback) |
| **Test** | Vitest (unit) + Playwright (e2e renderer) + Spectron (Electron main) |
| **Package** | electron-builder — DMG (macOS) + NSIS (Windows) + AppImage (Linux) |
| **Update** | electron-updater (Squirrel/Sparkle/AppImage) |

## Mimari Akış

```
[Desktop App (Electron)]
   │
   ├─ Renderer (React) → Login (Keycloak PKCE) → Meeting UI
   │
   ├─ Main process → Audio capture (Web Audio API)
   │                  ↓ chunk-by-chunk PCM16
   │                  WebSocket secure
   │
   └─ → audio-gateway-service (platform-backend)
              ↓ Redis queue (PR-queue-01)
              live-stt-service (platform-ai) → draft transcript
              final-stt-service                → final transcript
              diarization-service              → speaker tags
              meeting-ai-service               → summary + actions
              ↓
        Renderer canlı UI güncellemesi (WebSocket bidirectional)
```

## Reuse — Workcube Ekosisteminden

- **Keycloak SSO** → OAuth2 PKCE + token refresh (auth-service realm)
- **api-gateway** → JWT validation + routing
- **audio-gateway-service** → ses chunk admission + STT dispatch
- **notification-service** (Faz 23) → meeting özet bildirimi
- **mfe-meeting** patterns (platform-web) → React component reuse
- **AG-Grid** → transcript timeline + speaker breakdown
- **Cross-AI Codex review** → her PR adversarial
- **Türkçe i18n** → Workcube dil pattern

## Yeni Eklemeler (Desktop özel)

- **Electron main process** → audio capture native API + WebSocket persistent
- **System tray** → meeting active indicator + quick controls
- **Native notifications** → OS-level (macOS Notification Center / Windows Action Center)
- **Auto-launch** → opsiyonel sistem başlangıcı
- **Mikrofon izin yönetimi** → macOS TCC + Windows permissions
- **Code signing** → Apple Developer ID + Windows Authenticode
- **Notarization** → macOS Apple notarize + Gatekeeper

## Geliştirme Disiplini

Tam liste: [CLAUDE.md](./CLAUDE.md) + global `~/.claude/CLAUDE.md` HARD RULE seti.

Özet:
- **Cross-AI Peer Review** zorunlu (provider-level)
- **Plan Consensus Autonomy** — Codex AGREE → direkt impl
- **No Fake Work** — Electron e2e test koşmadan "tests added" yasak
- **Türkçe cevap default**
- **HARD RULE — Her İş Project Board'a** (Project #4 platform-ai Roadmap altında, Hedef Repo: platform-desktop)
- **PII/KVKK boundary**: ses kaydı + transcript hassas (ADR-0030 uyum)

## Faz Yol Haritası — Faz 24 M6 Integration

| Slice | Konu | Durum |
|---|---|---|
| **PR-desktop-01** | Electron + React + Vite scaffold + Keycloak SSO PKCE | ⏳ planning |
| **PR-desktop-02** | Audio capture + WebSocket → audio-gateway-service | ⏳ |
| **PR-desktop-03** | Live transcript UI + draft→final state machine | ⏳ |
| **PR-desktop-04** | Speaker diarization render (timeline) | ⏳ |
| **PR-desktop-05** | Summary + actions panel + export | ⏳ |
| **PR-desktop-06** | System tray + native notifications + auto-launch | ⏳ |
| **PR-desktop-07** | macOS code signing + notarization | ⏳ |
| **PR-desktop-08** | Windows Authenticode + installer (NSIS) | ⏳ |
| **PR-desktop-09** | Linux AppImage + Debian package | ⏳ |
| **PR-desktop-10** | Auto-updater (Squirrel/Sparkle/AppImage) | ⏳ |

## Hızlı Başlangıç

```bash
# Node.js 22 LTS
nvm use 22
npm install

# Dev (Vite renderer + Electron main hot reload)
npm run dev

# Type check + lint
npm run typecheck
npm run lint

# Test
npm test           # Vitest unit
npm run test:e2e   # Playwright + Spectron

# Production build (current OS)
npm run build
npm run package     # electron-builder

# Cross-platform package
npm run package:mac
npm run package:win
npm run package:linux
```

## Lisans

Internal — Workcube ERP platform.
