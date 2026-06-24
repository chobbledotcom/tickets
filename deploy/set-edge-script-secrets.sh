#!/usr/bin/env nix-shell
#!nix-shell -i bash -p curl jq openssl

# Script to manage secrets for Bunny CDN edge scripts (tickets-*)
# Uses .env file for API key and some secret values

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
print_skip() { echo -e "  ${DIM}○${NC} $1"; }
print_step() { echo -e "${YELLOW}▶${NC} $1"; }

# Load environment variables
if [[ ! -f "$ENV_FILE" ]]; then
    print_header "Configuration Error"
    print_error ".env file not found at $ENV_FILE"
    echo ""
    echo "  Please create a .env file with:"
    echo -e "    ${CYAN}BUNNY_API_KEY=your_api_key${NC}"
    echo -e "    ${CYAN}ADMIN_EMAIL_ADDRESS=...${NC}"
    echo -e "    ${CYAN}WEBHOOK_URL=...${NC}"
    echo -e "    ${CYAN}STORAGE_ZONE_NAME=...${NC}"
    echo -e "    ${CYAN}STORAGE_ZONE_KEY=...${NC}"
    echo -e "    ${CYAN}HOST_EMAIL_PROVIDER=...${NC}"
    echo -e "    ${CYAN}HOST_EMAIL_API_KEY=...${NC}"
    echo -e "    ${CYAN}HOST_EMAIL_FROM_ADDRESS=...${NC}"
    echo -e "    ${CYAN}APPLE_WALLET_PASS_TYPE_ID=...${NC}"
    echo -e "    ${CYAN}APPLE_WALLET_TEAM_ID=...${NC}"
    echo -e "    ${CYAN}APPLE_WALLET_SIGNING_CERT=\$(cat ./deploy/certs/signing-cert.pem)${NC}"
    echo -e "    ${CYAN}APPLE_WALLET_SIGNING_KEY=\$(cat ./deploy/certs/signing-key.pem)${NC}"
    echo -e "    ${CYAN}APPLE_WALLET_WWDR_CERT=\$(cat ./deploy/certs/wwdr-cert.pem)${NC}"
    echo -e "    ${CYAN}GOOGLE_WALLET_ISSUER_ID=...${NC}"
    echo -e "    ${CYAN}GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL=...${NC}"
    echo -e "    ${CYAN}GOOGLE_WALLET_SERVICE_ACCOUNT_KEY=\$(cat ./deploy/certs/google-key.pem)${NC}"
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

print_header "Bunny Edge Script Secrets Manager"

# Accept script IDs as argument or prompt interactively
if [[ -n "${1:-}" ]]; then
    SCRIPT_IDS_INPUT="$1"
else
    echo -e -n "  ${CYAN}→${NC} Enter edge script ID(s) separated by ${BOLD}|${NC}: "
    read -r SCRIPT_IDS_INPUT
fi

# Validate all script IDs
IFS='|' read -ra SCRIPT_ID_LIST <<< "$SCRIPT_IDS_INPUT"
for sid in "${SCRIPT_ID_LIST[@]}"; do
    if ! [[ "$sid" =~ ^[0-9]+$ ]]; then
        print_error "Invalid script ID: $sid"
        exit 1
    fi
done

echo -e "  ${DIM}Will process ${#SCRIPT_ID_LIST[@]} script(s): ${SCRIPT_IDS_INPUT}${NC}"

# Global totals
total_success=0
total_skip=0
total_fail=0

for SCRIPT_ID in "${SCRIPT_ID_LIST[@]}"; do

# Fetch existing secrets for this script
print_header "Script ${SCRIPT_ID} — Checking Existing Secrets"

echo -e "  Edge Script ID: ${BOLD}${CYAN}$SCRIPT_ID${NC}"
echo ""

print_step "Fetching existing secrets..."

response=$(curl -s -w "\n%{http_code}" -X GET \
    "${API_BASE}/compute/script/${SCRIPT_ID}/secrets" \
    -H "AccessKey: ${BUNNY_API_KEY}" \
    -H "Accept: application/json")

http_code=$(echo "$response" | tail -n1)
secrets_body=$(echo "$response" | sed '$d')

if [[ "$http_code" -lt 200 || "$http_code" -ge 300 ]]; then
    print_error "Failed to fetch secrets (HTTP $http_code)"
    echo "$secrets_body"
    exit 1
fi

# Build a list of existing secret names
existing_secrets=$(echo "$secrets_body" | jq -r '.Secrets[].Name // empty')

secret_exists() {
    echo "$existing_secrets" | grep -qx "$1"
}

# Function to set a secret via API
set_secret() {
    local name="$1"
    local value="$2"

    local payload
    payload=$(jq -n --arg n "$name" --arg s "$value" '{Name: $n, Secret: $s}')

    local response
    response=$(curl -s -w "\n%{http_code}" -X PUT \
        "${API_BASE}/compute/script/${SCRIPT_ID}/secrets" \
        -H "AccessKey: ${BUNNY_API_KEY}" \
        -H "Content-Type: application/json" \
        -H "Accept: application/json" \
        -d "$payload")

    local http_code
    http_code=$(echo "$response" | tail -n1)

    if [[ "$http_code" -ge 200 && "$http_code" -lt 300 ]]; then
        print_success "${BOLD}$name${NC} set"
        return 0
    else
        local resp_body
        resp_body=$(echo "$response" | sed '$d')
        print_error "${BOLD}$name${NC} failed (HTTP $http_code)"
        echo -e "      ${RED}$resp_body${NC}"
        return 1
    fi
}

# Counters (per script)
success_count=0
skip_count=0
fail_count=0

