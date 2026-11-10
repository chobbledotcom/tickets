#!/usr/bin/env bash
# Stops a workflow before the build when a value that the run needs is not
# set. The script reports every problem in one run, not only the first.
#
#   require-env.sh NAME...                each NAME must be set
#   --if NAME A,B                         when NAME is set, A and B must be set
#   --unless NAME A,B                     when NAME is not set, A and B must be set
#   --together A,B,C                      set all of the group, or none of it
#
# A blank value counts as not set, because a missing secret reads as "".
# The test at test/scripts/ci/require-env.test.ts holds these rules.
set -euo pipefail

is_set() {
  local value="${!1:-}"
  [ -n "${value//[[:space:]]/}" ]
}

problems=()

require() {
  local reason="$1" name
  shift
  for name in "$@"; do
    is_set "$name" || problems+=("$name is not set$reason.")
  done
}

require_together() {
  local name set_names=() unset_names=()
  for name in "$@"; do
    if is_set "$name"; then set_names+=("$name"); else unset_names+=("$name"); fi
  done
  if [ "${#set_names[@]}" -gt 0 ] && [ "${#unset_names[@]}" -gt 0 ]; then
    problems+=("Set all of $* or none of them. Not set: ${unset_names[*]}.")
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --if | --unless)
      [ $# -ge 3 ] || { echo "$1 needs a name and a list" >&2; exit 2; }
      IFS=',' read -r -a names <<<"$3"
      if [ "$1" = "--if" ] && is_set "$2"; then
        require ", and $2 needs it" "${names[@]}"
      elif [ "$1" = "--unless" ] && ! is_set "$2"; then
        require ", and a run with no $2 needs it" "${names[@]}"
      fi
      shift 3
      ;;
    --together)
      [ $# -ge 2 ] || { echo "--together needs a list" >&2; exit 2; }
      IFS=',' read -r -a names <<<"$2"
      require_together "${names[@]}"
      shift 2
      ;;
    --*)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
    *)
      require "" "$1"
      shift
      ;;
  esac
done

if [ "${#problems[@]}" -gt 0 ]; then
  printf '::error::%s\n' "${problems[@]}" >&2
  exit 1
fi
echo "Every value that this run needs is set."
