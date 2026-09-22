#!/usr/bin/env bash
# kuoboX 管理選單（也可直接使用子指令：kuobox info|restart|log|password|port|bbr|update|core|uninstall）
umask 077
export PATH="/opt/kuobox-node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

INSTALL_DIR=/opt/kuobox
NODE_DIR=/opt/kuobox-node
ENV_FILE=$INSTALL_DIR/.env
CONF_FILE=$INSTALL_DIR/.install.conf

if [[ -t 1 ]]; then G=$'\033[32m' Y=$'\033[33m' R=$'\033[31m' B=$'\033[1m' D=$'\033[2m' N=$'\033[0m'; else G='' Y='' R='' B='' D='' N=''; fi
ok()   { printf '%s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '%s!%s %s\n' "$Y" "$N" "$*"; }
err()  { printf '%s✗%s %s\n' "$R" "$N" "$*"; }

[[ $EUID -eq 0 ]] || { err '請使用 root 執行：sudo kuobox'; exit 1; }

node_bin() { if [[ -x $NODE_DIR/bin/node ]]; then echo "$NODE_DIR/bin/node"; else command -v node; fi; }
conf() { [[ -r $CONF_FILE ]] && grep -E "^$1=" "$CONF_FILE" | tail -n1 | cut -d= -f2-; }
panel_port() { local p; p=$(grep -E '^PANEL_PORT=' "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2); echo "${p:-3000}"; }
state_of() {
  if ! systemctl cat "$1" >/dev/null 2>&1; then printf '%s未安裝%s' "$R" "$N"; return; fi
  case $(systemctl is-active "$1" 2>/dev/null) in
    active) printf '%s● 運行中%s' "$G" "$N" ;;
    activating) printf '%s● 啟動中%s' "$Y" "$N" ;;
    failed) printf '%s● 啟動失敗%s' "$R" "$N" ;;
    *) printf '%s● 已停止%s' "$Y" "$N" ;;
  esac
}
wait_active() { for _ in 1 2 3 4 5; do sleep 1; systemctl is-active --quiet "$1" && return 0; done; return 1; }

show_info() {
  local ip port
  port=$(panel_port)
  ip=$(curl -4 -fsS --connect-timeout 3 --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')
  echo
  printf '  面板網址   %shttps://%s:%s%s\n' "$B" "${ip:-你的VPS地址}" "$port" "$N"
  printf '  面板狀態   %s\n' "$(state_of kuobox)"
  printf '  sing-box   %s  %s%s%s\n' "$(state_of sing-box)" "$D" "$(sing-box version 2>/dev/null | head -n1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+[^ ]*')" "$N"
  printf '  設定檔     %s\n' "$(grep -E '^SINGBOX_CONFIG=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)"
  printf '  擁塞控制   %s\n' "$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null)"
  echo
}

restart_panel() {
  systemctl restart kuobox
  if wait_active kuobox; then ok '面板已重新啟動'; else err '面板啟動失敗：'; journalctl -u kuobox -n 15 --no-pager; fi
}

toggle_panel() {
  if systemctl is-active --quiet kuobox; then systemctl stop kuobox && ok '面板已停止（sing-box 與中轉不受影響）'
  else systemctl start kuobox; wait_active kuobox && ok '面板已啟動' || err '面板啟動失敗，請查看日誌'; fi
}

restart_core() {
  systemctl restart sing-box
  if wait_active sing-box; then ok 'sing-box 已重新啟動'; else err 'sing-box 啟動失敗：'; journalctl -u sing-box -n 15 --no-pager; fi
}

show_log() {
  local unit=${1:-kuobox}
  echo "  1) 即時日誌（Ctrl+C 結束）   2) 最近 80 行"
  read -rp "  選擇 [2]: " c
  if [[ $c == 1 ]]; then journalctl -u "$unit" -f; else journalctl -u "$unit" -n 80 --no-pager; fi
}

change_password() {
  local pw pw2
  read -rsp '新的面板密碼（直接 Enter 產生隨機密碼）: ' pw; echo
  if [[ -z $pw ]]; then
    pw=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)
  else
    read -rsp '再輸入一次: ' pw2; echo
    [[ $pw == "$pw2" ]] || { err '兩次輸入不一致'; return; }
  fi
  if KUOBOX_VALUE="$pw" "$(node_bin)" "$INSTALL_DIR/lib/update-env.js" PANEL_PASSWORD; then
    restart_panel
    printf '  新密碼：%s%s%s\n' "$B" "$pw" "$N"
  else err '密碼未更新'; fi
}

change_port() {
  local port old
  old=$(panel_port)
  read -rp "新的面板端口（目前 $old，留空取消）: " port
  [[ -z $port ]] && return
  if KUOBOX_VALUE="$port" "$(node_bin)" "$INSTALL_DIR/lib/update-env.js" PANEL_PORT; then
    if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q 'Status: active'; then ufw allow "$port/tcp" >/dev/null && ok "已在 ufw 放行 $port/tcp"; fi
    if command -v firewall-cmd >/dev/null && [[ $(firewall-cmd --state 2>/dev/null) == running ]]; then
      firewall-cmd --permanent --add-port="$port/tcp" >/dev/null && firewall-cmd --reload >/dev/null && ok "已在 firewalld 放行 $port/tcp"
    fi
    restart_panel
    warn "若 VPS 有安全組，請開放 TCP $port"
  else err '端口未更新'; fi
}

