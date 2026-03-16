# Security Audit Report

**Date:** 2026-03-16
**Scope:** Full codebase security review of the ticket reservation platform
**Methodology:** Static analysis of all source files across authentication, encryption, input validation, authorization, HTTP security, payment processing, and external integrations

---

## Executive Summary

This platform demonstrates a **strong security posture** with mature, defense-in-depth practices throughout. The codebase uses modern cryptographic primitives (AES-256-GCM, RSA-OAEP, PBKDF2), proper input validation, parameterized queries, automatic HTML escaping, signed CSRF tokens, and webhook signature verification.

**No critical vulnerabilities were found.** Several moderate-risk areas are identified below as recommendations for further hardening.

---

## Findings Overview

| Category | Status | Severity |
|----------|--------|----------|
| SQL Injection | Secure | — |
| XSS / HTML Injection | Secure | — |
| CSRF Protection | Secure | — |
| Authentication & Sessions | Secure | — |
| Authorization & Access Control | Secure | — |
| Encryption at Rest | Secure | — |
| Password Hashing | Secure | — |
| Payment Webhook Verification | Secure | — |
| Payment Amount Validation | Secure | — |
| Race Condition / Idempotency | Secure | — |
| File Upload Handling | Secure | — |
| HTTP Security Headers | Secure | — |
| Cookie Security | Secure | — |
| Path Traversal | Secure | — |
| Command Injection | Secure | — |
| ReDoS | Secure | — |
| Open Redirect | Secure | — |
| Webhook URL SSRF | Recommendation | Medium |
| Login Rate Limiting Scope | Recommendation | Medium |
| HSTS Header | Recommendation | Low |
| Webhook Delivery Timeout | Recommendation | Low |
| Image Route Regex | Recommendation | Low |

---

## Detailed Analysis

### 1. SQL Injection — SECURE

All database operations use **parameterized queries** with `?` placeholders via the libsql client. No string concatenation of user input into SQL was found.

- `queryOne()`, `queryAll()`, `executeBatch()` all accept `args: InValue[]` — `src/lib/db/client.ts`
- Table/column names in template literals (e.g., `executeByField`) are hardcoded constants, never user input
- `inPlaceholders()` generates `?, ?, ?` strings from array length, not from values — `src/lib/db/client.ts:116`
- Atomic attendee creation uses parameterized subqueries for capacity checks — `src/lib/db/attendees.ts:487-515`

### 2. XSS / HTML Injection — SECURE

The custom JSX runtime provides **automatic HTML escaping by default**.

- `renderChild()` calls `escapeHtml()` on all string/number children — `src/lib/jsx/jsx-runtime.ts:114`
- `renderAttr()` escapes all attribute values — `src/lib/jsx/jsx-runtime.ts:117-121`
- `SafeHtml` class is the only way to bypass escaping, and is used only for pre-built HTML from trusted sources (layout doctype, form framework output)
- `escapeHtml()` covers `&`, `<`, `>`, `"` — the four critical HTML metacharacters — `src/lib/jsx/jsx-runtime.ts:78-83`
- Markdown rendering explicitly escapes raw HTML tags via a custom `html()` renderer — `src/lib/markdown.ts:11`
- Email templates use LiquidJS with AST-based parsing (no `eval`/`Function`) — `src/lib/email-renderer.ts`
- CSP `script-src 'self'` provides an additional layer of protection — `src/routes/middleware.ts:29`

### 3. CSRF Protection — SECURE

All state-changing operations use **signed CSRF tokens** with HMAC-SHA256.

- Token format: `s1.<timestamp>.<nonce>.<hmac>` — `src/lib/csrf.ts`
- 1-hour expiry with 60-second clock skew tolerance
- Nonce is 32 bytes of cryptographic randomness
- Verification uses constant-time comparison via `constantTimeEqual()` — `src/lib/crypto.ts:15-26`
- Works in iframe contexts where third-party cookies are blocked (iOS Safari)
- Applied to all POST routes: `withAuthForm()`, `withCsrfForm()`, `withAuthJson()` — `src/routes/utils.ts`
- JSON API endpoints accept CSRF via `x-csrf-token` header — `src/routes/utils.ts:636`

### 4. Authentication & Session Management — SECURE

Session management follows security best practices throughout.

**Token Generation:**
- 32 bytes (256 bits) from `crypto.getRandomValues()` — `src/lib/crypto.ts:74`
- Tokens hashed with SHA-256 before database storage — `src/lib/crypto.ts:435`
- Database stores only the hash; cookie contains the raw token

