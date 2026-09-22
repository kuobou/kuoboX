#!/usr/bin/env bash
umask 077
export PATH="/opt/kuobox-node/bin:/usr/local/bin:$PATH"

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
    0) return ;;
    *) err "無效選項" ;;
    esac
}

change_password() {
    local new_pw
    read -rsp "新的面板密碼（至少 12 字元，留空取消）: " new_pw
    printf '\n'
    [[ -z "$new_pw" ]] && return
    if KUOBOX_VALUE="$new_pw" node "$INSTALL_DIR/lib/update-env.js" PANEL_PASSWORD; then
        restart_panel
    else err "密碼未更新"; fi
}

change_port() {
    local new_port
    read -rp "新的面板端口（留空取消）: " new_port
    [[ -z "$new_port" ]] && return
    if KUOBOX_VALUE="$new_port" node "$INSTALL_DIR/lib/update-env.js" PANEL_PORT; then
        restart_panel
    else err "端口未更新"; fi
}

update_panel() {
    local update_dir
    update_dir=$(mktemp -d /tmp/kuobox-update.XXXXXXXX) || return
    info "從 GitHub 下載更新程式…"
    if curl -fLsS --retry 3 --connect-timeout 15 --max-time 120 --proto '=https' --tlsv1.2 \
        https://raw.githubusercontent.com/kuobou/kuoboX/main/install.sh -o "$update_dir/install.sh"; then
        bash "$update_dir/install.sh" update || err "更新未完成，請查看上方錯誤"
    else err "GitHub 下載失敗，現有服務未變更"; fi
    rm -rf -- "$update_dir"
}

uninstall_panel() {
    echo ""
    read -rp "確定要卸載 kuoboX 面板？[y/N]: " confirm
    [[ "$confirm" != "y" && "$confirm" != "Y" ]] && warn "已取消" && return

    read -rp "同時刪除網路設定檔？[y/N]: " del_cfg

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

    if [[ "$del_cfg" == "y" || "$del_cfg" == "Y" ]]; then
        rm -f /etc/sing-box/config.json
        log "sing-box 設定檔已刪除"
    fi

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
    ip=$(curl -fsS --connect-timeout 3 --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
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
}

while true; do show_menu; done
