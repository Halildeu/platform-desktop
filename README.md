# platform-desktop

Meeting Intelligence Desktop Client — **Faz 24 bağımsız Meeting Intelligence ürünü** için **Electron + React + TypeScript** masaüstü uygulaması.

## Amaç

ERP/CRM bağımsız toplantı zekası için masaüstü deneyimi (mac/Windows/Linux). Belirli bir ERP adı runtime contract'a gömülmez; ERP/CRM'ye özel hedefler entegrasyon adapter'ları üzerinden map edilir.

- 🎙️ Sistem sesi (loopback) + mikrofon yakalama — tüm platform / yüz yüze / hibrit tek client
- 📡 REST chunk akışı → `audio-gateway-service` (`POST /sessions → /chunks → /finish`)
- 📝 Canlı geçici transkript + kesinleşmiş metin
- 🗣️ Konuşmacı ayrımı (diarization render)
- 📋 Özet + karar + aksiyon paneli
- 🔔 Sistem tepsisi entegrasyonu + bildirimler
- 🔐 Keycloak SSO (OAuth2 PKCE flow)

Faz 24 M6 Integration kapsamında konumlanır.

## Repo Konumu (Platform ekosistem haritası)

| Repo                                                                   | Rol                                                                              |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **platform-desktop** (bu)                                              | Electron + React desktop client (mac/Windows/Linux)                              |
| [platform-mobile](https://github.com/Halildeu/platform-mobile)         | React Native + Expo mobile client (planlı)                                       |
| [platform-ai](https://github.com/Halildeu/platform-ai)                 | Python servisleri — STT, diarization, meeting-ai                                 |
| [platform-backend](https://github.com/Halildeu/platform-backend)       | Spring Boot — `audio-gateway-service` + `meeting-service` + `transcript-service` |
| [platform-web](https://github.com/Halildeu/platform-web)               | React + Single-SPA — `mfe-meeting` MFE (paralel)                                 |
| [platform-k8s-gitops](https://github.com/Halildeu/platform-k8s-gitops) | GitOps desired-state                                                             |

## Stack

| Katman      | Teknoloji                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------- |
| **Shell**   | Electron 31+ (main + preload + renderer processes)                                        |
| **UI**      | React 19 + TypeScript                                                                     |
| **Build**   | Vite (renderer) + electron-builder (packaging)                                            |
| **State**   | Redux Toolkit (platform-web reuse)                                                        |
| **Audio**   | getUserMedia (mic) + loopback (sistem sesi) + AudioWorklet → PCM16 16kHz mono             |
| **Network** | REST chunks (`POST /api/v1/audio-gateway/sessions/{id}/chunks`; WS `/stream` planned-404) |
| **Auth**    | Keycloak OAuth2 PKCE (`keycloak-js` + custom URI scheme callback)                         |
| **Test**    | Vitest (unit) + Playwright (e2e renderer) + Spectron (Electron main)                      |
| **Package** | electron-builder — DMG (macOS) + NSIS (Windows) + AppImage (Linux)                        |
| **Update**  | electron-updater (Squirrel/Sparkle/AppImage)                                              |

## Mimari Akış

```
[Desktop App (Electron)]
   │
   ├─ Renderer (React) → Login (Keycloak PKCE) → Meeting UI
   │
   ├─ Main process → Audio capture (loopback + mic, Web Audio API)
   │                  ↓ chunk-by-chunk PCM16 (16kHz mono)
   │                  REST chunks (idempotent + strict-contiguous seq)
   │
   └─ → audio-gateway-service (POST /sessions → /chunks → /finish)
              ↓ Redis queue (PR-queue-01)
              live-stt-service (platform-ai) → draft transcript
              final-stt-service                → final transcript
              diarization-service              → speaker tags
              meeting-ai-service               → summary + actions
              ↓
        Renderer canlı UI güncellemesi (status/sonuç; meetingId ile tek dashboard)
```

## Reuse — Platform Ekosisteminden

- **Keycloak SSO** → OAuth2 PKCE + token refresh (auth-service realm)
- **api-gateway** → JWT validation + routing
- **audio-gateway-service** → ses chunk admission + STT dispatch
- **notification-service** (Faz 23) → meeting özet bildirimi
- **mfe-meeting** patterns (platform-web) → React component reuse
- **AG-Grid** → transcript timeline + speaker breakdown
- **Cross-AI Codex review** → her PR adversarial
- **Türkçe i18n** → Platform dil pattern

## Yeni Eklemeler (Desktop özel)

- **Electron main process** → secure IPC + REST audio session/chunk bridge
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

| Slice             | Konu                                                 | Durum             |
| ----------------- | ---------------------------------------------------- | ----------------- |
| **PR-desktop-01** | Electron + React + Vite scaffold + Keycloak SSO PKCE | ⏳ planning       |
| **PR-desktop-02** | Audio capture + REST chunks → audio-gateway-service  | ✅ merged         |
| **PR-desktop-03** | Live transcript UI + draft→final state machine       | ✅ merged         |
| **PR-desktop-04** | Speaker diarization render (timeline)                | ⏳                |
| **PR-desktop-05** | Summary + actions panel + export                     | 🟡 source surface |
| **PR-desktop-06** | System tray + native notifications + auto-launch     | ⏳                |
| **PR-desktop-07** | macOS code signing + notarization                    | ⏳                |
| **PR-desktop-08** | Windows Authenticode + installer (NSIS)              | ⏳                |
| **PR-desktop-09** | Linux AppImage + Debian package                      | ⏳                |
| **PR-desktop-10** | Auto-updater (Squirrel/Sparkle/AppImage)             | ⏳                |

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

## Current Audio Capture Scope

PR-desktop-02 is merged through the stacked PRs #17-#20. Current behavior:

- Auth: Keycloak PKCE login stays in the Electron main process; renderer sees only safe status/claim summary.
- Runtime config: recorder starts only with a canonical meeting-service UUID from
  `MeetingResponse.id`. Local smoke can still pre-bind `RECORDER_MEETING_ID`, but a logged-in
  desktop user can also create a meeting contract through meeting-service and bind the returned
  UUID without exposing the JWT to the renderer. Random desktop-generated meeting IDs and legacy
  `MTG-*` codes are forbidden.
- Capture: renderer captures microphone plus best-effort system audio/loopback. The Electron display-media handler is fail-closed unless a bounded recorder capture lease is active and the request comes from the main renderer frame.
- Encoding: AudioWorklet emits PCM16 / 16kHz / mono chunks.
- Transport: main process sends REST chunks to `audio-gateway-service` (`POST /sessions` → `POST /sessions/{id}/chunks` → `POST /finish`) using the login JWT.
- KVKK boundary: raw audio is not cached to local disk by default. Consent text has a real `sha256:<64 hex>` digest derived from the canonical rendered consent text.

Open acceptance boundaries before recorder can be called end-to-end production-ready:

- Canonical meeting contract creation now has a desktop path (`POST /api/v1/admin/meetings`
  through the main process). Runtime acceptance still depends on the caller having meeting-service
  create authorization and the returned UUID passing audio-gateway record authorization.
- Server-time consent audit persistence is a backend/API gate; the desktop slice records only local consent state before starting capture.
- Real Electron loopback/audio e2e still needs runtime smoke with a live meeting/gateway/STT path.

## Current Product Surface Scope

The recorder now exposes two user-facing workspaces:

- **Canlı Transkript**: recorder session metadata, lifecycle state, transcript timeline states
  (`draft`, `stabilizing`, `final`, `revised`), live stream/audio diagnostics, review filters,
  flow-health coverage signals, stable-row review actions, and an honest empty state while no
  transcript stream is connected.
- **Toplantı Çıktısı**: typed meeting-intelligence result surface for summary, decisions,
  action items, citation timestamps, source readiness, Meeting AI source-package export,
  Markdown/TXT/CSV/JSON export, share drafts, native print/PDF flow, generic ERP/CRM
  adapter handoff preview, and explicit package readiness state.
- **ERP/CRM handoff**: vendor-neutral adapter manifest, review-before-write readiness gate,
  source-evidence metadata, object-level dry-run plan (`meeting_note`, `decision_record`,
  `action_task`), stale-source fail-closed gating, review-vs-transfer package labels, and
  idempotent integration JSON for backend-owned adapters.

Boundaries:

- No fake AI summary is rendered.
- No raw audio or transcript is persisted to local disk by default.
- Raw audio and raw transcript are excluded from ERP/CRM handoff packages by default.
- If the transcript source changes after Meeting AI output generation, the ERP/CRM package is
  downgraded to a review package and the product surface offers a Meeting AI refresh action when
  the latest source is eligible for backend-gateway submission.
- Meeting-intelligence content is shown only when an approved result is supplied to the renderer
  state model or generated through the backend gateway adapter. Real provider/runtime acceptance
  remains tracked by the Faz 24 GitOps/runtime issues.
- ERP/CRM brand names are not product contracts; ERP/CRM-specific targets are mapped only through backend
  adapters and the desktop surface stays generic across ERP/CRM systems.

## Lisans

Internal — Faz 24 Meeting Intelligence (bağımsız ürün).
