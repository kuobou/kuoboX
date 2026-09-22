# kuoboX

**sing-box 中轉機管理面板。** 把落地機的分享連結貼進來，選一個入口協定，就會得到給客戶端用的新連結與 QR Code。

```
客戶端 ──▶ 中轉機（kuoboX + sing-box）──▶ 落地機 ──▶ 網際網路
```

- **一分鐘建立中轉**：支援貼上 `vless://`、`vmess://`、`trojan://`、`ss://`、`hy2://`、`tuic://`、`socks5://` 連結，也可以手動填寫，或直接使用設定檔中既有的出站（selector、urltest、WireGuard…）。
- **入口協定**：VLESS + REALITY（推薦，免憑證）、Shadowsocks 2022、Hysteria2、VMess + WebSocket、Trojan。
- **完整 sing-box**：「設定檔」頁可直接編輯完整設定（支援 JSON 註解）。儲存前先經核心驗證，重啟失敗會自動還原，也可以一鍵載入上一版。
- **安全地修改設定**：精靈只新增或刪除自己的入站、出站與規則，其餘設定原樣保留。版本檢查可避免舊分頁覆蓋新設定。
- **自動放行防火牆**：主機有啟用 ufw、firewalld 或 iptables 拒絕規則時，會自動開放中轉端口。
- **輕量**：零 npm 依賴，只需要一個 Node.js 執行檔；不使用資料庫、Docker 或 CDN。

## 安裝

需求：systemd Linux（Debian／Ubuntu／CentOS／Rocky／Alma／Fedora／openSUSE／Arch），x86_64、ARM64 或 ARMv7，root 權限。

```bash
curl -fsSL https://raw.githubusercontent.com/kuobou/kuobox_test/main/install.sh -o install.sh && sudo bash install.sh
```

沒有 curl 的系統：

```bash
wget -qO install.sh https://raw.githubusercontent.com/kuobou/kuobox_test/main/install.sh && sudo bash install.sh
```

完成後會顯示面板網址與初始密碼。面板使用自簽憑證，瀏覽器提示「不安全」時選擇繼續前往即可。

### 安裝選項

```bash
sudo env PANEL_PORT=8443 bash install.sh              # 指定面板端口（預設 3000）
sudo env PANEL_PASSWORD='你的密碼' bash install.sh     # 指定密碼（至少 12 字元）
sudo env SINGBOX_VERSION=1.12.12 bash install.sh      # 指定 sing-box 版本
```

### 中國大陸機器

GitHub 連線不穩時，可透過 GitHub 加速服務下載：

```bash
curl -fsSL https://cdn.jsdelivr.net/gh/kuobou/kuobox_test@main/install.sh -o install.sh
sudo env GH_PROXY=https://你信任的加速域名 bash install.sh
```

Node.js 下載失敗時會自動改用 npmmirror 鏡像，也可以用 `NODE_MIRROR=https://...` 指定鏡像。`GH_PROXY` 會被記住，之後更新時沿用。

> 加速服務能看到並修改傳輸內容，請只使用你信任的服務。Node.js 與 sing-box 都會做 SHA-256 校驗（sing-box 在 GitHub API 可用時校驗）。

### 安裝程式會做什麼

1. 若系統沒有 Node.js 18.15 以上版本，會把 Node.js 22 放在 `/opt/kuobox-node`，只保留約 120 MB 的執行檔，不含 npm。glibc 低於 2.28 的舊系統（例如 CentOS 7）會自動改用相容版本。
2. 若沒有 sing-box，會安裝官方最新穩定版到 `/usr/local/bin/sing-box`，並建立 `sing-box.service`。已存在的 sing-box、設定與服務都不會被更動。
3. 把面板放在 `/opt/kuobox`，建立 `kuobox.service` 與 `kuobox` 管理指令。
4. 替換失敗時會自動還原為舊版面板。

## 使用

1. 登入面板 →「中轉節點」→「新增中轉」
2. 貼上落地機的分享連結（可先按「測試落地機連通」）
3. 選擇入口協定與端口（留空會自動選擇）→「建立中轉」
4. 複製連結或掃描 QR Code 匯入客戶端

雲端主機（AWS、GCP、Oracle、阿里雲、騰訊雲…）如果有安全組，請到供應商後台開放面板端口與中轉端口；使用 Hysteria2 時還要開放 UDP。

## 管理指令

```
kuobox              互動選單
kuobox info         面板網址與狀態
kuobox password     重設面板密碼（留空產生隨機密碼）
kuobox port         修改面板端口
kuobox bbr          開啟 BBR 擁塞控制
kuobox update       更新面板（不影響 sing-box 與中轉）
kuobox core         升級 sing-box，並先用新核心驗證現有設定
kuobox uninstall    卸載（可選擇保留 sing-box 讓中轉繼續運作）
```

停止或更新面板不會中斷中轉。只有套用設定時才會重啟 sing-box，既有連線會短暫中斷。

## 設定

`/opt/kuobox/.env`（由 systemd 載入）：

```ini
PANEL_PORT=3000
PANEL_PASSWORD="..."
SINGBOX_CONFIG=/etc/sing-box/config.json   # 需與 sing-box 服務的 -c 路徑一致
TRAFFIC_INTERFACE=eth0                     # 選填，流量圖使用的網卡
PANEL_ALLOW_HTTP=1                         # 選填，搭配反向代理時使用 HTTP（預設只監聽 127.0.0.1）
PANEL_HOST=127.0.0.1                       # 選填，監聽地址
```

- 如果要改用正式憑證，把它放到 `/opt/kuobox/cert/cert.pem` 與 `key.pem`，再重啟面板即可。
- 設定檔含註解時，精靈不會修改它（否則註解會遺失），請改在「設定檔」頁編輯。
- 節點名稱存放在 `/opt/kuobox/panel-state.json`。更新面板時會保留 `.env`、憑證與這個檔案。

## 開發

```bash
npm test                       # 單元與 API 測試（Node 18+，不需要安裝任何套件）
bash -n install.sh && bash -n kuobox.sh
PANEL_PASSWORD=dev-password-123 PANEL_ALLOW_HTTP=1 SINGBOX_CONFIG=./dev.json node server.js
```

| 檔案 | 用途 |
| --- | --- |
| `server.js` | HTTP 伺服器與 API（只使用 Node 內建模組） |
| `lib/links.js` | 分享連結 → sing-box 出站 |
| `lib/relay.js` | 新增／刪除中轉，保留其餘設定 |
| `lib/saved-nodes.js` | 由設定推導客戶端連結與落地目標 |
| `lib/config-store.js` | 驗證 → 備份 → 原子替換 → 重啟 → 失敗還原 |
| `public/` | 前端（無框架、無建置步驟） |
