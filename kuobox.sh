#!/bin/bash

red='\033[0;31m'
green='\033[0;32m'
yellow='\033[1;33m'
blue='\033[0;34m'
plain='\033[0m'

INSTALL_DIR="/opt/kuobox"
SERVICE_NAME="kuobox"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
ENV_FILE="${INSTALL_DIR}/.env"

log()  { echo -e "${green}[✓]${plain} $*"; }
warn() { echo -e "${yellow}[!]${plain} $*"; }
err()  { echo -e "${red}[✗]${plain} $*"; }
info() { echo -e "${blue}[~]${plain} $*"; }

[[ $EUID -ne 0 ]] && err "請使用 root 執行：sudo kuobox" && exit 1

check_status() {
    if [[ ! -f "$SERVICE_FILE" ]]; then return 2; fi
    local s
    s=$(systemctl is-active "$SERVICE_NAME" 2>/dev/null)
    [[ "$s" == "active" ]] && return 0 || return 1
}

show_status() {
    check_status
    case $? in
    0) echo -e "面板狀態：${green}運行中${plain}" ;;
    1) echo -e "面板狀態：${yellow}已停止${plain}" ;;
    2) echo -e "面板狀態：${red}未安裝${plain}" ;;
    esac
}

start_panel() {
    check_status
    if [[ $? == 0 ]]; then
        warn "面板已在運行中，無需再次啟動"
    else
        systemctl start "$SERVICE_NAME"
        sleep 1
        check_status && log "面板啟動成功" || err "面板啟動失敗，請查看日誌：journalctl -u $SERVICE_NAME -n 20"
    fi
}

stop_panel() {
    check_status
    if [[ $? == 1 ]]; then
        warn "面板已停止"
    else
        systemctl stop "$SERVICE_NAME"
        sleep 1
        check_status
        [[ $? == 1 ]] && log "面板已停止" || err "停止失敗"
    fi
}

restart_panel() {
    systemctl restart "$SERVICE_NAME"
    sleep 1
    check_status && log "面板重啟成功" || err "重啟失敗，請查看日誌：journalctl -u $SERVICE_NAME -n 20"
}

show_log() {
    echo ""
    echo -e "${green}\t1.${plain} 即時日誌（Ctrl+C 退出）"
    echo -e "${green}\t2.${plain} 最近 50 行"
    echo -e "${green}\t0.${plain} 返回主選單"
    read -rp "選擇: " choice
    case "$choice" in
    1) journalctl -u "$SERVICE_NAME" -f ;;
    2) journalctl -u "$SERVICE_NAME" -n 50 --no-pager ;;
    0) show_menu ;;
    *) err "無效選項"; show_log ;;
    esac
}

change_password() {
    echo ""
    read -rp "請輸入新的面板密碼（留空取消）: " new_pw
    [[ -z "$new_pw" ]] && warn "已取消" && return

    # 更新 .env
    if [[ -f "$ENV_FILE" ]]; then
        if grep -q "^PANEL_PASSWORD=" "$ENV_FILE"; then
            sed -i "s/^PANEL_PASSWORD=.*/PANEL_PASSWORD=${new_pw}/" "$ENV_FILE"
        else
            echo "PANEL_PASSWORD=${new_pw}" >> "$ENV_FILE"
        fi
    else
        echo "PANEL_PASSWORD=${new_pw}" > "$ENV_FILE"
        chmod 600 "$ENV_FILE"
    fi
    restart_panel
    log "密碼已更新，面板已重啟"
}

change_port() {
    echo ""
    read -rp "請輸入新的面板端口（留空取消）: " new_port
    [[ -z "$new_port" ]] && warn "已取消" && return
    if ! [[ "$new_port" =~ ^[0-9]+$ ]] || (( new_port < 1 || new_port > 65535 )); then
        err "端口不合法"
        return
    fi

    if [[ -f "$ENV_FILE" ]]; then
        if grep -q "^PANEL_PORT=" "$ENV_FILE"; then
            sed -i "s/^PANEL_PORT=.*/PANEL_PORT=${new_port}/" "$ENV_FILE"
        else
            echo "PANEL_PORT=${new_port}" >> "$ENV_FILE"
        fi
    else
        echo "PANEL_PORT=${new_port}" > "$ENV_FILE"
        chmod 600 "$ENV_FILE"
    fi
    restart_panel
    log "端口已更新為 ${new_port}，面板已重啟"
}

