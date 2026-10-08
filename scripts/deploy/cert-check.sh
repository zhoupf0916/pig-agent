#!/usr/bin/env bash
# Read-only TLS certificate / renewal report for the Pig Agent host. It changes NOTHING:
# no renew, no dry-run, no reload, no file writes. Root-only files are read through `sudo -n` only when
# passwordless sudo exists; private keys are never opened and ACME account ids are filtered out.
#   bash cert-check.sh [host]        (default: host of WEB_PUBLIC_ORIGIN in stack.env)
set -uo pipefail
ROOT=${PIG_DEPLOY_ROOT:-/home/ubuntu/pig-agent}
HOST=${1:-$(grep -m1 '^WEB_PUBLIC_ORIGIN=' "$ROOT/data/cloud-local/stack.env" 2>/dev/null | cut -d= -f2- | tr -d "\"'" | sed -E 's#^https?://##; s#[:/].*##')}
HOST=${HOST:-193.112.22.18}
S=""; sudo -n true 2>/dev/null && S="sudo -n"
R() { $S "$@" 2>/dev/null; }
sec() { printf '\n== %s ==\n' "$*"; }
hide() { grep -vE '^\s*account\s*=' ; }
CLIENTS=() TIMERS=() HOOK=no SERVED_SERIAL="" DISK_SERIAL="" NOTAFTER=""
echo "cert-check for $HOST  ($(date '+%F %T %Z'); root reads: ${S:-unavailable, showing what ubuntu can read})"

sec "served certificate (127.0.0.1:443, SNI $HOST)"
PEM=$(echo | timeout 10 openssl s_client -connect 127.0.0.1:443 -servername "$HOST" 2>/dev/null | openssl x509 2>/dev/null)
if [ -n "$PEM" ]; then
  openssl x509 -noout -subject -issuer -serial -startdate -enddate <<<"$PEM"
  openssl x509 -noout -ext subjectAltName <<<"$PEM" 2>/dev/null | tail -n +2 | sed 's/^ */SAN: /'
  SERVED_SERIAL=$(openssl x509 -noout -serial <<<"$PEM" | cut -d= -f2)
  NOTAFTER=$(openssl x509 -noout -enddate <<<"$PEM" | cut -d= -f2)
  echo "days left: $(( ($(date -d "$NOTAFTER" +%s) - $(date +%s)) / 86400 ))  (notAfter local: $(date -d "$NOTAFTER" '+%F %T %Z'))"
else echo "could not fetch the served certificate from 127.0.0.1:443"; fi

sec "ACME clients"
CB=""; for b in /opt/pig-certbot/bin/certbot "$(command -v certbot 2>/dev/null)" /snap/bin/certbot; do [ -n "$b" ] && [ -x "$b" ] && { CB=$b; break; }; done
if [ -n "$CB" ] || R test -d /etc/letsencrypt/renewal; then
  CLIENTS+=(certbot); echo "certbot: ${CB:-binary not found} $([ -n "$CB" ] && $CB --version 2>&1 | head -1)"
  for f in $(R ls /etc/letsencrypt/renewal/ | grep '\.conf$'); do
    echo "  renewal/$f:"; R cat "/etc/letsencrypt/renewal/$f" | hide | grep -E '^\s*(version|authenticator|installer|webroot_path|server|preferred_profile|renew_hook|deploy_hook|post_hook|pre_hook|ip_address|key_type)\b' | sed 's/^/    /'
    R grep -qE '^\s*(renew_hook|deploy_hook|post_hook)\s*=.*(nginx|reload)' "/etc/letsencrypt/renewal/$f" && HOOK=yes
  done
  CERT=$(R ls -d "/etc/letsencrypt/live/$HOST" >/dev/null && echo "/etc/letsencrypt/live/$HOST/cert.pem")
  if [ -n "$CERT" ]; then
    DISK_SERIAL=$(R openssl x509 -in "$CERT" -noout -serial | cut -d= -f2)
    echo "  on-disk $CERT: serial=$DISK_SERIAL $(R openssl x509 -in "$CERT" -noout -enddate) mtime=$(R stat -L -c %y "$CERT" | cut -d. -f1)"
  fi
  R test -d /var/log/letsencrypt || echo "  /var/log/letsencrypt not readable"
fi
for d in "$HOME/.acme.sh" /root/.acme.sh; do
  if R test -f "$d/acme.sh"; then CLIENTS+=(acme.sh); echo "acme.sh: $d"
    R grep -h -E "^Le_(Domain|NextRenewTimeStr|ReloadCmd|RealFullChainPath)=" "$d"/*/*.conf | sed "s/^/  /; s/__ACME_BASE64__START_\(.*\)__ACME_BASE64__END_/\1 (base64)/"
    R grep -qh '^Le_ReloadCmd=.\+' "$d"/*/*.conf && HOOK=yes
  fi
