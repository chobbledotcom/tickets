#!/usr/bin/env bash
# Asks each service whether it accepts the secrets a workflow holds, before
# the build. scripts/ci/require-env.sh decides which values must be set. This
# script decides whether the set values work. A check with no credential set
# is skipped. The script reports every refusal in one run.
#
#   check-credentials.sh CHECK...
#
#   bunny          BUNNY_ACCESS_KEY, and SCRIPT_ID when it is set
#   main-instance  MAIN_INSTANCE, MAIN_INSTANCE_KEY
#   backup-zone    STORAGE_ZONE_NAME, STORAGE_ZONE_KEY
#   cdn-zone       CDN_BUNNY_STORAGE_HOST, CDN_BUNNY_STORAGE_ZONE_NAME,
#                  CDN_BUNNY_STORAGE_ZONE_KEY
#   site           SITE_URL
#
# No check changes a service, and no message prints a URL or a secret.
# The test at test/scripts/ci/check-credentials.test.ts holds these rules.
set -euo pipefail

BUNNY_API="https://api.bunny.net"
BACKUP_STORAGE_HOST="storage.bunnycdn.com"
# A path that no zone holds. Bunny answers 401 to a wrong key before it
# looks for the path, so the check reads no stored file.
ZONE_PROBE_PATH=".credential-check/"
# A tier that no site has. The main instance checks the key first, then
# refuses the tier with 400, so the check receives no site credentials.
MAIN_INSTANCE_PROBE_TIER="credential-check"

problems=()

# Prints the HTTP status of a request, or 000 when no answer arrives.
status_of() {
  curl --silent --output /dev/null --write-out '%{http_code}' \
    --max-time 20 --retry 2 "$@" || true
}

accept() { echo "ok: $1"; }
refuse() { problems+=("$1"); }
skip() { echo "skipped: $1 is not set"; }

check_bunny() {
  [ -n "${BUNNY_ACCESS_KEY:-}" ] || { skip BUNNY_ACCESS_KEY; return; }
  local path="/compute/script?page=1&perPage=1"
  [ -z "${SCRIPT_ID:-}" ] || path="/compute/script/$SCRIPT_ID"
  case "$(status_of -H "AccessKey: $BUNNY_ACCESS_KEY" "$BUNNY_API$path")" in
    200) accept "Bunny accepts BUNNY_ACCESS_KEY${SCRIPT_ID:+ and has the script}" ;;
    401) refuse "Bunny refused BUNNY_ACCESS_KEY." ;;
    404) refuse "Bunny has no edge script with the script id of this run." ;;
    *) refuse "Bunny did not confirm BUNNY_ACCESS_KEY." ;;
  esac
}

check_main_instance() {
  if [ -z "${MAIN_INSTANCE:-}" ] && [ -z "${MAIN_INSTANCE_KEY:-}" ]; then
    skip MAIN_INSTANCE_KEY
    return
  fi
  local url="${MAIN_INSTANCE%/}/instance/site-credentials?tier=$MAIN_INSTANCE_PROBE_TIER"
  case "$(status_of -X POST -H "Authorization: Bearer $MAIN_INSTANCE_KEY" "$url")" in
    200 | 400) accept "the main instance accepts MAIN_INSTANCE_KEY" ;;
    401) refuse "The main instance refused MAIN_INSTANCE_KEY." ;;
    404) refuse "MAIN_INSTANCE has no credentials endpoint. The main instance must have MAIN_INSTANCE_KEY set." ;;
    *) refuse "The main instance at MAIN_INSTANCE did not confirm MAIN_INSTANCE_KEY." ;;
  esac
}

# check_zone LABEL HOST ZONE_NAME KEY_NAME
check_zone() {
  local label="$1" host="$2" zone="${!3:-}" key="${!4:-}"
  if [ -z "$zone" ] && [ -z "$key" ]; then
    skip "$4"
    return
  fi
  case "$(status_of -H "AccessKey: $key" "https://$host/$zone/$ZONE_PROBE_PATH")" in
    200 | 404) accept "the $label storage zone accepts $4" ;;
    401 | 403) refuse "The $label storage zone refused $4, or $3 names another zone." ;;
    *) refuse "The $label storage zone did not confirm $4." ;;
  esac
}

check_site() {
  local url="${SITE_URL:-}" body
  url="${url//[[:space:]]/}"
  [ -n "$url" ] || { skip SITE_URL; return; }
  body=$(curl --silent --max-time 20 --retry 2 "${url%/}/health" || true)
  if [ "$body" = "Up :)" ]; then
    accept "the site answers at its URL"
  else
    refuse "The site URL of this run does not answer as a tickets site. The update wait polls this URL."
  fi
}

for check in "$@"; do
  case "$check" in
    bunny) check_bunny ;;
    main-instance) check_main_instance ;;
    backup-zone)
      check_zone backup "$BACKUP_STORAGE_HOST" STORAGE_ZONE_NAME STORAGE_ZONE_KEY
      ;;
    cdn-zone)
      check_zone CDN "${CDN_BUNNY_STORAGE_HOST:-}" \
        CDN_BUNNY_STORAGE_ZONE_NAME CDN_BUNNY_STORAGE_ZONE_KEY
      ;;
    site) check_site ;;
    *)
      echo "Unknown check: $check" >&2
      exit 2
      ;;
  esac
done

if [ "${#problems[@]}" -gt 0 ]; then
  printf '::error::%s\n' "${problems[@]}" >&2
  exit 1
fi
