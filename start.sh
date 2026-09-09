#!/usr/bin/env bash
#
# Start both servers the reader uses:
#
#   - the static file server for the page itself   (http://localhost:8000)
#   - the optional parsing sidecar, Docling        (http://127.0.0.1:8077)
#
# Ctrl-C stops both. Override the ports with PORT / SIDECAR_PORT.
#
#   ./start.sh              both servers
#   ./start.sh --no-sidecar just the page (the reader falls back to its own parser)
#
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
port="${PORT:-8000}"
sidecar_port="${SIDECAR_PORT:-8077}"
want_sidecar=1

for arg in "$@"; do
  case "$arg" in
    --no-sidecar) want_sidecar=0 ;;
    -h|--help) sed -n '3,12p' "${BASH_SOURCE[0]}" | cut -c3-; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

pids=()

cleanup() {
  trap - INT TERM EXIT
  for pid in "${pids[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null
  done
  # Give them a moment to shut down cleanly. The sidecar can be mid-way through
  # loading the Docling weights, which it will not abandon instantly.
  for _ in $(seq 1 10); do
    still=0
    for pid in "${pids[@]:-}"; do
      [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && still=1
    done
    [ "$still" = 0 ] && break
    sleep 0.5
  done
  for pid in "${pids[@]:-}"; do
    [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null
  done
  wait 2>/dev/null
  if [ "${#pids[@]}" -gt 0 ]; then
    echo
    echo "stopped."
  fi
}
trap cleanup INT TERM EXIT

# Refuse to start on a port something else already holds, rather than letting
# one server die silently and look like a bug in the reader.
in_use() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN
  elif command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else
    return 1
  fi
}

# Prefix a server's output so two streams in one terminal stay readable.
prefix() { sed -u "s/^/[$1] /"; }

if in_use "$port"; then
  echo "port $port is already in use — set PORT to something else" >&2
  exit 1
fi

if [ "$want_sidecar" = 1 ]; then
  venv_python="$root/sidecar/.venv/bin/python"
  if [ ! -x "$venv_python" ]; then
    echo "no sidecar venv at sidecar/.venv — see sidecar/README.md for setup." >&2
    echo "starting the page server only; the reader will use its built-in parser." >&2
    want_sidecar=0
  elif in_use "$sidecar_port"; then
    echo "port $sidecar_port is already in use — assuming the sidecar is running." >&2
    want_sidecar=0
  fi
fi

if [ "$want_sidecar" = 1 ]; then
  # First run downloads the Docling weights (a few hundred MB), so this can sit
  # quiet for a while before it says "ready".
  ( cd "$root/sidecar" && exec "$venv_python" -m uvicorn server:app \
      --host 127.0.0.1 --port "$sidecar_port" --log-level info ) \
      > >(prefix sidecar) 2>&1 &
  pids+=("$!")
  echo "sidecar   http://127.0.0.1:$sidecar_port"
fi

( cd "$root" && exec python3 -m http.server "$port" --bind 127.0.0.1 ) \
    > >(prefix page) 2>&1 &
pids+=("$!")
echo "reader    http://localhost:$port"
echo
echo "Ctrl-C to stop."

wait
