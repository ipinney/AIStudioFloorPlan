#!/bin/sh
# Update the Floor Plan Wizard on spark: pull, install, build, restart.
# Run on spark as eliot from ~/floorplan. The service is the systemd user unit
# floorplan.service (Tailscale-only, http://100.101.34.117:8790).
set -e
cd "$(dirname "$0")/.."
git pull --ff-only
npm ci --no-audit --no-fund
npm run build
systemctl --user restart floorplan
sleep 3
curl -fsS "http://${HOST:-100.101.34.117}:${PORT:-8790}/api/health" && echo
