# Public runtime config

`public-runtime-config.json`, normal Finder/Application Menu launch'inda `.env` wrapper olmadan
test ortamının public endpoint'lerini sağlar. Electron Builder bu dosyayı `app.asar` dışında
`resources/config/public-runtime-config.json` konumuna kopyalar.

Öncelik alan bazındadır:

1. process environment
2. managed user preferences (`recorder.deviceId` only)
3. administrator-owned system config
4. packaged config

macOS managed yolları:

- User: `~/Library/Application Support/Meeting Intelligence/config/public-runtime-config.json`
- System: `/Library/Application Support/Meeting Intelligence/config/public-runtime-config.json`

Managed belgeler aynı `schemaVersion: 1` ve `environment: "test"` sözleşmesini kullanır, ancak
yalnız değiştirecekleri bölümleri içerebilir. Kullanıcı tarafından yazılabilen belge yalnız
`recorder.deviceId` tercihini taşıyabilir; `keycloak` ve `services` bölümleri burada reddedilir.
JWT veya ses taşıyan servis authority'leri yalnız imzalı package, yöneticiye ait system config ya
da kontrollü process environment katmanından gelir. Bilinmeyen veya secret biçimli alanlar
reddedilir; HTTP/WS endpoint kabul edilmez. Bozuk bir managed belge packaged değere sessizce
düşmez; uygulama güvenli hata kodu ve config yoluyla başlatmayı reddeder. Değişiklikler uygulama
yeniden başlatıldığında okunur.

Process environment yalnız geliştirme ve kontrollü test override'ı içindir. Mevcut loader
sözleşmesi bu en üst katmanda yalnız `localhost` / `127.0.0.1` / `::1` için HTTP/WS kabul eder;
uzak process-env endpoint'leri de HTTPS/WSS olmak zorundadır. Managed ve packaged belgelerde
localhost dahil yalnız HTTPS/WSS geçerlidir.

`services.gatewayLiveStreamEnabled`, authenticated ve session-scoped audio-gateway WebSocket
taşımasını açan public boolean gate'tir. Alan yoksa varsayılan `false` olur; process override'ı
yalnız exact `GATEWAY_LIVE_STREAM_ENABLED=true` ile açılır. Packaged test değeri, GitOps
`origin/main` test overlay'inde `AUDIO_GATEWAY_DIRECT_STT_STREAMING_ENABLED=true` olduğu için
`true`dur. Rollback veya yeni ortam aktivasyonunda desktop gate ile GitOps rollout birlikte flip
edilmelidir.

Bu kaynak yalnız public client ve endpoint metadata'sıdır. OAuth client secret, token, parola,
credential, private key, API key, kullanıcı/tenant bilgisi, meeting ID veya başka PII eklenmez.
`liveSttStreamUrl` bilinçli olarak `null` kalır: iç `live-stt` servisi public client contract'ı
değildir ve gateway'in session-scoped WebSocket URL'si statik package config'e gömülemez.