update_panel() {
    echo ""
    info "從 GitHub 下載最新版本..."
    curl -fsSL https://github.com/kuobou/kuoboX/archive/refs/heads/main.zip -o /tmp/kuobox.zip
    if [[ $? -ne 0 ]]; then
        err "下載失敗，請檢查網路連線"
        return
    fi
    unzip -q -o /tmp/kuobox.zip -d /tmp/
    cp -rf /tmp/kuoboX-main/. "$INSTALL_DIR/"
    rm -rf /tmp/kuobox.zip /tmp/kuoboX-main

    # 重新安裝管理指令
    if [[ -f "$INSTALL_DIR/kuobox.sh" ]]; then
        cp "$INSTALL_DIR/kuobox.sh" /usr/bin/kuobox
        chmod +x /usr/bin/kuobox
    fi

    # 重新安裝 npm 依賴
    cd "$INSTALL_DIR" && npm install --omit=dev >/dev/null 2>&1

    restart_panel
    log "更新完成"
}

uninstall_panel() {
    echo ""
    read -rp "確定要卸載 kuoboX 面板？所有設定將被刪除 [y/N]: " confirm
    [[ "$confirm" != "y" && "$confirm" != "Y" ]] && warn "已取消" && return

    info "停止並移除服務..."
    systemctl stop "$SERVICE_NAME" 2>/dev/null
    systemctl disable "$SERVICE_NAME" 2>/dev/null
    rm -f "$SERVICE_FILE"
    systemctl daemon-reload
    systemctl reset-failed 2>/dev/null

    info "刪除安裝目錄..."
    rm -rf "$INSTALL_DIR"

    info "移除管理指令..."
    rm -f /usr/bin/kuobox

    echo ""
    log "kuoboX 已完整卸載"
    echo "如需重新安裝，請執行："
    echo -e "${green}bash <(curl -fsSL https://raw.githubusercontent.com/kuobou/kuoboX/main/install.sh)${plain}"
    echo ""
    exit 0
}

show_info() {
    echo ""
    show_status
    # 讀取端口
    local port="3000"
    [[ -f "$ENV_FILE" ]] && port=$(grep "^PANEL_PORT=" "$ENV_FILE" | cut -d= -f2 || echo "3000")
    [[ -z "$port" ]] && port="3000"

    local ip
    ip=$(curl -4 -s --max-time 5 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
    echo -e "面板網址：${green}https://${ip}:${port}${plain}"
    echo -e "安裝目錄：${INSTALL_DIR}"
    echo ""
}

show_menu() {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "        ${green}kuoboX 管理面板${plain}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    show_status
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${green}\t1.${plain} 啟動面板"
    echo -e "${green}\t2.${plain} 停止面板"
    echo -e "${green}\t3.${plain} 重啟面板"
    echo -e "${green}\t4.${plain} 查看日誌"
    echo -e "${green}\t5.${plain} 查看面板資訊"
    echo "────────────────────────────────────────"
    echo -e "${green}\t6.${plain} 修改登入密碼"
    echo -e "${green}\t7.${plain} 修改面板端口"
    echo -e "${green}\t8.${plain} 更新面板"
    echo "────────────────────────────────────────"
    echo -e "${red}\t9.${plain} 卸載面板"
    echo -e "${green}\t0.${plain} 退出"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    read -rp "選擇操作 [0-9]: " choice
    echo ""
    case "$choice" in
    1) start_panel ;;
    2) stop_panel ;;
    3) restart_panel ;;
    4) show_log ;;
    5) show_info ;;
    6) change_password ;;
    7) change_port ;;
    8) update_panel ;;
    9) uninstall_panel ;;
    0) exit 0 ;;
    *) err "無效選項" ;;
    esac
    echo ""
    read -rp "按 Enter 返回主選單..." _
    show_menu
}

show_menu
