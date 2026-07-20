#!/usr/bin/env bash
#
# Install everything needed to run the Farmhouse route-optimization project
# locally on macOS or Linux, then install the project's npm dependencies.
#
# Installs (only when missing):
#   - Node.js LTS (18+)   via Homebrew (macOS) or apt / dnf (Linux)
#   - PostgreSQL           unless --use-docker or --skip-db
# Then runs `npm install`.
#
# The script is idempotent: anything already present is detected and left
# alone. It never uninstalls, downgrades, or deletes anything.
#
# Usage (from the project root):
#   bash scripts/setup.sh [--use-docker] [--skip-db] [--skip-npm-install]
#
# Options:
#   --use-docker        Run a disposable PostgreSQL container instead of a
#                       local install (matches the README).
#   --skip-db           Do not install/start PostgreSQL (bring your own DB).
#   --skip-npm-install  Do not run `npm install`.
#
set -euo pipefail

# --- Configuration (matches the README Docker example) ---------------------
PG_CONTAINER_NAME="farmhouse-pg"
PG_PASSWORD="password"
PG_DATABASE="route_optimization"
PG_PORT=5432
DATABASE_URL="postgres://postgres:${PG_PASSWORD}@localhost:${PG_PORT}/${PG_DATABASE}"
MIN_NODE_MAJOR=18

USE_DOCKER=0
SKIP_DB=0
SKIP_NPM=0
for arg in "$@"; do
  case "$arg" in
    --use-docker)       USE_DOCKER=1 ;;
    --skip-db)          SKIP_DB=1 ;;
    --skip-npm-install) SKIP_NPM=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

# --- Output helpers ---------------------------------------------------------
c_cyan="\033[36m"; c_green="\033[32m"; c_yellow="\033[33m"; c_gray="\033[90m"; c_off="\033[0m"
step() { printf "\n${c_cyan}==> %s${c_off}\n" "$1"; }
ok()   { printf "  ${c_green}[ok]${c_off} %s\n" "$1"; }
info() { printf "  ${c_gray}%s${c_off}\n" "$1"; }
warn() { printf "  ${c_yellow}[warn]${c_off} %s\n" "$1"; }

have() { command -v "$1" >/dev/null 2>&1; }

# --- Detect OS / package manager -------------------------------------------
OS="$(uname -s)"
PKG=""
if [ "$OS" = "Darwin" ]; then
  PKG="brew"
elif have apt-get; then
  PKG="apt"
elif have dnf; then
  PKG="dnf"
fi

SUDO=""
if [ "$(id -u)" -ne 0 ] && have sudo; then SUDO="sudo"; fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
step "Farmhouse route-optimization — local setup"
info "Project root: ${PROJECT_ROOT}"
info "Detected OS: ${OS}; package manager: ${PKG:-none}"

pkg_install() {
  # pkg_install <brew-formula> <apt-package> <dnf-package> <friendly-name>
  local brew_f="$1" apt_p="$2" dnf_p="$3" name="$4"
  case "$PKG" in
    brew)
      if ! have brew; then
        warn "Homebrew not found. Install it from https://brew.sh then re-run."
        return 1
      fi
      info "Installing ${name} via Homebrew..."; brew install "$brew_f" ;;
    apt)
      info "Installing ${name} via apt-get..."
      $SUDO apt-get update -y && $SUDO apt-get install -y "$apt_p" ;;
    dnf)
      info "Installing ${name} via dnf..."; $SUDO dnf install -y "$dnf_p" ;;
    *)
      warn "No supported package manager found; install ${name} manually."; return 1 ;;
  esac
}

# --- 1. Node.js -------------------------------------------------------------
step "Checking Node.js (need ${MIN_NODE_MAJOR} or newer)"
need_node=1
if have node; then
  node_ver="$(node --version | sed 's/^v//')"
  node_major="${node_ver%%.*}"
  if [ "$node_major" -ge "$MIN_NODE_MAJOR" ]; then
    ok "Node.js ${node_ver} is installed."; need_node=0
  else
    warn "Node.js ${node_ver} is older than ${MIN_NODE_MAJOR}; installing a newer one."
  fi
else
  info "Node.js not found."
fi

