# RelayBox 中轉管理面板

sing-box 中轉機管理面板，專為直播串流 / 流量中轉設計。安裝在中轉機上，一鍵生成設定、監控服務狀態、統計流量。

## 功能

- **系統監控**：CPU / 記憶體 / 磁碟 / 運行時間 / 公網 IP
- **流量統計**：本月接收 / 發送 / 累計（由 vnstat 提供）
- **服務管理**：sing-box 重啟 / 停止 / 狀態顯示 / 停止原因
- **設定生成**：中轉機 / 落地機 角色分開設定
  - 中轉機：VLESS+REALITY（推薦）/ Trojan / VMess+WS 入站 + 出站
  - 落地機：VLESS / Trojan / Shadowsocks 入站
- **VLESS 連結匯出**：一鍵複製給 v2rayN / Clash 使用
- **連通測試**：ICMP Ping + TCP 端口測試（確認中轉機到落地機連線）
- **即時日誌**：sing-box 服務日誌
- **路由規則**：CN / 廣告封鎖等路由設定生成
- **密碼保護登入**

---

## 快速部署

在中轉機伺服器上執行：

```bash
curl -fsSL https://raw.githubusercontent.com/kuobou/relaybox/main/install.sh -o install.sh && bash install.sh
```

安裝腳本會自動完成：
- 安裝 Node.js 20（使用 nvm，相容所有 Linux 發行版）
- 安裝 sing-box（從 GitHub 下載最新版）
- 安裝 vnstat（流量統計）
- 建立 systemd 服務，開機自啟

安裝完成後開啟 `http://你的IP:3000`，使用設定的密碼登入。

---

## 架構說明

```
客戶端 (v2rayN)
    │  VLESS + REALITY
    ▼
中轉機 (AWS / 任意 VPS)   ← 安裝本面板
    │  VLESS / Trojan / Shadowsocks
    ▼
落地機 (台灣 / 目標地區)
    │  直連
    ▼
  網際網路
```

---

## 目錄結構

```
relaybox/
├── server.js        # Express 後端
├── public/
│   └── index.html   # 前端面板（單頁應用）
├── .env             # 環境變數（面板端口、密碼）
└── install.sh       # 一鍵安裝腳本
```

---

## 手動管理

```bash
systemctl restart relaybox   # 重啟面板
systemctl stop relaybox      # 停止面板
journalctl -u relaybox -f    # 查看面板日誌

systemctl restart sing-box   # 重啟 sing-box
systemctl status sing-box    # 查看 sing-box 狀態
tail -f /var/log/sing-box.log  # 查看 sing-box 日誌
```

---

## 使用流程

### 中轉機設定
1. 登入面板 → 設定生成 → 選擇「中轉機」
2. 填入監聽端口、落地機 IP / 端口 / UUID
3. 點「本機生成」產生 REALITY 密鑰對
4. 點「套用到本機並重啟」
5. 點「生成連結」複製 VLESS 連結匯入 v2rayN

### 落地機設定（需另行安裝 sing-box 或 3x-ui）
1. 在落地機開啟 VLESS / Trojan / Shadowsocks inbound
2. 把 UUID 和端口填入中轉機面板的「落地機出站」欄位

---

## 安全建議

1. **修改預設密碼**：安裝時設定強密碼，或編輯 `/opt/relaybox/.env` 後重啟
2. **防火牆限制**：只允許你的 IP 連到面板端口（預設 3000）
3. **HTTPS**：建議在面板前加 Nginx + Let's Encrypt
4. **面板端口**：避免使用常見端口，降低被掃描風險
