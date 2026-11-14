#!/bin/bash
# test-scratch-guard.sh — scripts/lib/scratch-guard.sh on real paths. Nothing outside a
# mktemp directory is created or deleted; require_scratch only ever reads.
#
#   ./scripts/test-scratch-guard.sh        EXIT 0 all cases pass · 1 a case failed
cd "$(dirname "$0")/.."
# The MAIN checkout (a worktree of this repo may itself live under /tmp).
REPO=$(cd "$(git rev-parse --git-common-dir)/.." && pwd -P)
fail=0
want() {   # want ok|refused "<label>" [env assignments…] -- path
  local expect="$1" label="$2"; shift 2
  local envs=(); while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
  local lib="$PWD/scripts/lib/scratch-guard.sh"
  if env "${envs[@]}" bash -c 'cd "${CWD:-.}"; source "$0"; require_scratch "$1"' "$lib" "$1" >/dev/null 2>&1
  then got=ok; else got=refused; fi
  if [ "$got" = "$expect" ]; then echo "   ok    $label"; else echo "   FAIL  $label (got $got)"; fail=1; fi
}
T=$(mktemp -d "${TMPDIR:-/tmp}/scratch-guard-test.XXXXXX")
source scripts/lib/scratch-guard.sh; require_scratch "$T"
trap 'rm -rf "$T"' EXIT
ln -s "$HOME" "$T/home-link"

want ok      "a path under /tmp"                          -- /tmp/vlx-x
want ok      "a nonexistent deep path under /tmp"         -- /tmp/vlx-a/b/c
want ok      "a path under \$TMPDIR"                       -- "$T/x"
want refused "/tmp itself"                                -- /tmp
want refused "\$TMPDIR itself"                             -- "${TMPDIR:-/tmp}"
want refused "the repo"                                   -- "$REPO"
want refused "the repo's .env"                            -- "$REPO/.env"
want refused "the home folder"                            -- "$HOME"
want refused "an empty path"                              -- ""
want refused ".. out of /tmp"                             -- /tmp/../Users
want refused "a relative path, run from the main checkout" CWD="$REPO" -- .env
want refused "a symlink in scratch that points home"      -- "$T/home-link/x"
want refused "TMPDIR set inside home"                     TMPDIR="$HOME/Desktop" -- "$HOME/Desktop/x"
want ok      "VLX_SCRATCH, set on purpose, is honoured"   VLX_SCRATCH="$HOME/Desktop" -- "$HOME/Desktop/x"

[ $fail = 0 ] && echo "PASS — all checks" || echo "FAIL"
exit $fail
