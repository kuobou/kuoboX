# RelayBox 中轉管理面板

sing-box 中轉機管理面板，一鍵安裝、圖形化設定、實時監控。支援多端口獨立設定，每個端口可對應不同落地機。

## 功能

- **實時流量圖**：每 2 秒更新的收發速度圖表（canvas 繪製，無外部依賴）
- **系統監控**：CPU / 記憶體 / 磁碟 / 運行時間 / 公網 IP / 總流量
- **服務管理**：sing-box 重啟 / 停止 / 狀態顯示 / 錯誤原因
- **多端口設定**：中轉機與落地機均支援多端口，每端口獨立設定
  - **中轉機**：每端口有獨立 UUID、Short ID、落地機出站設定
  - **落地機**：每端口有獨立 UUID，可複製給對應中轉機
  - 支援協議：VLESS+REALITY（推薦）/ Trojan TLS / VMess+WS / Shadowsocks
- **一鍵生成連結**：每個端口可單獨生成 v2rayN / Clash 匯入連結
- **連通測試**：ICMP Ping + TCP 端口測試
- **設定編輯器**：直接編輯 `/etc/sing-box/config.json`，儲存前自動驗證
- **即時日誌**：sing-box 服務日誌
- **路由規則**：CN 直連 / 廣告封鎖等路由設定生成
- **密碼保護登入**（含登入頻率限制）

---

## 快速部署

在中轉機或落地機伺服器上執行：

```bash
curl -fsSL https://raw.githubusercontent.com/kuobou/relaybox/main/install.sh -o install.sh && bash install.sh
```

安裝腳本會自動完成：
- 安裝 Node.js 20（預編譯二進位，amd64 / arm64）
- 安裝 sing-box（從 GitHub 下載最新版）
- 安裝 vnstat（流量統計）
- 建立 systemd 服務，開機自啟

安裝完成後開啟 `http://你的IP:3000`，使用設定的密碼登入。

---

## 更新

```bash
cd /opt/relaybox && git pull && systemctl restart relaybox && echo "更新完成"
```

首次需初始化 git（只需執行一次）：

```bash
cd /opt/relaybox
git init
git remote add origin https://github.com/kuobou/relaybox.git
git fetch origin main
git checkout -b main
git branch --set-upstream-to=origin/main main
git reset --hard origin/main
```

---

## 架構說明

```
客戶端 (v2rayN / Clash)
    │  VLESS+REALITY / Trojan / VMess
    ▼
中轉機 (任意 VPS)   ← 安裝本面板
    │  VLESS / Trojan / Shadowsocks
    ▼
落地機 (台灣 / 目標地區)   ← 可同時安裝本面板
    │  直連
    ▼
  網際網路
```

多端口範例（每端口對應不同落地機）：

```
客戶端 → 中轉機:20000 → 落地機A:8443
客戶端 → 中轉機:30000 → 落地機B:9443
```

---

## 目錄結構

```
relaybox/
├── server.js        # Express 後端 API
├── public/
│   └── index.html   # 前端面板（單頁應用，無框架依賴）
├── .env             # 環境變數（面板端口、密碼）
└── install.sh       # 一鍵安裝腳本
```

---

## 手動管理

```bash
# 面板
systemctl restart relaybox     # 重啟面板
systemctl stop relaybox        # 停止面板
journalctl -u relaybox -f      # 查看面板日誌

# sing-box
systemctl restart sing-box     # 重啟 sing-box
systemctl status sing-box      # 查看 sing-box 狀態
cat /var/log/sing-box.log      # 查看 sing-box 日誌
cat /etc/sing-box/config.json  # 查看當前設定
```

---

## 使用流程

### 落地機設定（先做）
1. 登入落地機面板 → 設定生成 → 選擇「落地機」
2. 選擇協議（VLESS 推薦）
3. 點「＋ 新增端口」，填入監聽端口
4. 展開端口卡片，複製 UUID
5. 填入公網 IP → 點「生成連結」備用
6. 點「套用到本機並重啟」

### 中轉機設定
1. 登入中轉機面板 → 設定生成 → 選擇「中轉機」
2. 選擇入站協議（VLESS+REALITY 推薦）
3. 點「＋ 新增端口」，填入監聽端口
4. 展開端口卡片，填入落地機 IP / 端口 / UUID
5. 在「REALITY 全域設定」點「本機生成」產生密鑰對
6. 點「套用到本機並重啟」
7. 展開端口卡片 → 點「生成連結」→ 複製匯入 v2rayN

---

## 防火牆

安裝完成後需開放對應端口：

**Oracle Linux / CentOS（firewalld）**
```bash
firewall-cmd --permanent --add-port=3000/tcp    # 面板
firewall-cmd --permanent --add-port=20000/tcp   # sing-box 入站（依實際設定）
firewall-cmd --reload
```

**AWS EC2**：在 Security Group → Inbound rules 新增 Custom TCP 規則。

**Ubuntu（ufw）**
```bash
ufw allow 3000/tcp
ufw allow 20000/tcp
```

---

## 安全建議

1. **修改預設密碼**：安裝時設定強密碼，或編輯 `/opt/relaybox/.env` 後重啟
2. **防火牆限制**：限制面板端口（預設 3000）只允許你的 IP 存取
3. **HTTPS**：建議在面板前加 Nginx + Let's Encrypt
4. **面板端口**：避免使用常見端口，降低被掃描風險
