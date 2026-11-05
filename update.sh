#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
[[ -f .env ]] || { echo "Run ./install.sh first."; exit 1; }
# install.sh runs through sudo, so .env normally belongs to root.
as_root=(env)
if [[ ${EUID} -ne 0 ]]; then
  command -v sudo >/dev/null || { echo "Run as root or install sudo."; exit 1; }
  sudo -v
  as_root=(sudo)
fi
"${as_root[@]}" chmod 600 .env
[[ -z $(git status --porcelain --untracked-files=no) ]] || { echo "Save local tracked changes before updating."; exit 1; }
git symbolic-ref -q HEAD >/dev/null || { echo "This checkout is not on a branch. Run git switch main, then rerun."; exit 1; }
umask 077
backup=".env.backup.$(date +%Y%m%d%H%M%S)"
"${as_root[@]}" cp -p .env "$backup"
"${as_root[@]}" chmod 600 "$backup"
git pull --ff-only
"${as_root[@]}" docker compose pull caddy
"${as_root[@]}" docker compose build --pull tracker
"${as_root[@]}" docker compose up -d --wait --wait-timeout 180
"${as_root[@]}" docker compose ps
echo "Update complete and containers are healthy. Check your HTTPS /health and Realtime. Keep the .env backup private."
