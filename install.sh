#!/bin/sh
# Install LvW-harness on a Linux VPS (x64 or arm64) as a systemd service.
#   curl -fsSL https://raw.githubusercontent.com/Gitguy268/LvW-harness/main/install.sh | sudo sh
# Or with a binary you built yourself (bun run build:all):
#   sudo LVW_BINARY=./dist/lvw-linux-x64 sh install.sh
# The server listens on 127.0.0.1:7878; put Caddy or another HTTPS proxy in front (see README).
set -eu

REPO="${LVW_REPO:-Gitguy268/LvW-harness}"
VERSION="${LVW_VERSION:-latest}"

[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }
[ "$(uname -s)" = Linux ] || { echo "install.sh is for Linux. On macOS use the lvw binary or bun directly." >&2; exit 1; }
case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac

if [ -n "${LVW_BINARY:-}" ]; then
  install -m 755 "$LVW_BINARY" /usr/local/bin/lvw
else
  if [ "$VERSION" = latest ]; then URL="https://github.com/$REPO/releases/latest/download/lvw-linux-$ARCH"
  else URL="https://github.com/$REPO/releases/download/$VERSION/lvw-linux-$ARCH"; fi
  echo "Downloading $URL"
  curl -fL --progress-bar -o /usr/local/bin/lvw.tmp "$URL"
  chmod 755 /usr/local/bin/lvw.tmp && mv /usr/local/bin/lvw.tmp /usr/local/bin/lvw
fi

id lvw >/dev/null 2>&1 || useradd --system --home-dir /var/lib/lvw --shell /usr/sbin/nologin lvw
mkdir -p /var/lib/lvw/work
chown -R lvw:lvw /var/lib/lvw

if [ ! -f /etc/lvw.env ]; then
  TOKEN=$(head -c 24 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')
  (umask 077; printf 'LVW_TOKEN=%s\n' "$TOKEN" > /etc/lvw.env)
  echo "Login token (also in /etc/lvw.env): $TOKEN"
fi

# llama-server for CPU inference, installed into LVW_HOME.
su -s /bin/sh lvw -c 'LVW_HOME=/var/lib/lvw /usr/local/bin/lvw runtime install'

if command -v systemctl >/dev/null 2>&1; then
  if [ -f deploy/lvw.service ]; then cp deploy/lvw.service /etc/systemd/system/lvw.service
  else curl -fsSL -o /etc/systemd/system/lvw.service "https://raw.githubusercontent.com/$REPO/main/deploy/lvw.service"; fi
  systemctl daemon-reload
  systemctl enable --now lvw
  echo "LvW is running on 127.0.0.1:7878. Pull a model: sudo -u lvw LVW_HOME=/var/lib/lvw lvw model pull <spec>"
else
  echo "No systemd found. Start it with: sudo -u lvw LVW_HOME=/var/lib/lvw lvw serve"
fi