**Cookie Attributes:**
- `__Host-` prefix in production (requires Secure + Path=/) — `src/lib/cookies.ts:10`
- `HttpOnly` prevents JavaScript access
- `SameSite=Strict` prevents cross-site transmission
- `Secure` flag in production (HTTPS only)
- 24-hour `Max-Age` — `src/lib/cookies.ts:3`

**Session Lifecycle:**
- Expired sessions are deleted on access — `src/routes/utils.ts:117-121`
- User existence verified on every session check — `src/routes/utils.ts:124-133`
- Admin role decrypted from DB each request (role changes take immediate effect)
- Session invalidated if user deleted
- 10-second in-memory cache with TTL reduces DB queries — `src/lib/db/sessions.ts:16`

**Login Security:**
- Random 100-200ms delay on all login attempts prevents timing attacks — `src/routes/admin/auth.ts:42-45`
- Rate limiting: 5 failures per IP triggers 15-minute lockout — `src/lib/db/login-attempts.ts:12-13`
- IP addresses HMAC-hashed before storage (privacy protection) — `src/lib/db/login-attempts.ts:22`
- Identical error messages for invalid username vs invalid password

### 5. Authorization & Access Control — SECURE

Two-tier role-based access control properly enforced.

**Route Protection:**

| Protection Level | Helper | Routes |
|-----------------|--------|--------|
| Session required | `requireSessionOr()` | `/admin/events/*`, `/admin/attendees/*`, `/admin/calendar`, `/admin/holidays/*` |
| Owner only | `requireOwnerOr()` | `/admin/users/*`, `/admin/sessions`, `/admin/settings/*`, `/admin/debug`, `/admin/groups/*` |
| Owner + CSRF | `withOwnerAuthForm()` | All owner POST operations |
| Any auth + CSRF | `withAuthForm()` | All standard POST operations |

**No IDOR Vulnerabilities:**
- Attendee access validates `attendee.event_id === eventId` — `src/routes/admin/attendees.ts`
- Ticket tokens are 32-byte random values (256-bit entropy), not guessable IDs
- Event lookup by slug uses HMAC blind index, not plaintext — `src/lib/db/events.ts`

**Setup Flow:**
- `isSetupComplete()` checked on both GET and POST — `src/routes/setup.ts:93,108`
- Cannot be re-triggered once complete
- All non-setup routes redirect to `/setup` until setup completes — `src/routes/index.ts:240-242`

**Demo Mode:**
- `/demo/reset` only accessible when `DEMO_MODE=true` — `src/routes/admin/database-reset.ts:27`
- Protected by CSRF and confirmation phrase
- Returns 404 when not in demo mode

### 6. Encryption at Rest — SECURE

Multi-layered encryption architecture protects data at rest.

**Symmetric Encryption (AES-256-GCM):**
- 12-byte random IV per encryption operation — `src/lib/crypto.ts:199`
- Format: `enc:1:<base64-iv>:<base64-ciphertext>`
- Used for: settings, admin_level, price_paid, and other DB fields

**Hybrid Encryption (RSA-OAEP + AES-GCM):**
- RSA-2048 key pair generated during setup — `src/lib/crypto.ts:655`
- Public key encrypts attendee PII (no auth needed for registration)
- Private key decrypts PII (requires authenticated session)
- Format: `hyb:1:<wrapped-key>:<iv>:<ciphertext>` — `src/lib/crypto.ts:711`
- 60-second TTL cache for decrypted PII — `src/lib/crypto.ts:745-751`

**Key Hierarchy:**
```
DB_ENCRYPTION_KEY (32 bytes, from environment)
  → KEK (derived via PBKDF2 from password hash + DB_ENCRYPTION_KEY)
    → DATA_KEY (wrapped with KEK, stored on user record)
      → Private Key (wrapped with DATA_KEY)
        → Attendee PII (encrypted with public key, decrypted with private key)
```

**Key Validation:**
- `validateEncryptionKey()` enforces exactly 32 bytes on startup — `src/lib/crypto.ts:190`
- `clearEncryptionKeyCache()` clears all derived key caches — `src/lib/crypto.ts:320`

**Images:**
- Encrypted with AES-256-GCM before upload to Bunny CDN — `src/lib/storage.ts:147`
- Decrypted on-the-fly when served via `/image/:filename` — `src/lib/storage.ts:202`

