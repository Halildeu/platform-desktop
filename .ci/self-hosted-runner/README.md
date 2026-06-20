# platform-desktop — self-hosted CI runner (staging-sw)

GitHub-hosted `ubuntu-latest` dakika kotası account-wide billing-bloklu olduğu
için platform-desktop CI (`tsc` + `vitest`, `.github/workflows/ci.yml`) bu
**kilitli, build-only** self-hosted runner'da koşar.

> Bu dizin = **çalışan deployment'ın version-controlled kaynağı**. Host'ta
> `~/desktop-ci-runner/` altından deploy edilir; değişiklik burada yapılır,
> host'a senkronlanır.

## Güvenlik tasarımı (Codex 019ee5aa — REVISE→absorbed)

staging-sw prod-adjacent (Vault-adjacent, k3d, MinIO, Keycloak-prod containerları).
Build prod erişimi GEREKTİRMEZ → runner buna göre **sıkı izole**:

| Kontrol | Uygulama |
|---|---|
| **Secret-mount YOK** | kubeconfig / web-stage / `docker.sock` mount edilmez (deploy runner'dan farkı budur) |
| **Egress firewall** | `desktop-ci-firewall.sh`: DOCKER-USER chain, runner subnet (`172.31.255.0/24`) → RFC1918 + host-gateway + link-local **DROP**; yalnız internet (npm/GitHub/node) + DNS allow |
| **Privilege drop** | `no-new-privileges:true` + `cap_drop: ALL` → image'daki `runner` NOPASSWD sudo nötralize |
| **Resource limit** | `pids_limit 512`, `mem_limit 6g`, `cpus 2.0` |
| **Credential** | tek-seferlik registration token (PAT container'da YOK); runner yalnız job-listen credential tutar |
| **State hygiene** | `hooks/cleanup.sh` job-completed hook → `_work` + npm cache wipe (non-ephemeral state-poisoning guard; workflow YAML devre dışı bırakamaz) |
| **Network** | dedicated bridge `platform-desktop-ci-net` (prod/test docker network'lerinden ayrı) |
| **Trust model** | repo yalnız trusted collaborator (owner + 1) PR'ı alır; GitHub outside-contributor için auto-approval ister |

### Bilinen residual + gelecek sertleştirme
- **Non-ephemeral** (PAT-siz registration sonucu): state `hooks/cleanup.sh` ile
  her job sonrası silinir. İdeal = host-side broker + ephemeral (PAT container'a
  hiç girmeden); bu owner-scoped fine-grained PAT (Administration:Write on
  platform-desktop) gerektirir.
- **Branch protection enforcement** (`Require review from Code Owners` →
  `.github/CODEOWNERS`) owner toggle'ı; runner izolasyonu birincil kontrol.

## Deploy / yeniden kurulum

```bash
# 1. Artifact'ları host'a senkronla
rsync -a .ci/self-hosted-runner/ halil@staging-sw:~/desktop-ci-runner/

# 2. Registration token (1h TTL, tek-seferlik) — local gh (admin) ile:
gh api -X POST repos/Halildeu/platform-desktop/actions/runners/registration-token --jq .token \
  | ssh halil@staging-sw 'umask 077; printf "RUNNER_REGISTRATION_TOKEN=%s\n" "$(cat)" > ~/desktop-ci-runner/.env'

# 3. Network + container oluştur (başlatmadan) → firewall → başlat
ssh halil@staging-sw 'cd ~/desktop-ci-runner && docker compose -f docker-compose.desktop-ci.yml up --no-start'
ssh halil@staging-sw 'bash ~/desktop-ci-runner/desktop-ci-firewall.sh'
ssh halil@staging-sw 'cd ~/desktop-ci-runner && docker compose -f docker-compose.desktop-ci.yml start'

# 4. Firewall'ı reboot-persistent yap (idempotent oneshot, docker.service sonrası)
ssh halil@staging-sw 'sudo cp ~/desktop-ci-runner/desktop-ci-firewall.service /etc/systemd/system/ \
  && sudo systemctl daemon-reload && sudo systemctl enable --now desktop-ci-firewall.service'
```

## Doğrulama
- `gh api repos/Halildeu/platform-desktop/actions/runners` → `staging-sw-desktop-ci` `online`
- Runner logs: `docker logs platform-gha-runner-desktop-ci` → `Listening for Jobs`
- CI job: `runs-on: [self-hosted, platform-desktop-ci]` → 11 step pass (~1.5dk)
- İzolasyon: `docker inspect platform-gha-runner-desktop-ci` → `NoNewPrivs`, `CapDrop:[ALL]`, net `platform-desktop-ci-net`
