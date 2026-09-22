#!/usr/bin/env bash
# Instala deps Python (uma vez) e corre o diagnóstico deposit wallet.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v python3 >/dev/null; then
  echo "python3 não encontrado. No VPS: apt-get install -y python3 python3-venv"
  exit 1
fi

if ! python3 -m venv --help >/dev/null 2>&1; then
  echo "python3-venv em falta. No VPS: apt install -y python3-venv"
  exit 1
fi

VENV="$ROOT/.venv-test"
REQ="$ROOT/scripts/requirements-test.txt"

venv_ok() {
  [ -x "$VENV/bin/python" ] && [ -x "$VENV/bin/pip" ] &&
    "$VENV/bin/python" -c "import py_clob_client_v2" 2>/dev/null
}

if ! venv_ok; then
  if [ -d "$VENV" ]; then
    echo "Venv incompleto ou sem deps — a recriar $VENV ..."
    rm -rf "$VENV"
  else
    echo "A criar venv em $VENV ..."
  fi
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q --upgrade pip
  "$VENV/bin/pip" install -q -r "$REQ"
fi

export CLOB_HOST="${CLOB_HOST:-https://clob.polymarket.com}"
exec "$VENV/bin/python" "$ROOT/scripts/test-deposit-wallet.py" "$@"