### 7. Password Hashing — SECURE

- Algorithm: PBKDF2-SHA256 — `src/lib/crypto.ts:382`
- Iterations: 600,000 (meets OWASP 2023 minimum for SHA-256) — `src/lib/crypto.ts:331`
- Salt: 16 random bytes per password — `src/lib/crypto.ts:382`
- Hash length: 32 bytes (256 bits)
- Format: `pbkdf2:<iterations>:<base64-salt>:<base64-hash>`
- Verification uses constant-time byte comparison — `src/lib/crypto.ts:346-352`
- Minimum password length: 8 characters — `src/routes/setup.ts:62`

### 8. Payment Webhook Verification — SECURE

Both Stripe and Square webhooks are cryptographically verified before processing.

**Stripe** — `src/lib/stripe.ts`:
- HMAC-SHA256 with webhook secret
- Timestamp tolerance: 5 minutes (replay protection)
- Multiple signature support (key rotation)
- Constant-time comparison

**Square** — `src/lib/square.ts`:
- HMAC-SHA256 over `notification_url + raw_body`
- URL included in signature prevents cross-endpoint forgery
- Constant-time comparison
- Uses public-facing domain for verification URL (handles CDN TLS termination)

**Both:**
- Raw body bytes captured before any async work — `src/routes/webhooks.ts:904`
- Missing signature returns 400 immediately — `src/routes/webhooks.ts:908-913`
- `_origin` metadata check ensures webhook belongs to this instance — `src/routes/webhooks.ts:996`

### 9. Payment Amount Validation — SECURE

- Exact match required for standard events: `amountTotal === unit_price * quantity`
- Range check for pay-more events: `expectedPrice <= amountTotal <= max_price`
- Multi-ticket purchases validate per-item prices against current event prices — `src/routes/webhooks.ts:494-501`
- Cart total cross-checked against sum of item prices — `src/routes/webhooks.ts:505-515`
- **Automatic refund** triggered on any price mismatch — `src/routes/webhooks.ts:427-437`
- Capacity checked post-payment with auto-refund if exceeded

### 10. Race Condition / Idempotency — SECURE

Two-phase locking prevents duplicate attendee creation from concurrent webhook + redirect.

- Phase 1: `reserveSession()` — INSERT with UNIQUE constraint; first writer wins — `src/lib/db/processed-payments.ts`
- Phase 2: Create attendee atomically (SQL INSERT...WHERE capacity check) — `src/lib/db/attendees.ts:487`
- Phase 3: `finalizeSession()` — UPDATE sets attendee_id
- Concurrent requests get 409 conflict or idempotent success
- Stale reservations (>5 min) are cleaned up automatically
- Multi-ticket purchases use all-or-nothing semantics with rollback — `src/routes/webhooks.ts:561-569`

### 11. File Upload Handling — SECURE

Three-layer validation for image uploads:

1. **MIME type whitelist:** JPEG, PNG, GIF, WebP only — `src/lib/storage.ts:17-22`
2. **Size limit:** 256KB maximum — `src/lib/storage.ts:14`
3. **Magic bytes verification:** File header bytes checked against known signatures — `src/lib/storage.ts:57-64`

Additional protections:
- Random UUID filenames prevent path traversal — `src/lib/storage.ts:123`
- Images encrypted before CDN upload — `src/lib/storage.ts:147`
- Served via `/image/` proxy with strict regex: `[a-f0-9-]+\.\w+` — `src/routes/images.ts:39`

### 12. HTTP Security Headers — SECURE

All responses go through `applySecurityHeaders()` — `src/routes/middleware.ts:234`.

| Header | Value | Notes |
|--------|-------|-------|
| `content-security-policy` | `default-src 'self'; script-src 'self' [payment-domains]; frame-ancestors 'none'` | Dynamic frame-ancestors for embeddable pages |
| `x-frame-options` | `DENY` | Omitted on embeddable ticket pages |
| `x-content-type-options` | `nosniff` | All responses |
| `referrer-policy` | `strict-origin-when-cross-origin` | All responses |
| `x-robots-tag` | `noindex, nofollow` | Overridden to `index, follow` for embeddable pages |
| `cache-control` | `private, no-store` | Dynamic responses; static assets use `public, max-age=31536000, immutable` |

**Content-Type validation:**
- POST requests to form endpoints require `application/x-www-form-urlencoded` or `multipart/form-data`
- POST requests to webhook/API endpoints require `application/json`
- Invalid Content-Type returns 400 — `src/routes/middleware.ts:144-160`

