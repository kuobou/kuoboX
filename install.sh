#!/bin/bash

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }
info() { echo -e "${BLUE}[~]${NC} $1"; }

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "        RelayBox 管理面板 一鍵安裝"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── 檢查 root ────────────────────────────────
if [ "$EUID" -ne 0 ]; then
  err "請使用 root 執行：sudo bash install.sh"
fi

# ── 檢查必要工具 ─────────────────────────────
for cmd in curl tar unzip; do
  command -v $cmd &>/dev/null || err "缺少必要工具：$cmd，請先安裝後再執行"
done

# ── 收集設定 ─────────────────────────────────
read -p "面板端口 [預設 3000]: " PANEL_PORT
PANEL_PORT=${PANEL_PORT:-3000}

read -p "面板登入密碼 [預設 changeme123]: " PANEL_PASSWORD
PANEL_PASSWORD=${PANEL_PASSWORD:-changeme123}

echo ""

INSTALL_DIR="/opt/relaybox"
NODE_VER="20.19.2"
NODE_BIN="/usr/local/bin/node"
NPM_BIN="/usr/local/bin/npm"

# ── 安裝 Node.js（預編譯二進位）────────────
info "檢查 Node.js..."
if [ ! -x "$NODE_BIN" ]; then
  info "安裝 Node.js ${NODE_VER}..."
  ARCH=$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/;s/armv7l/armv7l/')
  curl -fsSL "https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-linux-${ARCH}.tar.gz" -o /tmp/node.tar.gz
  tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1
  rm -f /tmp/node.tar.gz
fi
ln -sf "$NODE_BIN" /usr/bin/node 2>/dev/null || true
ln -sf "$NPM_BIN" /usr/bin/npm 2>/dev/null || true
log "Node.js 安裝完成 ($($NODE_BIN --version))"

# ── 下載 RelayBox ────────────────────────────
info "下載 RelayBox 到 $INSTALL_DIR ..."
curl -fsSL https://github.com/kuobou/relaybox/archive/refs/heads/main.zip -o /tmp/relaybox.zip
unzip -q -o /tmp/relaybox.zip -d /tmp/
mkdir -p "$INSTALL_DIR"
cp -r /tmp/relaybox-main/. "$INSTALL_DIR/"
rm -rf /tmp/relaybox.zip /tmp/relaybox-main
cd "$INSTALL_DIR"
log "下載完成"

# ── 安裝 sing-box ────────────────────────────
info "檢查 sing-box..."
if ! command -v sing-box &>/dev/null; then
  info "安裝 sing-box（從 GitHub 下載）..."
  SB_ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
  SB_VER=$(curl -s https://api.github.com/repos/SagerNet/sing-box/releases/latest | grep '"tag_name"' | cut -d'"' -f4 | tr -d 'v')
  curl -fsSL "https://github.com/SagerNet/sing-box/releases/download/v${SB_VER}/sing-box-${SB_VER}-linux-${SB_ARCH}.tar.gz" -o /tmp/sing-box.tar.gz
  tar -xzf /tmp/sing-box.tar.gz -C /tmp/
  cp "/tmp/sing-box-${SB_VER}-linux-${SB_ARCH}/sing-box" /usr/local/bin/
  chmod +x /usr/local/bin/sing-box
  rm -rf /tmp/sing-box*
  mkdir -p /etc/sing-box
  cat > /etc/systemd/system/sing-box.service <<'SVCEOF'
[Unit]
Description=sing-box
After=network.target

[Service]
ExecStart=/usr/local/bin/sing-box run -c /etc/sing-box/config.json
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF
  systemctl daemon-reload
  systemctl enable sing-box
  log "sing-box 安裝完成 ($(/usr/local/bin/sing-box version | head -1))"
else
  log "sing-box 已安裝 ($(sing-box version | head -1))"
fi

# ── 安裝 vnstat ──────────────────────────────
info "安裝 vnstat..."
dnf install -y vnstat 2>/dev/null || yum install -y vnstat 2>/dev/null || apt-get install -y vnstat 2>/dev/null || warn "vnstat 安裝失敗，流量統計將使用備用方案"
systemctl enable vnstat 2>/dev/null || true
systemctl start vnstat 2>/dev/null || true
log "vnstat 完成"

# ── 安裝 npm 依賴 ────────────────────────────
info "安裝 npm 依賴..."
$NPM_BIN install --omit=dev
log "npm 依賴安裝完成"

# ── 建立 .env ────────────────────────────────
info "寫入設定..."
cat > "$INSTALL_DIR/.env" <<EOF
PANEL_PORT=${PANEL_PORT}
PANEL_PASSWORD=${PANEL_PASSWORD}
EOF
chmod 600 "$INSTALL_DIR/.env"
log ".env 設定完成"

# ── 建立 systemd 服務 ────────────────────────
info "建立 systemd 服務..."
cat > /etc/systemd/system/relaybox.service <<EOF
[Unit]
Description=RelayBox 管理面板
After=network.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
ExecStart=/usr/local/bin/node server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable relaybox
systemctl restart relaybox
log "服務啟動完成"

# ── 取得本機 IP ──────────────────────────────
LOCAL_IP=$(hostname -I | awk '{print $1}')
PUBLIC_IP=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || echo "無法取得")

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}  安裝完成！${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  面板網址（內網）：http://${LOCAL_IP}:${PANEL_PORT}"
echo "  面板網址（公網）：http://${PUBLIC_IP}:${PANEL_PORT}"
echo "  登入密碼：${PANEL_PASSWORD}"
echo ""
echo "  常用指令："
echo "    重啟面板：systemctl restart relaybox"
echo "    查看日誌：journalctl -u relaybox -f"
echo "    停止面板：systemctl stop relaybox"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