if [ "$need_node" -eq 1 ]; then
  # Homebrew: node@18; apt/dnf ship a "nodejs" package (may be older on old
  # distros — NodeSource is the fallback we point to).
  if [ "$PKG" = "brew" ]; then
    pkg_install "node@18" "" "" "Node.js 18" || true
  elif [ "$PKG" = "apt" ] || [ "$PKG" = "dnf" ]; then
    if ! pkg_install "" "nodejs" "nodejs" "Node.js"; then true; fi
    if have node; then
      nm="$(node --version | sed 's/^v//')"; nm="${nm%%.*}"
      if [ "$nm" -lt "$MIN_NODE_MAJOR" ]; then
        warn "The distro's Node.js is older than ${MIN_NODE_MAJOR}."
        info "Install a current LTS via NodeSource: https://github.com/nodesource/distributions"
      fi
    fi
  else
    warn "Install Node.js ${MIN_NODE_MAJOR}+ manually: https://nodejs.org/en/download"
  fi
  have node && ok "Node.js $(node --version) is now available." || true
fi

# --- 2. PostgreSQL / Docker -------------------------------------------------
if [ "$SKIP_DB" -eq 1 ]; then
  step "Skipping PostgreSQL setup (--skip-db)"
  info "Provide your own DATABASE_URL or PG* variables before 'npm start'."
elif [ "$USE_DOCKER" -eq 1 ]; then
  step "Setting up PostgreSQL via Docker"
  if ! have docker; then
    warn "Docker not found. Install Docker, then re-run with --use-docker."
    info "  https://docs.docker.com/get-docker/"
  else
    if [ "$(docker ps -a --filter "name=^/${PG_CONTAINER_NAME}$" --format '{{.Names}}')" = "$PG_CONTAINER_NAME" ]; then
      info "Container '${PG_CONTAINER_NAME}' exists; starting it."
      docker start "$PG_CONTAINER_NAME" >/dev/null
    else
      info "Starting a new PostgreSQL container '${PG_CONTAINER_NAME}'."
      docker run --name "$PG_CONTAINER_NAME" \
        -e "POSTGRES_PASSWORD=${PG_PASSWORD}" \
        -e "POSTGRES_DB=${PG_DATABASE}" \
        -p "${PG_PORT}:5432" -d postgres:16 >/dev/null
    fi
    ok "PostgreSQL container is running on localhost:${PG_PORT}."
  fi
else
  step "Checking PostgreSQL"
  if have psql; then
    ok "PostgreSQL client (psql) is installed."
    info "Ensure the server is running and create the database: createdb ${PG_DATABASE}"
  else
    info "PostgreSQL not found."
    if [ "$PKG" = "brew" ]; then
      pkg_install "postgresql@16" "" "" "PostgreSQL 16" || true
      info "Start it with: brew services start postgresql@16"
    else
      pkg_install "" "postgresql" "postgresql-server" "PostgreSQL" || true
    fi
    info "Then create the app database: createdb ${PG_DATABASE}"
    info "Tip: --use-docker gives a zero-config disposable database instead."
  fi
fi

# --- 3. npm dependencies ----------------------------------------------------
if [ "$SKIP_NPM" -eq 1 ]; then
  step "Skipping 'npm install' (--skip-npm-install)"
elif have npm; then
  step "Installing project dependencies (npm install)"
  ( cd "$PROJECT_ROOT" && npm install ) && ok "Dependencies installed."
else
  warn "npm is not on PATH. Reopen your shell (or fix Node install) and run 'npm install'."
fi

# --- Next steps -------------------------------------------------------------
step "Next steps"
if [ "$USE_DOCKER" -eq 1 ] || [ "$SKIP_DB" -eq 0 ]; then
  info "1. Point the app at the database (this shell):"
  printf "     export DATABASE_URL=\"%s\"\n" "$DATABASE_URL"
else
  info "1. Set DATABASE_URL (or PG* vars) for your database."
fi
info "2. (first run) seed a driver for the driver app:"
printf "     export SEED_DRIVER_USERNAME=\"driver1\"\n"
printf "     export SEED_DRIVER_PASSWORD=\"choose-a-password\"\n"
printf "     npm run db:seed\n"
info "3. Start the server:  npm start"
info "   Dashboard      http://localhost:3000"
info "   Route planner  http://localhost:3000/plan.html"
info "   Driver app     http://localhost:3000/driver.html"
info "Run the tests (no database required):  npm test"
echo
