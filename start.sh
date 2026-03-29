#!/bin/bash
# Kill anything on our ports
lsof -ti :3001 | xargs kill -9 2>/dev/null
lsof -ti :3002 | xargs kill -9 2>/dev/null
lsof -ti :3003 | xargs kill -9 2>/dev/null
lsof -ti :5173 | xargs kill -9 2>/dev/null
sleep 0.5

# Start game server in background
echo "Starting game server..."
cd "$(dirname "$0")/game-server" && npm start &
SERVER_PID=$!
sleep 1

# Start Vite display (--open auto-opens browser)
echo "Starting display..."
cd "$(dirname "$0")/matrix-sim" && npm run dev &
VITE_PID=$!

echo ""
echo "==================================="
echo "  Game server: http://localhost:3001"
echo "  Display:     auto-opening browser"
echo "  Simulator:   run separately:"
echo "    TK_SILENCE_DEPRECATION=1 /usr/bin/python3 Simulator.py"
echo "==================================="
echo ""
echo "Press Ctrl+C to stop all"
wait
