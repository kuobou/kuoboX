# kuoboX 中轉管理面板

以中轉機的穩定性為優先：sing-box 負責實際轉發，面板只處理設定與監控。停止或更新面板不會停止 sing-box；套用核心設定時會重啟 sing-box，既有連線可能短暫中斷。

## 功能與資源

- 完整設定編輯器原樣讀寫設定，支援 JSON 註解；所有本機 sing-box 支援的協定、DNS、路由、入站／出站與進階欄位均交由核心驗證，不受表單限制。
- 新增節點表單支援 VLESS + REALITY、Trojan、VMess + WS 入站及 VLESS／Trojan／Shadowsocks 出站，保留既有設定。修改或刪除既有節點請使用完整編輯器。
- 新節點的專用入站路由置於既有規則之前，避免被原有 catch-all 規則攔截；原有規則之間的順序不變。
- 套用流程：檢查設定版本 → 暫存檔 → `sing-box check` → 備份 → 原子替換 → 重啟 → 確認服務狀態。失敗嘗試還原並明確回報結果。
- 同時只允許一個設定／服務操作；舊分頁不能覆蓋已更新設定。設定請求上限 2 MB，大型規則建議使用 sing-box 的獨立 rule-set 檔案。
- 系統資訊由 Node／`/proc` 讀取；流量採樣共用短暫快取，不再每兩秒啟動 shell。流量為選定網卡的開機累計，並非單獨某個節點流量。
- 分頁隱藏時停止前端輪詢；無監控資料庫、Docker、前端框架、CDN 字型或建置步驟。執行期只有 Node.js、Express 與 sing-box；並非零記憶體／零下載成本。
- Apple 白色系介面、系統字型及手機版布局。

## 適用環境

自動安裝目標為 **systemd Linux、x86_64／ARM64**，包含使用 apt、dnf、yum、zypper 的主流 VPS 系統。首次安裝需要 root、可連線 GitHub／Node.js／npm，以及符合 Node.js 執行需求的現代 Linux。舊版 glibc、Alpine/OpenRC、非 systemd 容器不在自動安裝範圍；安裝程式會檢查並停止，不會嘗試編譯核心。

目前已做本機功能測試與腳本語法檢查，尚未逐一實機驗證各 VPS 發行版。供應商封鎖 GitHub、DNS 故障或安全群組限制仍需由環境端處理。

## GitHub 安裝

將此版本完整上傳至 GitHub 後使用（必須包含 `lib/` 與 `package-lock.json`）：

```bash
curl -fL --retry 3 --connect-timeout 15 --max-time 120 \
  https://raw.githubusercontent.com/kuobou/kuoboX/main/install.sh -o install.sh
sudo bash install.sh
```

預設面板端口為 3000，產生隨機初始密碼。可指定端口：

```bash
sudo env PANEL_PORT=3443 bash install.sh
```

安裝採 GitHub 壓縮包，不需要 git 或 unzip；下載有逾時、重試，Node.js 與新裝 sing-box 使用 SHA-256 校驗。已存在的 sing-box 不會被升級或替換；新裝核心採官方穩定版。可透過 `KUOBOX_REF` 選擇面板 tag／commit；正式部署建議使用已驗證版本。

初次安裝尚無 sing-box 設定時，不啟動空白代理；登入面板新增節點或貼入完整設定，再套用。面板使用 HTTPS 自簽憑證，瀏覽器會顯示未受信任；可將正式憑證放至 `/opt/kuobox/cert/cert.pem`、`key.pem` 後重啟面板。

## 更新與管理

```bash
kuobox                      # 管理選單：啟停、日誌、密碼、端口、更新、卸載
systemctl restart kuobox
journalctl -u kuobox -n 50 --no-pager
journalctl -u sing-box -n 50 --no-pager
```

更新先下載及安裝依賴，再備份替換面板；啟動失敗會嘗試還原。`.env`、憑證、`panel-state.json`、sing-box 核心與設定不會被面板更新覆蓋。更新不是核心升級，不保證無損中斷正在進行的面板設定操作；請在套用完成後更新。

舊版若仍使用 `changeme123`，請先修改密碼再更新。安裝腳本不會自动修改防火牆；請開放必要的中轉端口，面板端口則依實際管理來源設定規則。

## 設定方式

中轉機先新增入站端口，再填落地機地址、端口和認證資料；缺少出口資料不能套用，不會偷偷退回本機直連。出站 TLS 啟用時預設驗證憑證，使用 IP 連線但憑證為域名時請填 SNI。自訂 CA、其他協定或特殊 TLS 需求可在完整編輯器設定。

Trojan／一般 TLS 入站預設憑證路徑為 `/etc/ssl/cert.pem` 與 `/etc/ssl/key.pem`，需準備對應服務憑證，或在完整編輯器指定自己的路徑；面板憑證與代理憑證是各自獨立的。

流量網卡預設選擇 IPv4 預設路由介面，找不到時選第一個非 loopback 介面；多網卡／IPv6-only 主機可在 `.env` 設定：

```ini
TRAFFIC_INTERFACE=eth0
SINGBOX_CONFIG=/etc/sing-box/config.json
```

原始設定讀寫的路径由 `SINGBOX_CONFIG` 決定，需與現有 sing-box systemd 服務的 `-c` 路徑一致。API 不接受 URL token；登入只使用 header token，存在目前瀏覽器分頁 sessionStorage。修改密碼撤銷舊登入。

缺少憑證時面板不會自動降級 HTTP。反向代理或本機開發需明確設定 `PANEL_ALLOW_HTTP=1`，此時預設只監聽 `127.0.0.1`；可用 `PANEL_HOST` 調整。`.env` 由 systemd 載入，直接 `node server.js` 時需自行提供環境變數。

## 開發驗證

```bash
npm ci --ignore-scripts
npm test
bash -n install.sh
bash -n kuobox.sh
```

測試覆蓋設定保留、驗證拒絕、核心缺失、重啟／還原失敗、初次安裝還原、併發與版本衝突，以及中轉生成驗證。服務操作在單元測試中使用替身，不能取代 Linux VPS 上的實際轉發、systemd 和防火牆測試。