# Helper: set secret from .env variable (by name)
set_from_env() {
    local name="$1"
    local value="${!name:-}"

    if secret_exists "$name"; then
        print_skip "${BOLD}$name${NC} already exists, skipping"
        skip_count=$((skip_count + 1))
    elif [[ -z "$value" ]]; then
        print_error "${BOLD}$name${NC} not found in .env, skipping"
        fail_count=$((fail_count + 1))
    else
        print_info "Using ${BOLD}$name${NC} from .env"
        if set_secret "$name" "$value"; then
            success_count=$((success_count + 1))
        else
            fail_count=$((fail_count + 1))
        fi
    fi
}

# Helper: set secret by prompting the user
set_from_prompt() {
    local name="$1"

    if secret_exists "$name"; then
        print_skip "${BOLD}$name${NC} already exists, skipping"
        skip_count=$((skip_count + 1))
    else
        echo -e -n "  ${CYAN}→${NC} Enter ${BOLD}$name${NC}: "
        read -r value
        if [[ -z "$value" ]]; then
            print_error "$name cannot be empty, skipping"
            fail_count=$((fail_count + 1))
        elif set_secret "$name" "$value"; then
            success_count=$((success_count + 1))
        else
            fail_count=$((fail_count + 1))
        fi
    fi
}

# Process each secret
print_header "Script ${SCRIPT_ID} — Setting Secrets"

echo -e "  ${DIM}Existing secrets will be skipped (not overwritten).${NC}"
echo ""

# Prompted secrets
set_from_prompt "DB_URL"
set_from_prompt "DB_TOKEN"

# Auto-generated secrets
if secret_exists "DB_ENCRYPTION_KEY"; then
    print_skip "${BOLD}DB_ENCRYPTION_KEY${NC} already exists, skipping"
    skip_count=$((skip_count + 1))
else
    encryption_key=$(openssl rand -base64 32)
    print_info "Generated ${BOLD}DB_ENCRYPTION_KEY${NC}: ${DIM}$encryption_key${NC}"
    if set_secret "DB_ENCRYPTION_KEY" "$encryption_key"; then
        success_count=$((success_count + 1))
    else
        fail_count=$((fail_count + 1))
    fi
fi

# Script's own ID
if secret_exists "BUNNY_SCRIPT_ID"; then
    print_skip "${BOLD}BUNNY_SCRIPT_ID${NC} already exists, skipping"
    skip_count=$((skip_count + 1))
else
    print_info "Setting ${BOLD}BUNNY_SCRIPT_ID${NC} to ${DIM}$SCRIPT_ID${NC}"
    if set_secret "BUNNY_SCRIPT_ID" "$SCRIPT_ID"; then
        success_count=$((success_count + 1))
    else
        fail_count=$((fail_count + 1))
    fi
fi

# Secrets from .env
set_from_env "NTFY_URL"
set_from_env "SENTRY_URL"
set_from_env "ADMIN_EMAIL_ADDRESS"
set_from_env "WEBHOOK_URL"
set_from_env "STORAGE_ZONE_NAME"
set_from_env "STORAGE_ZONE_KEY"
set_from_env "HOST_EMAIL_PROVIDER"
set_from_env "HOST_EMAIL_API_KEY"
set_from_env "HOST_EMAIL_FROM_ADDRESS"
set_from_env "BUNNY_API_KEY"
set_from_env "BUNNY_DNS_ZONE_ID"
set_from_env "BUNNY_DNS_SUBDOMAIN_SUFFIX"

# Apple Wallet secrets (all from .env - certs use $(cat ...) in .env)
set_from_env "APPLE_WALLET_PASS_TYPE_ID"
set_from_env "APPLE_WALLET_TEAM_ID"
set_from_env "APPLE_WALLET_SIGNING_CERT"
set_from_env "APPLE_WALLET_SIGNING_KEY"
set_from_env "APPLE_WALLET_WWDR_CERT"

# Google Wallet secrets (key uses $(cat ...) in .env)
set_from_env "GOOGLE_WALLET_ISSUER_ID"
set_from_env "GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL"
set_from_env "GOOGLE_WALLET_SERVICE_ACCOUNT_KEY"

# Per-script summary
print_header "Script ${SCRIPT_ID} — Summary"

echo -e "  Edge Script ID: ${BOLD}${CYAN}$SCRIPT_ID${NC}"
echo ""

if [[ $success_count -gt 0 ]]; then
    echo -e "  ${GREEN}✓${NC} $success_count secret(s) set"
fi
if [[ $skip_count -gt 0 ]]; then
    echo -e "  ${DIM}○${NC} $skip_count secret(s) already existed (skipped)"
fi
if [[ $fail_count -gt 0 ]]; then
    echo -e "  ${RED}✗${NC} $fail_count secret(s) failed"
fi

total_success=$((total_success + success_count))
total_skip=$((total_skip + skip_count))
total_fail=$((total_fail + fail_count))

done # end loop over SCRIPT_ID_LIST

# Overall summary (only if multiple scripts)
if [[ ${#SCRIPT_ID_LIST[@]} -gt 1 ]]; then
    print_header "Overall Summary (${#SCRIPT_ID_LIST[@]} scripts)"

    if [[ $total_success -gt 0 ]]; then
        echo -e "  ${GREEN}✓${NC} $total_success secret(s) set"
    fi
    if [[ $total_skip -gt 0 ]]; then
        echo -e "  ${DIM}○${NC} $total_skip secret(s) already existed (skipped)"
    fi
    if [[ $total_fail -gt 0 ]]; then
        echo -e "  ${RED}✗${NC} $total_fail secret(s) failed"
    fi
fi

echo ""
