# Linux Auto-Update Acceptance

Bu kabul yolu, immutable `v0.1.3` AppImage'ını çalışan eski sürüm olarak ve
mevcut kaynak sürümünü aday olarak kullanır. GitHub Actions üzerinde gerçek
`electron-updater` `AppImageUpdater` sınıfıyla şu yolculukları tekrar oynatır:

- eski sürümden yeni sürümü kontrol etme, indirme, sürüm adlı AppImage değişimi ve
  yeni PID/sürüm ile yeniden başlatma;
- değiştirilmiş AppImage'ın metadata SHA-512 kontrolünde reddedilmesi, kurulum
  yapılmaması ve eski dosyanın değişmeden kalması;
- aynı immutable aday için `5% -> 25% -> 100%` metadata geçişi ile gerçek sınır
  cohort'larının updater kararı; upstream `100%` uç hatası ve herkes için
  `stagingPercentage` alanının kaldırıldığı nihai metadata kontrolü;
- `allowDowngrade` ile adaydan pinned immutable `v0.1.3` sürümüne geri dönüş,
  dosya kimliği, çalışan `APPIMAGE` süreci ve paket içi sürüm doğrulaması;
- yayın girişinde Sigstore bundle doğrulaması ve aynı bundle ile değiştirilmiş
  payload'ın fail-closed reddi.

Workflow sabit `ubuntu-24.04` runner'da ve workflow ömürlü ayrı Xvfb süreciyle
çalışır. Yalnız `contents: read` kullanır, release veya ortam değiştirmez,
secret kabul etmez ve geçici feed'i yalnız rastgele porttaki `127.0.0.1`
üzerinde açar. Kanıt JSON'u mutlak yol, header, token veya credential içermez.

## Gate Ayrımı

- **Gate A:** Bu workflow'nun kapsadığı `electron-updater 6.8.9`
  `AppImageUpdater` motoru, GenericProvider full-download, AppImage değişimi,
  restart, staged rollout ve rollback provasıdır.
- **Gate B:** Sevk edilmiş `initAutoUpdate()` wiring'i ile gerçek son kullanıcı
  update provider'ının discovery/auth/redirect/TLS yoludur. Bu workflow Gate B'yi
  kapatmaz; product acceptance için `tracked_pending` kalır.

Harness explicit updater install API'sini kullanır. Uygulamanın mevcut
`autoInstallOnAppQuit` normal-çıkış politikası ve immutable `v0.1.3`
`initAutoUpdate()` wiring'i Gate A sonucu olarak sunulmaz.

## Kanıt Sınırı

Bu prova GenericProvider'ın localhost mekanik kabulüdür. Repo private olduğu ve
uygulamanın GitHub provider yapılandırmasında son kullanıcı credential'ı
bulunmadığı için GitHubProvider auth/redirect teslimatını kanıtlamaz. Anonim
GitHub release URL'si private repo için kullanılabilir bir production update
feed'i değildir. Bunun için son kullanıcıya secret dağıtmayan, imzalı metadata
ve artifact sunan ayrı bir production update feed/control plane kararı gerekir.

Linux `AppImageUpdater` metadata SHA-512 doğrulaması yapar; `.sigstore.json`
bundle'ını doğal olarak doğrulamaz. Bu nedenle Sigstore kontrolü workflow'da
ayrı bir **release-intake preflight** olarak isimlendirilir. Bu kontrolü
uygulama içi imza doğrulaması gibi sunmak doğru değildir.

Immutable `v0.1.3`, yapılandırılmış restart evidence dosyasından önce
üretilmiştir. Geri dönüşte çalışan sürüm; yeni process'in `APPIMAGE` ortamı,
stabilite penceresi, immutable SHA-256 ve AppImage içindeki `package.json`
sürümünün birlikte doğrulanmasıyla bağlanır.

`electron-updater 6.8.9`, `stagingPercentage: 100` için son 32 biti
`0xffffffff` olan UUID'yi strict `<` karşılaştırması nedeniyle dışarıda bırakır.
Bu nedenle `100%` metadata kontrol edilir ama gerçek herkese açılışta alan
tamamen kaldırılır ve maksimum UUID cohort'ıyla ayrıca doğrulanır.

Hosted runner'da relaunch `APPIMAGE_EXTRACT_AND_RUN=1` kullanır. Bu, FUSE
olmayan CI'da gerçek AppImage içeriğini başlatır; distro/FUSE uyumluluğu,
Wayland, arm64, başka Linux dağıtımları ve differential download kapsam dışıdır.
