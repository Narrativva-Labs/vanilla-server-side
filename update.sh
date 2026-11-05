#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
[[ -f .env ]] || { echo "Run ./install.sh first."; exit 1; }
docker_cmd=(docker)
if [[ ${EUID} -ne 0 ]]; then
  command -v sudo >/dev/null || { echo "Run as root or install sudo."; exit 1; }
  sudo -v
  docker_cmd=(sudo docker)
fi
chmod 600 .env
[[ -z $(git status --porcelain --untracked-files=no) ]] || { echo "Save local tracked changes before updating."; exit 1; }
umask 077
backup=".env.backup.$(date +%Y%m%d%H%M%S)"
cp .env "$backup"
chmod 600 "$backup"
git pull --ff-only
"${docker_cmd[@]}" compose pull caddy
"${docker_cmd[@]}" compose build --pull tracker
"${docker_cmd[@]}" compose up -d --wait --wait-timeout 180
"${docker_cmd[@]}" compose ps
echo "Update complete and containers are healthy. Check your HTTPS /health and Realtime. Keep the .env backup private."