enable_bbr() {
  if [[ $(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null) == bbr ]]; then ok '已啟用 BBR'; return; fi
  local major minor
  IFS=. read -r major minor _ <<<"$(uname -r)"
  if (( major < 4 || (major == 4 && minor < 9) )); then err "核心 $(uname -r) 過舊，BBR 需要 4.9 以上"; return; fi
  modprobe tcp_bbr 2>/dev/null || true
  printf 'net.core.default_qdisc = fq\nnet.ipv4.tcp_congestion_control = bbr\n' > /etc/sysctl.d/99-kuobox-bbr.conf
  sysctl -q -p /etc/sysctl.d/99-kuobox-bbr.conf >/dev/null 2>&1
  if [[ $(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null) == bbr ]]; then ok 'BBR 已啟用（重開機後仍有效）'
  else rm -f /etc/sysctl.d/99-kuobox-bbr.conf; err '此系統（可能是 OpenVZ/LXC 容器）無法啟用 BBR'; fi
}

run_installer() {
  local dir repo ref proxy url
  repo=$(conf KUOBOX_REPO); repo=${repo:-kuobou/kuobox_test}
  ref=$(conf KUOBOX_REF); ref=${ref:-main}
  proxy=$(conf GH_PROXY)
  url="https://raw.githubusercontent.com/$repo/$ref/install.sh"
  [[ -z $proxy ]] || url="${proxy%/}/$url"
  dir=$(mktemp -d /var/tmp/kuobox-update.XXXXXXXX) || return
  echo "  下載安裝程式…"
  if curl -fLsS --retry 3 --connect-timeout 15 --max-time 120 --proto '=https' "$url" -o "$dir/install.sh" \
     || curl -fLsS --retry 2 --connect-timeout 15 --max-time 120 --proto '=https' "https://cdn.jsdelivr.net/gh/$repo@$ref/install.sh" -o "$dir/install.sh"; then
    if bash "$dir/install.sh" "$1"; then
      rm -rf -- "$dir"
      # bash 會繼續執行已載入的舊腳本，所以更新後要重新啟動選單才會用到新版
      if [[ -n ${IN_MENU:-} && $1 == update ]]; then
        read -rp '  按 Enter 載入新版選單…' _
        if [[ -x /usr/local/bin/kuobox ]]; then exec /usr/local/bin/kuobox; else exec bash "$0"; fi
      fi
      return 0
    fi
    err '未完成，請查看上方訊息（現有服務已保留）'
  else err '無法下載安裝程式，現有服務未變更'; fi
  rm -rf -- "$dir"
}

uninstall_all() {
  echo
  read -rp '確定要卸載 kuoboX 面板？[y/N]: ' c
  [[ $c == [yY] ]] || { warn '已取消'; return; }
  read -rp '同時移除 sing-box 核心與所有中轉設定？（選 N 則中轉繼續運作）[y/N]: ' also_core
  systemctl disable --now kuobox >/dev/null 2>&1
  rm -f /etc/systemd/system/kuobox.service
  rm -rf -- "$INSTALL_DIR" "$NODE_DIR"
  rm -f /usr/local/bin/kuobox /usr/bin/kuobox
  if [[ $also_core == [yY] ]]; then
    systemctl disable --now sing-box >/dev/null 2>&1
    rm -f /etc/systemd/system/sing-box.service
    [[ -x /usr/local/bin/sing-box ]] && rm -f /usr/local/bin/sing-box
    rm -rf /etc/sing-box /var/lib/sing-box
    ok '已移除 sing-box 與設定'
  fi
  systemctl daemon-reload
  systemctl reset-failed >/dev/null 2>&1
  ok 'kuoboX 已卸載'
  exit 0
}

MENU_ITEMS=(
  '1|查看面板網址與資訊' '2|重新啟動面板' '3|啟動／停止面板' '4|面板日誌'
  '5|重新啟動 sing-box' '6|sing-box 日誌' '7|升級 sing-box 核心'
  '8|修改面板密碼' '9|修改面板端口' '10|開啟 BBR 加速' '11|更新面板' '12|卸載' '0|離開'
)

menu() {
  clear 2>/dev/null
  printf '%skuoboX%s 中轉管理\n｜面板 %s\n｜sing-box %s\n\n' "$B" "$N" "$(state_of kuobox)" "$(state_of sing-box)"
  local item num
  # 每行以編號開頭、選項之間不空行；編號後補空白讓文字對齊
  for item in "${MENU_ITEMS[@]}"; do
    num=${item%%|*}
    if [[ $num == 12 ]]; then printf '%-4s%s%s%s\n' "$num." "$R" "${item#*|}" "$N"
    else printf '%-4s%s\n' "$num." "${item#*|}"; fi
  done
  echo
  read -rp '請選擇: ' choice
  echo
  case $choice in
    1) show_info ;; 2) restart_panel ;; 3) toggle_panel ;; 4) show_log kuobox ;;
    5) restart_core ;; 6) show_log sing-box ;; 7) run_installer core ;;
    8) change_password ;; 9) change_port ;; 10) enable_bbr ;; 11) run_installer update ;;
    12) uninstall_all ;; 0|q) exit 0 ;;
    *) err '無效選項' ;;
  esac
  echo
  read -rp '  按 Enter 返回選單…' _
}

case ${1:-} in
  '') IN_MENU=1; while true; do menu; done ;;
  info) show_info ;;
  restart) restart_panel ;;
  log) journalctl -u kuobox -n 80 --no-pager ;;
  password) change_password ;;
  port) change_port ;;
  bbr) enable_bbr ;;
  update) run_installer update ;;
  core) run_installer core ;;
  uninstall) uninstall_all ;;
  *) echo '用法：kuobox [info|restart|log|password|port|bbr|update|core|uninstall]'; exit 1 ;;
esac
