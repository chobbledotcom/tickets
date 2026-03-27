#!/usr/bin/env nix-shell
#!nix-shell -i bash -p curl jq gh

# Script to create a new Bunny CDN edge script (tickets-*)
# Fetches latest release code from GitHub, creates the script, then sets secrets

set -euo pipefail

# Colors for nice output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"

# Pretty print functions
print_header() {
    echo ""
    echo -e "${BOLD}${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BOLD}${BLUE}  $1${NC}"
    echo -e "${BOLD}${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

print_success() { echo -e "  ${GREEN}✓${NC} $1"; }
print_error() { echo -e "  ${RED}✗${NC} $1"; }
print_info() { echo -e "  ${CYAN}→${NC} $1"; }
print_step() { echo -e "${YELLOW}▶${NC} $1"; }

# Load environment variables
if [[ ! -f "$ENV_FILE" ]]; then
    print_header "Configuration Error"
    print_error ".env file not found at $ENV_FILE"
    echo ""
    echo "  Please create a .env file with at least:"
    echo -e "    ${CYAN}BUNNY_API_KEY=your_api_key${NC}"
    echo ""
    exit 1
fi

source "$ENV_FILE"

if [[ -z "${BUNNY_API_KEY:-}" ]]; then
    print_header "Configuration Error"
    print_error "BUNNY_API_KEY not set in .env"
    exit 1
fi

API_BASE="https://api.bunny.net"

print_header "Create New Bunny Edge Script"

# Prompt for script name
echo -e -n "  ${CYAN}→${NC} Enter script name (will be prefixed with ${BOLD}Tickets - ${NC}): "
read -r SCRIPT_NAME_INPUT

if [[ -z "$SCRIPT_NAME_INPUT" ]]; then
    print_error "Script name cannot be empty"
    exit 1
fi

FULL_NAME="Tickets - ${SCRIPT_NAME_INPUT}"
print_info "Full name: ${BOLD}${FULL_NAME}${NC}"
echo ""

# Fetch latest release from GitHub
print_step "Fetching latest release from GitHub..."

LATEST_RELEASE=$(curl -s "https://api.github.com/repos/chobbledotcom/tickets/releases/latest")
TAG_NAME=$(echo "$LATEST_RELEASE" | jq -r '.tag_name')

if [[ -z "$TAG_NAME" || "$TAG_NAME" == "null" ]]; then
    print_error "Could not determine latest release"
    echo "$LATEST_RELEASE" | jq .
    exit 1
fi

print_info "Latest release: ${BOLD}${TAG_NAME}${NC}"

# Download bunny-script.ts
DOWNLOAD_URL="https://github.com/chobbledotcom/tickets/releases/download/${TAG_NAME}/bunny-script.ts"
print_step "Downloading bunny-script.ts..."

SCRIPT_CODE_FILE=$(mktemp)
trap 'rm -f "$SCRIPT_CODE_FILE" "$PAYLOAD_FILE"' EXIT

curl -sL "$DOWNLOAD_URL" -o "$SCRIPT_CODE_FILE"

if [[ ! -s "$SCRIPT_CODE_FILE" ]]; then
    print_error "Failed to download bunny-script.ts from ${DOWNLOAD_URL}"
    exit 1
fi

LINE_COUNT=$(wc -l < "$SCRIPT_CODE_FILE")
print_success "Downloaded bunny-script.ts (${LINE_COUNT} lines)"
echo ""

# Create the edge script via Bunny API
print_step "Creating edge script..."

PAYLOAD_FILE=$(mktemp)
jq -n \
    --arg name "$FULL_NAME" \
    --rawfile code "$SCRIPT_CODE_FILE" \
    '{
        Name: $name,
        Code: $code,
        ScriptType: 1,
        CreateLinkedPullZone: true
    }' > "$PAYLOAD_FILE"

CREATE_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
    "${API_BASE}/compute/script" \
    -H "AccessKey: ${BUNNY_API_KEY}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json" \
    -d @"$PAYLOAD_FILE")

HTTP_CODE=$(echo "$CREATE_RESPONSE" | tail -n1)
RESPONSE_BODY=$(echo "$CREATE_RESPONSE" | sed '$d')

if [[ "$HTTP_CODE" -lt 200 || "$HTTP_CODE" -ge 300 ]]; then
    print_error "Failed to create edge script (HTTP $HTTP_CODE)"
    echo "$RESPONSE_BODY" | jq . 2>/dev/null || echo "$RESPONSE_BODY"
    exit 1
fi

NEW_SCRIPT_ID=$(echo "$RESPONSE_BODY" | jq -r '.Id')
DEFAULT_HOSTNAME=$(echo "$RESPONSE_BODY" | jq -r '.DefaultHostname // empty')

print_success "Edge script created!"
print_info "Script ID: ${BOLD}${NEW_SCRIPT_ID}${NC}"
if [[ -n "$DEFAULT_HOSTNAME" ]]; then
    print_info "Default hostname: ${BOLD}${DEFAULT_HOSTNAME}${NC}"
fi
echo ""

# Set secrets on the new script
print_header "Setting Secrets on New Script"

"${SCRIPT_DIR}/set-edge-script-secrets.sh" "$NEW_SCRIPT_ID"

# Final summary
print_header "All Done!"

echo -e "  Script name:  ${BOLD}${FULL_NAME}${NC}"
echo -e "  Script ID:    ${BOLD}${CYAN}${NEW_SCRIPT_ID}${NC}"
if [[ -n "$DEFAULT_HOSTNAME" ]]; then
    echo -e "  Hostname:     ${BOLD}${DEFAULT_HOSTNAME}${NC}"
fi
echo ""
echo -e "  ${BOLD}Logs:${NC}  https://dash.bunny.net/scripts/${NEW_SCRIPT_ID}/logs"
echo ""
