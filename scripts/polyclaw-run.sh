#!/usr/bin/env bash
# # Basic prompt
# ./scripts/polyclaw-run.sh "What did we work on today?"

# # Skip approvals and memory (fastest)
# ./scripts/polyclaw-run.sh --auto-approve --skip-memory "quick question"

# # Quiet mode (no streaming, just the answer)
# ./scripts/polyclaw-run.sh -q "summarize my tasks"

# # From a file
# ./scripts/polyclaw-run.sh --file tasks.md

# # From stdin
# echo "list open PRs" | ./scripts/polyclaw-run.sh -

# # Override model
# ./scripts/polyclaw-run.sh --model gpt-4.1 "list skills you has access to"



# polyclaw-run.sh — run a single prompt through the Polyclaw CLI agent and exit.
#
# Usage:
#   ./scripts/polyclaw-run.sh "your prompt"
#   ./scripts/polyclaw-run.sh --auto-approve "your prompt"
#   ./scripts/polyclaw-run.sh --quiet --skip-memory "quick question"
#   ./scripts/polyclaw-run.sh --file tasks.md
#   echo "list open PRs" | ./scripts/polyclaw-run.sh -
#
# All flags are passed directly to app/cli/run.py:
#   --auto-approve     skip tool approval prompts
#   --skip-memory      skip memory post-processing
#   --quiet / -q       no streaming, just the final response
#   --model <name>     override the model
#   --file <path>      read prompt from a file
#   -                  read prompt from stdin
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="$REPO_ROOT/.venv"
ENV_FILE="$REPO_ROOT/.env"

export PYTHONPATH="$REPO_ROOT"
export DOTENV_PATH="$ENV_FILE"

if [[ -f "$VENV/bin/activate" ]]; then
    source "$VENV/bin/activate"
fi

cd "$REPO_ROOT"
exec python -m app.cli.run "$@"
