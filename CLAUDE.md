# CLAUDE.md — platform-desktop Agent Kılavuzu

> Bu dosya Claude Code / agent session'larında otomatik yüklenir. Repo-specific kurallar, pattern'ler ve bağlam.

> Öncelik notu: Repo-geneli giriş yüzeyi [AGENTS.md](./AGENTS.md). Global HARD RULE seti `~/.claude/CLAUDE.md` (her oturumda otomatik yüklenir). Çelişki halinde global HARD RULE > AGENTS.md > bu dosya.

---

## Proje Bağlamı

`platform-desktop`, **Faz 24 M6 Integration** kapsamında ERP/CRM bağımsız Electron + React + TypeScript masaüstü Meeting Intelligence client'ı barındırır.

Repo eşleştirmesi: [README.md](./README.md) "Repo Konumu" tablosu.

## Ekosistem Reuse

Bu repo **standalone değil** — platform servislerinin doğal uzantısı:

- **Auth**: Keycloak SSO (OAuth2 PKCE flow + custom URI scheme callback `workcube://auth`)
- **Routing**: `audio-gateway-service` üzerinden tüm STT akışı
- **WebSocket**: persistent connection — main process
- **State**: Redux Toolkit (platform-web mfe-meeting pattern reuse)
- **UI Components**: AG-Grid + mfe-meeting React components
- **i18n**: Platform Türkçe pattern
- **Notification**: Faz 23 notification-service event → desktop native push

## Ana Kurallar (HARD RULE — global ⊕ repo)

### Global HARD RULE (otomatik yüklenir)

`~/.claude/CLAUDE.md` HARD RULE seti aynen geçerli:

- Mavis CLI (lokal agent iletişimi)
- **Her İş Project Board'a + Durum Güncel Tutulur** (2026-06-02 yeni)
- Tam Otonom Önerme + Yürütme
- Workspace Tooling: Microsoft Teams
- Uzun Vadeli Kalıcı Çözüm
- CI Kırmızıyken Merge YASAK
- Tarayıcıdan Sonuç Doğrulanmadan İş Bitmedi
- "Yarın" / İş Erteleme YASAK
- Cross-AI Peer Review (provider seviyesinde)
- Continuous Autonomous Mode + Codex Decision Authority
- No Fake Work / No Cosmetic Operations
- Pre-Production Full Authority
- Cevap Dili Türkçe
- Plan Consensus Autonomy

### Repo-specific (platform-desktop)

1. **Electron security baseline**: `contextIsolation: true` + `nodeIntegration: false` + preload bridge zorunlu. Renderer'da Node API direkt erişim YASAK.

2. **PII/KVKK boundary**: Ses kaydı + transcript hassas (ADR-0030 uyum):
   - Audio buffer renderer'dan main process'e secure IPC
   - Lokal cache YASAK (chunk'lar memory'de, disk'e yazılmaz default)
   - Transcript clipboard copy → audit log
   - Crash report'lar PII redacted (Sentry vs benzeri)

3. **Audio API discipline**: `getUserMedia` → AudioWorklet → PCM16 chunk → main process → WebSocket. Permission denied durumunda kullanıcıya net hata mesajı + system settings link.

4. **WebSocket reconnect**: connection drop → exponential backoff + missed chunk buffer + idempotency key (sessionId + chunkSeq).

5. **Cross-platform parity test**: macOS + Windows + Linux her PR'da CI'da build sanity. Platform-specific kod minimize edilir (`process.platform` switch).

6. **Code signing zorunlu** (production build): Unsigned binary YASAK (Apple Notarization fail + Windows SmartScreen warning + Linux trust issues).

7. **Auto-update güvenliği**: `electron-updater` ile SHA + signature verify zorunlu. Update sunucusu HTTPS + cert pinning.

8. **Cross-AI Codex review Electron için**: Test runner = Vitest + Playwright + Spectron. Codex review thread her PR için zorunlu.

## Pattern'ler

### Electron Yapısı

```
electron/
├── main.ts                  # Main process (audio capture + WebSocket persistent)
├── preload.ts               # Contextbridge — secure IPC
├── ipc/
│   ├── audio.ts             # Audio stream IPC handlers
│   ├── auth.ts              # OAuth callback handlers
│   └── window.ts            # Window state management
├── services/
│   ├── audio-capture.ts     # getUserMedia + AudioWorklet
│   ├── websocket-client.ts  # Persistent WS + reconnect
│   ├── keycloak.ts          # OAuth2 PKCE
│   └── notifications.ts     # Native notifications
└── tray.ts                  # System tray

src/  (Renderer — React)
├── main.tsx                 # React entry
├── App.tsx                  # Root + routing
├── components/              # UI components (mfe-meeting pattern reuse)
├── store/                   # Redux Toolkit slices
├── api/                     # REST + WebSocket client wrappers
├── i18n/                    # Türkçe + EN locales
└── hooks/                   # Custom React hooks
```

### IPC Bridge (preload.ts)

```typescript
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  audio: {
    start: () => ipcRenderer.invoke('audio:start'),
    stop: () => ipcRenderer.invoke('audio:stop'),
    onChunk: (cb) => ipcRenderer.on('audio:chunk', cb),
    onTranscript: (cb) => ipcRenderer.on('audio:transcript', cb),
  },
  auth: {
    login: () => ipcRenderer.invoke('auth:login'),
    logout: () => ipcRenderer.invoke('auth:logout'),
    getToken: () => ipcRenderer.invoke('auth:getToken'),
  },
});
```

### Commit Message

```
<type>(<scope>): <kısa başlık>

<body — neden, ne, kanıt>

<Codex iter referansı varsa>
<Co-Authored-By: Claude ...>
```

Types: `feat` / `fix` / `refactor` / `docs` / `chore` / `test` / `perf` / `build`

### CI Gates (planlı)

- `vitest run` (>80% coverage)
- `tsc --noEmit` (strict)
- `eslint .` (no warnings)
- `prettier --check .`
- Playwright e2e renderer
- Spectron e2e main process
- `electron-builder --dir` build sanity (macOS + Windows + Linux)
- Cross-AI Codex review thread referansı

## Codex Adversarial Protokol

Her büyük delta sonrası Codex MCP adversarial review:

- VERDICT: AGREE / PARTIAL / REVISE / RED
- AGREE → direkt impl, plan onayı sorma (Plan Consensus Autonomy)
- PARTIAL/REVISE → absorb + iter
- RED → kullanıcıya yön sor

## Agent Session Akış

1. Oku: [AGENTS.md](./AGENTS.md) → [README.md](./README.md)
2. Bağlantılı repo state:
   - platform-ai → STT services
   - platform-backend → audio-gateway-service
   - platform-web → mfe-meeting components reuse
   - platform-k8s-gitops → infra
3. Kontrol: `git log --oneline main..HEAD | head -10` + `git status`
4. Memory: `~/.claude/projects/<slug>/memory/MEMORY.md`
5. Project #4 — Faz 24 issue claim (yeni HARD RULE)

## Kaynaklar

- [README.md](./README.md) — proje genel + repo eşleştirmesi
- [AGENTS.md](./AGENTS.md) — giriş yüzeyi + HARD RULE özet
- Global `~/.claude/CLAUDE.md` — HARD RULE seti
- ADR-0030 KVKK Meeting Intelligence Boundary (platform-k8s-gitops)
- Audio Gateway Contract v1 (platform-backend `audio-gateway-service/docs/contract-v1.md`)
- Faz 24 canonical plan (platform-k8s-gitops `docs/faz-24-meeting-intelligence-plan.md`)
