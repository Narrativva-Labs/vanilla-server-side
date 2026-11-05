#!/usr/bin/env bash
# Checks a finished installation. Run from the repository root with TRACKER set.
set -euo pipefail
: "${TRACKER:?Set TRACKER to the tracker domain}"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[[ $(sudo stat -c '%a' .env) == 600 ]] || fail ".env does not have mode 600"

secret=$(sudo sed -n 's/^COOKIE_SECRET=//p' .env)
default_secret=$(sed -n 's/^COOKIE_SECRET=//p' .env.example)
[[ $secret =~ ^[a-f0-9]{64}$ ]] || fail "COOKIE_SECRET is not a generated value"
[[ $secret != "$default_secret" ]] || fail "COOKIE_SECRET still has the default value"

container_state() {
  local id
  id=$(sudo docker compose ps -q "$1")
  [[ -n $id ]] || fail "no container for $1"
  sudo docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id"
}
[[ $(container_state tracker) == "running healthy" ]] || fail "tracker is not running and healthy"
# compose.yaml defines no healthcheck for Caddy; the HTTPS requests below go through it.
[[ $(container_state caddy) == "running none" ]] || fail "caddy is not running"

health=$(curl -fsS --max-time 10 "https://$TRACKER/health")
jq -e '.ok == true' <<<"$health" >/dev/null || fail "/health did not return ok: $health"
jq -e '.google.sent == 0 and .google.errors == 0' <<<"$health" >/dev/null || fail "something was sent to Google: $health"

status=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "https://$TRACKER/s.js")
[[ $status == 200 ]] || fail "/s.js returned $status"

echo "Installation checks passed."
