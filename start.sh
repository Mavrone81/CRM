#!/bin/bash
# Start server and web in parallel
echo "Starting WhatsApp server on :10001..."
cd server && node index.js &
SERVER_PID=$!

echo "Starting Next.js on :10000..."
cd ../web && npm run dev -- -p 10000 &
WEB_PID=$!

trap "kill $SERVER_PID $WEB_PID" EXIT
wait
