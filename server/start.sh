#!/bin/sh
# Entry point. If PROXY_URL is set (e.g. socks5h://172.29.0.1:1080 — a reverse tunnel
# to a residential IP), route ALL of the server's outbound traffic through it via
# proxychains, so WhatsApp (and everything) exits via that IP. Otherwise run directly.
set -e
if [ -n "$PROXY_URL" ]; then
  HP=$(echo "$PROXY_URL" | sed -E 's#^[a-z0-9]+://##; s#/.*$##; s#.*@##')
  HOST=$(echo "$HP" | cut -d: -f1)
  PORT=$(echo "$HP" | cut -d: -f2)
  cat > /etc/proxychains4.conf <<CONF
strict_chain
proxy_dns
tcp_read_time_out 15000
tcp_connect_time_out 8000
localnet 127.0.0.0/255.0.0.0
localnet 10.0.0.0/255.0.0.0
localnet 172.16.0.0/255.240.0.0
localnet 192.168.0.0/255.255.0.0
[ProxyList]
socks5 $HOST $PORT
CONF
  echo "[start] PROXY_URL set -> all traffic via proxychains4 socks5 $HOST:$PORT"
  exec proxychains4 -f /etc/proxychains4.conf node index.js
fi
exec node index.js
