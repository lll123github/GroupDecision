#!/bin/bash
set -euo pipefail
bind="${DTRP_BIND:-0.0.0.0:18760}"
port="${bind##*:}"
exec 3<>"/dev/tcp/127.0.0.1/$port"
printf 'GET /api/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n' >&3
IFS= read -r response <&3
exec 3<&-
exec 3>&-
[[ "$response" == "HTTP/1.1 200 "* || "$response" == "HTTP/1.0 200 "* ]]
