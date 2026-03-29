#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  Phoenix LED Hack — Full Environment Setup
#  Works on any fresh Linux machine (Ubuntu/Debian/Fedora/Arch)
#  Installs: Python3 + venv + pip, Node.js + npm, all project dependencies
# ═══════════════════════════════════════════════════════════════════════════
set -e

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$ROOT_DIR/.venv"

echo "═══════════════════════════════════════════════════════════"
echo "  Phoenix LED Hack — Environment Setup"
echo "═══════════════════════════════════════════════════════════"
echo "  Project root: $ROOT_DIR"
echo ""

# ─── Detect package manager ──────────────────────────────────────────────────
install_pkg() {
    if command -v apt-get &>/dev/null; then
        sudo apt-get update -qq && sudo apt-get install -y -qq "$@"
    elif command -v dnf &>/dev/null; then
        sudo dnf install -y "$@"
    elif command -v pacman &>/dev/null; then
        sudo pacman -S --noconfirm "$@"
    elif command -v zypper &>/dev/null; then
        sudo zypper install -y "$@"
    else
        echo "[!] Could not detect package manager. Please install manually: $*"
        return 1
    fi
}

# ═══════════════════════════════════════════════════════════════════════════
# 1. PYTHON
# ═══════════════════════════════════════════════════════════════════════════
echo "── [1/4] Checking Python 3 ──────────────────────────────"

if ! command -v python3 &>/dev/null; then
    echo "  Python3 not found. Installing..."
    install_pkg python3
fi

# Ensure pip + venv modules are available
if ! python3 -m pip --version &>/dev/null 2>&1; then
    echo "  pip not found. Installing..."
    if command -v apt-get &>/dev/null; then
        install_pkg python3-pip python3-venv
    elif command -v dnf &>/dev/null; then
        install_pkg python3-pip
    elif command -v pacman &>/dev/null; then
        install_pkg python-pip
    fi
fi

# Ensure venv module works
if ! python3 -c "import venv" &>/dev/null 2>&1; then
    echo "  venv module not found. Installing..."
    if command -v apt-get &>/dev/null; then
        install_pkg python3-venv
    fi
fi

# Ensure tkinter is available (needed for Controller GUIs)
if ! python3 -c "import tkinter" &>/dev/null 2>&1; then
    echo "  tkinter not found. Installing..."
    if command -v apt-get &>/dev/null; then
        install_pkg python3-tk
    elif command -v dnf &>/dev/null; then
        install_pkg python3-tkinter
    elif command -v pacman &>/dev/null; then
        install_pkg tk
    fi
fi

PYVER=$(python3 --version 2>&1)
echo "  [✓] $PYVER"

# ═══════════════════════════════════════════════════════════════════════════
# 2. PYTHON VIRTUAL ENVIRONMENT + PACKAGES
# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "── [2/4] Setting up Python virtual environment ──────────"

if [ ! -d "$VENV_DIR" ]; then
    echo "  Creating venv at $VENV_DIR ..."
    python3 -m venv "$VENV_DIR"
fi

source "$VENV_DIR/bin/activate"
echo "  [✓] venv activated"

echo "  Installing Python packages..."
pip install --upgrade pip -q
pip install pygame psutil -q

echo "  [✓] Python packages installed (pygame, psutil)"

deactivate

# ═══════════════════════════════════════════════════════════════════════════
# 3. NODE.JS + NPM
# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "── [3/4] Checking Node.js ───────────────────────────────"

NODE_OK=false

if command -v node &>/dev/null; then
    NODE_VER=$(node --version 2>&1)
    echo "  [✓] Node.js $NODE_VER found"
    NODE_OK=true
fi

if [ "$NODE_OK" = false ]; then
    echo "  Node.js not found. Installing via NodeSource..."
    
    if command -v apt-get &>/dev/null; then
        # Debian/Ubuntu — use NodeSource
        if ! command -v curl &>/dev/null; then
            install_pkg curl
        fi
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        install_pkg nodejs
    elif command -v dnf &>/dev/null; then
        install_pkg nodejs npm
    elif command -v pacman &>/dev/null; then
        install_pkg nodejs npm
    else
        echo "  [!] Cannot auto-install Node.js. Please install it manually."
        echo "      https://nodejs.org/en/download/"
    fi
    
    if command -v node &>/dev/null; then
        NODE_VER=$(node --version 2>&1)
        echo "  [✓] Node.js $NODE_VER installed"
        NODE_OK=true
    fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# 4. NODE.JS DEPENDENCIES (game-server)
# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "── [4/4] Installing game-server dependencies ────────────"

if [ "$NODE_OK" = true ] && [ -f "$ROOT_DIR/game-server/package.json" ]; then
    cd "$ROOT_DIR/game-server"
    npm install --silent 2>&1 | tail -1
    echo "  [✓] game-server npm packages installed (express, ws)"
    cd "$ROOT_DIR"
else
    echo "  [!] Skipping — Node.js not available or package.json missing"
fi

# ═══════════════════════════════════════════════════════════════════════════
# DONE
# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  ✓ Setup complete!"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "  To run components, use the launcher scripts:"
echo ""
echo "  Evil Eye games:"
echo "    ./run.sh evil-eye-1      # Evil Eye game"
echo "    ./run.sh evil-eye-2      # Last Light game"
echo "    ./run.sh evil-eye-4      # Broken Telephone game"
echo "    ./run.sh evil-eye-ctrl   # Evil Eye Controller GUI"
echo "    ./run.sh evil-eye-sim    # Evil Eye Simulator"
echo ""
echo "  Matrix:"
echo "    ./run.sh matrix-ctrl     # Matrix Controller GUI"
echo "    ./run.sh matrix-sim      # Matrix Simulator"
echo ""
echo "  Game Server (Node.js):"
echo "    ./run.sh game-server     # NeonBreach / Shooter server"
echo ""
echo "  Or activate the venv manually:"
echo "    source .venv/bin/activate"
echo "═══════════════════════════════════════════════════════════"