**Domain validation:**
- Host header checked against `ALLOWED_DOMAIN` — `src/routes/middleware.ts:85-97`
- Hostname normalized (strip port, lowercase, strip trailing dot)
- Mismatched domains receive 301 redirect to allowed domain
- Client IP uses `server.requestIP()` directly (not `X-Forwarded-For`) — `src/routes/utils.ts:56`

### 13. Additional Secure Patterns

- **No `eval()`, `new Function()`, `exec()`, or `spawn()`** anywhere in the codebase
- **No prototype pollution vectors**: JSON.parse results are validated before use
- **No ReDoS risk**: All regex patterns are simple character classes with no nested quantifiers
- **No open redirects**: `redirect()` constructs URLs with `new URL(target, "http://localhost")` and returns only `pathname + search + hash` — `src/routes/utils.ts:249-255`
- **Error responses** never expose stack traces, internal paths, or variable names — `src/lib/logger.ts`
- **Ntfy notifications** contain only domain and error code, never PII — `src/lib/ntfy.ts:28-29`

---

## Recommendations

### R1: SSRF Prevention for Webhook URLs (Medium)

**Location:** `src/lib/webhook.ts`, `src/routes/admin/events.ts`

Webhook URLs are admin-configured (not user-controlled), which limits risk. However, a compromised admin account could target internal services.

**Recommendation:** Add URL validation when saving webhook URLs:
- Reject `localhost`, `127.0.0.1`, `::1`, and private IP ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`)
- Reject link-local addresses (`169.254.0.0/16`, cloud metadata endpoints)
- Require HTTPS in production
- Add a fetch timeout (e.g., 10 seconds) to prevent hanging connections

### R2: Per-Username Rate Limiting (Medium)

**Location:** `src/lib/db/login-attempts.ts`

Current rate limiting is per-IP only (5 attempts, 15-minute lockout). A distributed attacker using multiple IPs could brute-force a single username without triggering lockouts.

**Recommendation:**
- Add per-username rate limiting (track failed attempts by HMAC of username)
- Implement exponential backoff on repeated lockout cycles (15min → 30min → 1hr)
- Consider account lockout notification via admin activity log

### R3: HSTS Header (Low)

**Location:** `src/routes/middleware.ts`

No `Strict-Transport-Security` header is set in application code. This is likely handled by Bunny Edge CDN at the infrastructure level.

**Recommendation:** Verify HSTS is configured in the Bunny CDN dashboard for the production domain. If not, add `strict-transport-security: max-age=63072000; includeSubDomains` to `BASE_SECURITY_HEADERS`.

### R4: Webhook Delivery Timeout (Low)

**Location:** `src/lib/webhook.ts`

The `fetch()` call for outgoing webhook delivery has no explicit timeout. A slow/unresponsive webhook endpoint could hold resources.

**Recommendation:** Add `AbortController` with a 10-second timeout:
```typescript
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 10_000);
try {
  await fetch(url, { ...opts, signal: controller.signal });
} finally {
  clearTimeout(timeoutId);
}
```

### R5: Image Route Regex Tightening (Low)

**Location:** `src/routes/images.ts:39`

Current pattern `/^\/image\/([a-f0-9-]+\.\w+)$/` allows any `\w+` extension. Since only 4 image types are supported, the regex could be tightened.

**Recommendation:** Change to `/^\/image\/([a-f0-9-]+\.(jpg|png|gif|webp))$/` for defense-in-depth. The existing MIME type check in `getMimeTypeFromFilename()` already rejects unknown extensions, so this is a minor hardening.

---

## Secure Architecture Summary

The platform's security architecture is well-designed:

1. **Defense in depth**: Multiple validation layers (middleware → router → handler → database)
2. **Encryption by default**: All PII encrypted at rest with hybrid RSA+AES scheme
3. **Least privilege**: Role-based access control with owner/manager distinction
4. **Fail secure**: Errors return generic messages; expired sessions are deleted; payment mismatches trigger refunds
5. **Constant-time operations**: All sensitive comparisons (passwords, CSRF, webhooks) use timing-safe functions
6. **Modern crypto**: Web Crypto API throughout; no deprecated algorithms (MD5, SHA-1, DES)
7. **No raw SQL**: 100% parameterized queries via libsql client
8. **Auto-escaping HTML**: JSX runtime escapes by default; `SafeHtml` requires explicit opt-in
