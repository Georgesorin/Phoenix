#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  Phoenix LED Hack — Universal Launcher
#  Usage: ./run.sh <component>
# ═══════════════════════════════════════════════════════════════════════════
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$ROOT_DIR/.venv"
VENV_PY="$VENV_DIR/bin/python3"

# ── Activate venv if it exists ────────────────────────────────────────────
activate_venv() {
    if [ -f "$VENV_PY" ]; then
        source "$VENV_DIR/bin/activate"
    else
        echo "[!] Virtual environment not found. Run ./setup.sh first."
        exit 1
    fi
}

# ── Run a Python script with venv ─────────────────────────────────────────
run_py() {
    activate_venv
    echo "─── Running: $1 ───"
    cd "$ROOT_DIR"
    exec "$VENV_PY" "$1"
}

# ── Run Node.js server ────────────────────────────────────────────────────
run_node() {
    if ! command -v node &>/dev/null; then
        echo "[!] Node.js not found. Run ./setup.sh first."
        exit 1
    fi
    echo "─── Running: game-server ───"
    cd "$ROOT_DIR/game-server"
    exec node server.js
}

# ── Help ──────────────────────────────────────────────────────────────────
show_help() {
    echo "═══════════════════════════════════════════════════════════"
    echo "  Phoenix LED Hack — Launcher"
    echo "═══════════════════════════════════════════════════════════"
    echo ""
    echo "  Usage: ./run.sh <component>"
    echo ""
    echo "  Evil Eye:"
    echo "    evil-eye-1       Evil Eye game (game1)"
    echo "    evil-eye-2       Last Light game (game2)"
    echo "    evil-eye-4       Broken Telephone game (game4)"
    echo "    evil-eye-ctrl    Evil Eye Controller GUI"
    echo "    evil-eye-sim     Evil Eye Simulator"
    echo ""
    echo "  Matrix:"
    echo "    matrix-ctrl      Matrix Controller GUI"
    echo "    matrix-sim       Matrix Simulator"
    echo ""
    echo "  Game Server:"
    echo "    game-server      NeonBreach / Shooter (Node.js)"
    echo ""
    echo "  Other:"
    echo "    sim              Root Simulator"
    echo "    tetris           Tetris Example"
    echo ""
    echo "═══════════════════════════════════════════════════════════"
}

# ── Dispatch ──────────────────────────────────────────────────────────────
case "${1:-}" in
    evil-eye-1|ee1)
        run_py "EvilEye/game1/evil_eye_game.py"
        ;;
    evil-eye-2|ee2)
        run_py "EvilEye/game2/last_light.py"
        ;;
    evil-eye-4|ee4)
        run_py "EvilEye/game4/broken_telephone.py"
        ;;
    evil-eye-ctrl|ee-ctrl)
        run_py "EvilEye/Controller.py"
        ;;
    evil-eye-sim|ee-sim)
        run_py "EvilEye/Simulator.py"
        ;;
    matrix-ctrl|mc)
        run_py "Matrix/Controller.py"
        ;;
    matrix-sim|ms)
        run_py "Matrix/Simulator.py"
        ;;
    sim)
        run_py "Simulator.py"
        ;;
    tetris)
        run_py "Example/Tetris_Game.py"
        ;;
    game-server|gs)
        run_node
        ;;
    help|-h|--help)
        show_help
        ;;
    *)
        echo "[!] Unknown component: '${1:-}'"
        echo ""
        show_help
        exit 1
        ;;
esac
