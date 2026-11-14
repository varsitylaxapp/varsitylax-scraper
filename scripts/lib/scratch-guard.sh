# scripts/lib/scratch-guard.sh: sourced by every script that deletes files.
#
#   require_scratch PATH   exit 1 unless PATH is strictly INSIDE a scratch directory
#
# Scratch is $VLX_SCRATCH if set, else $TMPDIR or /tmp, with symlinks resolved. Anything
# under $HOME is refused unless it is under $VLX_SCRATCH. PATH need not exist yet.
#
# WHY: 2026-11-13 a helper whose cleanup ran `rm -f "$W/.env"` was given the main
# checkout as W and deleted its .env. A delete is only safe where nothing lives but
# what the script itself made.

_scratch_resolve() {                     # absolute, symlink-free; nonexistent tail kept
  local p="$1" tail=""
  case "$p" in /*) ;; *) p="$PWD/$p";; esac
  case "/$p/" in */../*|*/./*) return 1;; esac
  while [ ! -d "$p" ]; do
    tail="/$(basename "$p")$tail"; p=$(dirname "$p")
  done
  printf '%s%s\n' "$(cd "$p" && pwd -P)" "$tail"
}

require_scratch() {
  local target root r home
  [ -n "${1:-}" ] || { echo "REFUSED: empty path given to require_scratch" >&2; exit 1; }
  target=$(_scratch_resolve "$1") || { echo "REFUSED: $1 has . or .. in it" >&2; exit 1; }
  home=$(cd "$HOME" && pwd -P)
  for root in "${VLX_SCRATCH:-}" "${TMPDIR:-}" /tmp; do
    [ -n "$root" ] && [ -d "$root" ] || continue
    r=$(cd "$root" && pwd -P)
    case "$target" in
      "$r"/?*)
        if [ "$root" != "${VLX_SCRATCH:-}" ]; then
          case "$target/" in "$home"/*) continue;; esac
        fi
        return 0;;
    esac
  done
  echo "REFUSED: $1 is not inside a scratch directory (\$VLX_SCRATCH, \$TMPDIR or /tmp)." >&2
  echo "         This script deletes it, so it runs only on paths it may delete." >&2
  exit 1
}
