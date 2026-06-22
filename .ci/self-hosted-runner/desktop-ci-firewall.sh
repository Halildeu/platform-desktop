#!/usr/bin/env bash
# Codex 019ee5aa #1 — egress firewall: platform-desktop-ci build runner.
# Runner subnet (172.31.255.0/24) yalnız PUBLIC internet'e (npm/GitHub/node)
# çıkabilsin; host + prod/test docker subnetleri + link-local'e ERIŞEMESIN.
# Idempotent (-C check). DOCKER-USER chain, FORWARD'ın üstü.
#
# Sıra (üstten): DNS RETURN (resolution serbest) → private-range DROP →
# (default) internet'e izin. SNAT POSTROUTING'de olduğu için FORWARD'da
# src hâlâ container IP'si = -s match doğru.
set -euo pipefail
SUBNET="172.31.255.0/24"

ins_drop() {  # -d <range> : private hedefe DROP (yoksa ekle)
  local dst="$1"
  if ! sudo iptables -C DOCKER-USER -s "$SUBNET" -d "$dst" -j DROP 2>/dev/null; then
    sudo iptables -I DOCKER-USER 1 -s "$SUBNET" -d "$dst" -j DROP
    echo "[fw] +DROP $SUBNET -> $dst"
  else echo "[fw] =DROP $SUBNET -> $dst (var)"; fi
}
ins_dns() {  # DNS RETURN (DROP'ların ÜSTÜNE; -I 1 sona eklendiği için en son insert en üstte)
  local proto="$1"
  if ! sudo iptables -C DOCKER-USER -s "$SUBNET" -p "$proto" --dport 53 -j RETURN 2>/dev/null; then
    sudo iptables -I DOCKER-USER 1 -s "$SUBNET" -p "$proto" --dport 53 -j RETURN
    echo "[fw] +DNS RETURN $proto/53"
  else echo "[fw] =DNS RETURN $proto/53 (var)"; fi
}

# Önce DROP'lar (alt sıralar), sonra DNS RETURN (üst sıraya gelir).
ins_drop "10.0.0.0/8"
ins_drop "172.16.0.0/12"
ins_drop "192.168.0.0/16"
ins_drop "169.254.0.0/16"
ins_dns udp
ins_dns tcp

echo ""
echo "=== DOCKER-USER (runner subnet kuralları, üst 8) ==="
sudo iptables -L DOCKER-USER -n --line-numbers | grep -E "172.31.255|Chain|num" | head -10
