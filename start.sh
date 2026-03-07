#!/bin/bash
# Start Nerdy AI Tutor — server + client in parallel
echo "Starting Nerdy AI Tutor..."

# Start server in background
cd "$(dirname "$0")/server"
npm run dev &
SERVER_PID=$!

# Start client in background
cd "$(dirname "$0")/client"
npm run dev &
CLIENT_PID=$!

echo "Server PID: $SERVER_PID"
echo "Client PID: $CLIENT_PID"
echo "Open http://localhost:5173 in your browser."
echo "Press Ctrl+C to stop both."

# Wait for either to exit, then kill both
trap "kill $SERVER_PID $CLIENT_PID 2>/dev/null; exit" INT TERM
wait
