#!/usr/bin/env bash
# polyclaw.sh — start / stop / restart / status the polyclaw server
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$REPO_ROOT/.polyclaw.pid"
LOG_FILE="$REPO_ROOT/.polyclaw.log"
VENV="$REPO_ROOT/.venv/bin/python"
ENV_FILE="$REPO_ROOT/.env"

export PYTHONPATH="$REPO_ROOT"
export DOTENV_PATH="$ENV_FILE"

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

_is_running() {
    [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

_read_secret() {
    grep -m1 '^ADMIN_SECRET=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"'
}

_read_port() {
    grep -m1 '^ADMIN_PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"'
}

# ---------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------

cmd_start() {
    if _is_running; then
        echo "polyclaw is already running (PID $(cat "$PID_FILE"))"
        return 0
    fi

    echo "Starting polyclaw..."
    nohup "$VENV" -m app.runtime.server.app \
        >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"

    # wait up to 15 s for health endpoint
    local port secret tries=0
    port="$(_read_port)"
    port="${port:-9090}"

    echo -n "Waiting for server"
    while (( tries < 30 )); do
        sleep 1
        echo -n "."
        if curl -sf "http://localhost:${port}/health" > /dev/null 2>&1; then
            echo " ready"
            secret="$(_read_secret)"
            echo ""
            echo "  PID     : $(cat "$PID_FILE")"
            echo "  Log     : $LOG_FILE"
            echo "  Health  : http://localhost:${port}/health"
            if [[ -n "$secret" ]]; then
                echo "  Admin UI: http://localhost:${port}/?secret=${secret}"
            else
                echo "  Admin UI: http://localhost:${port}/"
            fi
            return 0
        fi
        tries=$(( tries + 1 ))
    done

    echo " timed out"
    echo "Check logs: $LOG_FILE"
    return 1
}

cmd_stop() {
    if ! _is_running; then
        echo "polyclaw is not running"
        [[ -f "$PID_FILE" ]] && rm -f "$PID_FILE"
        return 0
    fi

    local pid
    pid="$(cat "$PID_FILE")"
    echo "Stopping polyclaw (PID $pid)..."
    kill "$pid"

    local tries=0
    while (( tries < 10 )); do
        sleep 1
        kill -0 "$pid" 2>/dev/null || break
        tries=$(( tries + 1 ))
    done

    if kill -0 "$pid" 2>/dev/null; then
        echo "Process did not stop cleanly — sending SIGKILL"
        kill -9 "$pid" 2>/dev/null || true
    fi

    rm -f "$PID_FILE"
    echo "Stopped"
}

cmd_restart() {
    cmd_stop
    sleep 1
    cmd_start
}

cmd_status() {
    local port secret
    port="$(_read_port)"; port="${port:-9090}"
    secret="$(_read_secret)"

    if _is_running; then
        local health
        health="$(curl -sf "http://localhost:${port}/health" 2>/dev/null || echo 'unreachable')"
        echo "polyclaw is RUNNING (PID $(cat "$PID_FILE"))"
        echo "  Health  : $health"
        echo "  Log     : $LOG_FILE"
        if [[ -n "$secret" ]]; then
            echo "  Admin UI: http://localhost:${port}/?secret=${secret}"
        else
            echo "  Admin UI: http://localhost:${port}/"
        fi
    else
        echo "polyclaw is STOPPED"
        rm -f "$PID_FILE"
    fi
}

cmd_logs() {
    if [[ ! -f "$LOG_FILE" ]]; then
        echo "No log file found at $LOG_FILE"
        return 1
    fi
    tail -f "$LOG_FILE"
}

# ---------------------------------------------------------------------------
# dispatch
# ---------------------------------------------------------------------------

usage() {
    echo "Usage: $(basename "$0") {start|stop|restart|status|logs}"
    exit 1
}

case "${1:-}" in
    start)   cmd_start   ;;
    stop)    cmd_stop    ;;
    restart) cmd_restart ;;
    status)  cmd_status  ;;
    logs)    cmd_logs    ;;
    *)       usage       ;;
esac
