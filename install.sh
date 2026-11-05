#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if [[ ${EUID} -ne 0 ]]; then
  command -v sudo >/dev/null || { echo "Run as root or install sudo."; exit 1; }
  exec sudo --preserve-env=PATH bash "$0" "$@"
fi
# shellcheck source=/dev/null
source /etc/os-release
case "${ID:-}" in ubuntu|debian) ;; *) echo "Only Ubuntu and Debian are supported."; exit 1 ;; esac
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  apt-get update
  apt-get install -y ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  arch=$(dpkg --print-architecture)
  codename=${UBUNTU_CODENAME:-${VERSION_CODENAME}}
  cat > /etc/apt/sources.list.d/docker.sources <<SOURCES
Types: deb
URIs: https://download.docker.com/linux/$ID
Suites: $codename
Components: stable
Architectures: $arch
Signed-By: /etc/apt/keyrings/docker.asc
SOURCES
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
command -v curl >/dev/null || { apt-get update; apt-get install -y curl; }
if [[ -f .env ]]; then
  echo "Keeping the existing .env. Back it up before making manual changes."
else
  read -r -p "Mode [cookie/cookieless] (default cookie): " mode
  mode=${mode:-cookie}
  [[ $mode == cookie || $mode == cookieless ]] || { echo "Invalid mode."; exit 1; }
  while true; do
    read -r -p "Tracker domain (e.g. kx7qpa.example.com): " tracker
    [[ $tracker =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$ ]] && break
    echo "Enter a domain only, without a URL, path or port."
  done
  while true; do
    read -r -p "Website origin (e.g. https://www.example.com): " site
    site=${site%/}
    [[ $site =~ ^https://([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$ ]] && break
    echo "Use an HTTPS website origin without a path, query or port."
  done
  website_host=${site#https://}
  website_host=$(printf '%s' "$website_host" | tr '[:upper:]' '[:lower:]')
  tracker=$(printf '%s' "$tracker" | tr '[:upper:]' '[:lower:]')
  cookie_domain=${website_host#www.}
  if [[ $mode == cookie && $tracker != "$cookie_domain" && $tracker != *".$cookie_domain" ]]; then
    echo "Cookie mode requires the tracker at $cookie_domain or a subdomain of it."
    echo "Use kx7qpa.$cookie_domain, change the website origin, or rerun with cookieless mode."
    exit 1
  fi
  while true; do
    read -r -p "Measurement ID from the SECOND property: " measurement
    [[ $measurement =~ ^G-[A-Z0-9]+$ && $measurement != G-XXXXXXXXXX ]] && break
    echo "Expected G- followed by letters and digits."
  done
  while true; do
    read -r -s -p "Measurement Protocol API secret: " api_secret
    echo
    [[ $api_secret =~ ^[a-zA-Z0-9_-]{10,128}$ ]] && break
    echo "Expected a 10–128 character API secret (letters, digits, _ or -)."
  done
  secret=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  # The shared parent allows the sibling tracker to set the website cookie.
  umask 077
  tmp_env=$(mktemp .env.XXXXXX)
  cat > "$tmp_env" <<ENV
TRACKER_DOMAIN=$tracker
SITE_ORIGIN=$site
GA4_MEASUREMENT_ID=$measurement
GA4_API_SECRET=$api_secret
TRACKING_MODE=$mode
COOKIE_SECRET=$secret
COOKIE_DOMAIN=$cookie_domain
ENV
  mv -- "$tmp_env" .env
fi
chmod 600 .env
# Read only the domain, without evaluating an existing configuration as shell code.
tracker=$(sed -n 's/^TRACKER_DOMAIN=//p' .env | head -n 1)
[[ $tracker =~ ^[a-zA-Z0-9.-]+$ && $tracker == *.* ]] || { echo "Invalid TRACKER_DOMAIN in .env."; exit 1; }
echo "DNS A for $tracker must point to this server's public IPv4 address."
server_ip=$(curl -4fsS --max-time 10 https://api.ipify.org || true)
dns_ips=$(getent ahostsv4 "$tracker" | awk '{print $1}' | sort -u || true)
if [[ -z $server_ip || -z $dns_ips ]] || ! printf '%s\n' "$dns_ips" | grep -Fxq "$server_ip"; then
  echo "DNS does not yet match the server's detected public IPv4 address."
  echo "Check the VPS address in your provider's panel, set an unproxied A record, wait for DNS, then rerun."
  exit 1
fi
echo "DNS matches. Allow inbound TCP 80 and 443 (also in the provider firewall). Remove stale AAAA records."
docker compose up -d --build
echo "Waiting up to three minutes for HTTPS and /health..."
deadline=$((SECONDS + 180))
while ((SECONDS < deadline)); do
  remaining=$((deadline - SECONDS))
  timeout=$((remaining < 5 ? remaining : 5))
  if curl -fsS --max-time "$timeout" "https://$tracker/health" >/dev/null; then
    echo "Ready. Add this once to your website:"
    printf '<script defer src="https://%s/s.js"></script>\n' "$tracker"
    exit 0
  fi
  remaining=$((deadline - SECONDS))
  if ((remaining > 0)); then sleep "$((remaining < 5 ? remaining : 5))"; fi
done
echo "HTTPS is not ready. Check DNS, ports 80/443 and: sudo docker compose logs --tail=50"
exit 1
