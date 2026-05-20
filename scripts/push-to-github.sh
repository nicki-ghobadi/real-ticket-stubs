#!/usr/bin/env bash
# Create GitHub repo "real-ticket-stubs" and push (run from project root).
set -euo pipefail
cd "$(dirname "$0")/.."

REPO_NAME="${1:-real-ticket-stubs}"
VISIBILITY="${2:-public}"

if ! command -v gh >/dev/null 2>&1; then
  echo "Install GitHub CLI: https://cli.github.com/"
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "Run: gh auth login"
  exit 1
fi

USER=$(gh api user -q .login)
echo "GitHub user: $USER"

if [ ! -d .git ]; then
  git init -b main
fi

git add -A
if ! git diff --cached --quiet 2>/dev/null; then
  git commit -m "$(cat <<'EOF'
Initial commit: Real Ticket Stubs.

Screenshot-to-Ticketmaster stub generator with OCR/AI extract,
address validation, and checkout. See TODO.md for production tasks.
EOF
)" || true
fi

if gh repo view "$USER/$REPO_NAME" >/dev/null 2>&1; then
  echo "Remote repo exists: https://github.com/$USER/$REPO_NAME"
  git remote remove origin 2>/dev/null || true
  git remote add origin "https://github.com/$USER/$REPO_NAME.git"
else
  gh repo create "$REPO_NAME" --source=. --remote=origin --"$VISIBILITY" \
    --description "Real Ticket Stubs — screenshot to print-ready Ticketmaster thermal stub"
fi

git push -u origin main
echo "Done: https://github.com/$USER/$REPO_NAME"