done
if command -v lego >/dev/null || R test -d /etc/lego || R test -d "$HOME/.lego"; then CLIENTS+=(lego); echo "lego: $(command -v lego || echo 'binary not in PATH') $(R ls -d /etc/lego "$HOME/.lego" | tr '\n' ' ')"; fi
if command -v caddy >/dev/null || systemctl list-unit-files caddy.service >/dev/null 2>&1 && systemctl cat caddy.service >/dev/null 2>&1; then CLIENTS+=(caddy); echo "caddy: $(command -v caddy || echo 'binary not in PATH') service=$(systemctl is-active caddy 2>/dev/null)"; fi
[ ${#CLIENTS[@]} = 0 ] && echo "no ACME client found (certbot / acme.sh / lego / caddy)"

sec "schedulers (systemd timers / cron)"
systemctl list-timers --all --no-pager 2>/dev/null | grep -Ei 'cert|acme|lego|caddy|letsencrypt|renew' || echo "no matching systemd timer"
for u in pig-cert-renew.timer certbot.timer snap.certbot.renew.timer; do
  systemctl cat "$u" >/dev/null 2>&1 || continue; TIMERS+=("$u")
  echo "$u: $(systemctl is-enabled "$u" 2>/dev/null)/$(systemctl is-active "$u" 2>/dev/null) $(systemctl show "$u" -p OnCalendar -p LastTriggerUSec -p NextElapseUSecRealtime --no-pager 2>/dev/null | grep -v '=$' | tr '\n' ' ')"
  svc=${u%.timer}.service
  echo "  $svc ExecStart: $(systemctl show "$svc" -p ExecStart --value 2>/dev/null | grep -oE 'argv\[\]=[^;]*' | sed 's/argv\[\]=//') | last result: $(systemctl show "$svc" -p Result --value 2>/dev/null) exit=$(systemctl show "$svc" -p ExecMainStatus --value 2>/dev/null)"
done
c=$(crontab -l 2>/dev/null | grep -Ei 'cert|acme|lego|renew' || true); [ -n "$c" ] && echo "crontab(ubuntu): $c"
c=$(R crontab -l -u root | grep -Ei 'cert|acme|lego|renew' || true); [ -n "$c" ] && echo "crontab(root): $c"
for f in $(ls /etc/cron.d /etc/cron.daily /etc/cron.weekly 2>/dev/null | grep -Ei 'cert|acme|lego' ); do echo "cron file: $f"; done
grep -sEi 'cert|acme|lego|renew' /etc/crontab | sed 's/^/\/etc\/crontab: /'

sec "last renewal log lines"
R journalctl -u pig-cert-renew.service -u certbot.service -u snap.certbot.renew.service --no-pager -n 12 -o short-iso | grep -v '^-- ' || echo "journal not readable (needs sudo or adm/systemd-journal group)"
R grep -hE "Renewing an existing|Certificate not yet due|no renewals were attempted|renewal failed|Congratulations|Running deploy-hook|Hook '--deploy-hook'|Error|error:" /var/log/letsencrypt/letsencrypt.log | tail -n 10 | cut -c1-220
L=$(R ls -t /var/log/letsencrypt/ | head -1); [ -n "$L" ] && echo "latest letsencrypt log: /var/log/letsencrypt/$L $(R stat -c %y "/var/log/letsencrypt/$L" | cut -d. -f1)"

sec "nginx reload after renewal"
for dir in deploy post; do
  for h in $(R ls "/etc/letsencrypt/renewal-hooks/$dir"); do
    p=/etc/letsencrypt/renewal-hooks/$dir/$h
    echo "hook $p ($(R stat -c '%A' "$p")): $(R cat "$p" | grep -vE '^\s*(#|$)' | tr '\n' ';' | cut -c1-200)"
    R grep -qE 'nginx.*(reload|-s reload)|systemctl (reload|restart) nginx' "$p" && R test -x "$p" && HOOK=yes
  done
done
echo "nginx: $(systemctl is-active nginx 2>/dev/null); master since $(ps -o lstart= -C nginx --sort=start_time 2>/dev/null | head -1); workers since $(ps -o lstart= --ppid "$(pgrep -o -x nginx 2>/dev/null || echo 1)" 2>/dev/null | head -1)"
R journalctl -u nginx --no-pager -n 200 -o short-iso | grep -iE 'reload' | tail -n 3
if [ -n "$SERVED_SERIAL" ] && [ -n "$DISK_SERIAL" ]; then
  [ "$SERVED_SERIAL" = "$DISK_SERIAL" ] && SERVING="yes (served serial == on-disk serial)" || SERVING="NO — nginx serves serial $SERVED_SERIAL but disk has $DISK_SERIAL (reload missing)"
else SERVING="unknown (on-disk cert not readable without sudo)"; fi

sec "verdict"
echo "ACME client     : ${CLIENTS[*]:-none found}"
echo "scheduler       : ${TIMERS[*]:-no systemd timer found}$(crontab -l 2>/dev/null | grep -qEi 'cert|acme|lego' && echo ' + user cron')"
echo "notAfter        : ${NOTAFTER:-unknown}"
echo "reload hook     : $HOOK (nginx reload configured after renewal)"
echo "nginx up to date: $SERVING"
