# Security Audit Report

**Date:** 2026-01-24
**Updated:** 2026-01-24 (post-fix)
**Auditor:** Claude Security Audit
**Application:** Ticket Reservation System
**Scope:** Full codebase review

---

## Executive Summary

The ticket reservation system demonstrates **strong security architecture** with multiple layers of defense-in-depth. The codebase follows security best practices for authentication, cryptography, session management, and input validation.

**Overall Risk Level:** LOW

### Recent Fixes Applied
- ✅ **Stripe webhook signature verification** - Implemented HMAC-SHA256 verification using Web Crypto API
- ✅ **Payment idempotency** - Added `processed_payments` table to prevent duplicate attendee creation
- ✅ **Webhook endpoint** - Added `/payment/webhook` for Stripe event handling with signature verification

---

## Positive Security Findings

### 1. Cryptography (Excellent)

| Aspect | Implementation | Status |
|--------|----------------|--------|
| Password Hashing | PBKDF2-SHA256, 600,000 iterations (OWASP recommended) | ✅ |
| Key Derivation | Two-factor KEK (password hash + DB_ENCRYPTION_KEY) | ✅ |
| Session Tokens | SHA-256 hashed before storage (prevents DB access attacks) | ✅ |
| PII Encryption | RSA-2048-OAEP hybrid encryption with AES-256-GCM | ✅ |
| Random Generation | Web Crypto API `getRandomValues()` | ✅ |
| Constant-time Comparison | Used for password and token verification | ✅ |
| Key Wrapping | AES-GCM key wrapping with session-bound access | ✅ |

**Location:** `src/lib/crypto.ts`

### 2. Authentication & Session Management (Strong)

- **Session cookies** use `__Host-` prefix with `HttpOnly`, `Secure`, `SameSite=Strict`
- **Session tokens** are 256-bit random values
- **CSRF protection** via double-submit cookie pattern AND session-bound tokens
- **Rate limiting** on login: 5 attempts → 15-minute lockout per IP
- **Session expiration** after 24 hours
- **Password change** invalidates all sessions and re-wraps encryption keys

**Location:** `src/routes/admin/auth.ts`, `src/lib/db/sessions.ts`

### 3. Input Validation (Good)

- Form validation framework with type checking
- URL validation prevents `javascript:` scheme injection
- Slug validation restricts to alphanumeric and hyphens
- Email validation with regex
- HTML escaping in JSX runtime by default
- Content-Type validation on POST requests

**Location:** `src/lib/forms.tsx`, `src/templates/fields.ts`

### 4. Security Headers (Good)

```http
X-Content-Type-Options: nosniff
X-Frame-Options: DENY (non-embeddable pages)
Referrer-Policy: strict-origin-when-cross-origin
Content-Security-Policy: default-src 'self'; frame-ancestors 'none'; form-action 'self'
```

**Location:** `src/routes/middleware.ts`

### 5. SQL Injection Prevention (Good)

- Parameterized queries used throughout
- LibSQL client with prepared statements
- No string concatenation in SQL queries

**Location:** `src/lib/db/*.ts`

### 6. Payment Security (Strong)

- Stripe handles payment processing (PCI-DSS compliant)
- Atomic attendee creation with capacity check
- Automatic refunds on capacity exceeded after payment
- Payment intent stored in Stripe session metadata (not client-side)
- **Webhook signature verification** using HMAC-SHA256 (Web Crypto API)
- **Idempotency** via `processed_payments` table prevents duplicate attendees
- Dual handler architecture: redirect AND webhook for reliability

**Location:** `src/lib/stripe.ts`, `src/routes/webhooks.ts`, `src/lib/db/processed-payments.ts`

---

## Security Concerns & Recommendations

### CRITICAL: None Identified

### HIGH SEVERITY

#### ~~1. Missing Stripe Webhook Signature Verification~~ ✅ RESOLVED

**Status:** Fixed in this commit

**Implementation:**
- Added `POST /payment/webhook` endpoint for Stripe events
- Implemented HMAC-SHA256 signature verification using Web Crypto API (Bunny Edge compatible)
- Added `processed_payments` table for idempotency
- Both redirect and webhook handlers now use shared `processPaymentSession()` logic
- Duplicate payment processing is prevented via session ID tracking

**New Files:**
- `src/lib/db/processed-payments.ts` - Idempotency tracking
- `src/lib/stripe.ts` - Added `verifyWebhookSignature()` function

**New Environment Variable:**
- `STRIPE_WEBHOOK_SECRET` - Required for webhook signature verification

---

### MEDIUM SEVERITY

#### 2. Rate Limiting Bypass via Distributed Attack (Low Risk)

**File:** `src/lib/db/login-attempts.ts`

**Issue:** Rate limiting is per-IP only. A distributed attack from multiple IPs could bypass the 5-attempt limit.

**Mitigating Factors:**
- Single admin account with enforced long, random password
- PBKDF2 with 600,000 iterations makes brute force computationally expensive
- With a sufficiently long password (16+ random characters), distributed attacks are impractical

**Status:** Acceptable risk for single-user admin with strong password policy. Account-based rate limiting would add complexity without meaningful security benefit when password is cryptographically strong.

**Recommendation (if needed):**
- Only relevant if password policy is relaxed or multiple admin accounts are added

#### 3. Webhook URL SSRF Risk

**File:** `src/lib/webhook.ts`, `src/templates/fields.ts`

**Issue:** Admins can configure arbitrary webhook URLs. The `validateSafeUrl` function allows `http://` URLs and doesn't validate against internal networks.

**Code:**
```typescript
// src/lib/webhook.ts:44
await fetch(webhookUrl, { ... });
```

**Risk:** An admin could configure a webhook URL pointing to internal services (e.g., `http://localhost:8080`, `http://169.254.169.254/latest/meta-data/`).

**Recommendation:**
- Validate webhook URLs against a blocklist of private IP ranges
- Consider requiring HTTPS for webhooks
- Implement URL resolution check before request

#### 4. Session Cache Timing Window

**File:** `src/lib/db/sessions.ts`

**Issue:** Session cache has a 10-second TTL. After logout, a cached session could remain valid for up to 10 seconds.

```typescript
const SESSION_CACHE_TTL_MS = 10_000;
```

**Recommendation:**
- Explicitly invalidate cache on logout (already done)
- Consider reducing TTL for security-critical applications
- Document this behavior in security considerations

#### 5. Debug Logging in Production

**File:** `src/routes/setup.ts`

**Issue:** Setup route contains extensive `console.log` statements that may leak sensitive information in production logs:

```typescript
console.log("[Setup] Cookie CSRF token present:", !!cookieCsrf, "length:", cookieCsrf.length);
console.log("[Setup] Form values received:", { hasPassword: !!values.admin_password, ... });
```

**Recommendation:**
- Remove or gate debug logs behind a `DEBUG` environment variable
- Never log CSRF token lengths or presence indicators

---

### LOW SEVERITY

#### 6. Information Disclosure in Error Messages

**Files:** Various route handlers

**Issue:** Some error messages reveal internal state:
- "Encryption key not configured. Please complete setup."
- "Invalid wrapped key format"

**Recommendation:**
- Use generic error messages for users
- Log detailed errors server-side only

#### 7. Constant-Time Comparison Length Leak

**File:** `src/lib/crypto.ts:13-15`

**Issue:** The `constantTimeEqual` function returns early if lengths differ:

```typescript
if (a.length !== b.length) {
  return false;
}
```

This reveals length information through timing. For most use cases this is acceptable, but for high-security comparisons, consider fixed-length tokens or padding.

**Recommendation:**
- For critical comparisons, ensure compared values are always the same length
- Current implementation is acceptable for session tokens (fixed 32 bytes)

#### 8. CSV Export Filename Injection

**File:** `src/routes/admin/events.ts:159`

```typescript
const filename = `${event.name.replace(/[^a-zA-Z0-9]/g, "_")}_attendees.csv`;
```

**Issue:** While special characters are replaced, extremely long event names could cause issues.

**Recommendation:**
- Truncate filename to reasonable length (e.g., 50 chars)

#### 9. Missing Security Headers for Downloads

**File:** `src/routes/admin/events.ts:160-165`

**Issue:** CSV export response doesn't include security headers.

**Recommendation:**
- Apply `applySecurityHeaders()` to CSV responses
- Add `X-Content-Type-Options: nosniff` to prevent MIME sniffing

#### 10. Embeddable Path Regex

**File:** `src/routes/middleware.ts:55-56`

```typescript
export const isEmbeddablePath = (path: string): boolean =>
  /^\/ticket\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(path);
```

**Issue:** This regex requires strict lowercase slugs, but the routing may accept paths case-insensitively. Verify consistency.

---

## Authentication Flow Security Analysis

```
┌─────────────────────────────────────────────────────────────────┐
│                     LOGIN FLOW SECURITY                         │
├─────────────────────────────────────────────────────────────────┤
│ 1. Rate Limit Check (per-IP) ───────────────────────────► [OK]  │
│ 2. Password Hash Verification (PBKDF2) ─────────────────► [OK]  │
│ 3. Generate Session Token (256-bit random) ─────────────► [OK]  │
│ 4. Hash Token Before Storage (SHA-256) ─────────────────► [OK]  │
│ 5. Derive DATA_KEY Access (password + env) ─────────────► [OK]  │
│ 6. Wrap DATA_KEY with Session Token ────────────────────► [OK]  │
│ 7. Set __Host-session Cookie ───────────────────────────► [OK]  │
│    (HttpOnly, Secure, SameSite=Strict)                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Encryption Key Hierarchy

```
                    ┌─────────────────────┐
                    │ DB_ENCRYPTION_KEY   │ (environment variable)
                    │ (256-bit AES key)   │
                    └──────────┬──────────┘
                               │
            ┌──────────────────┴──────────────────┐
            ▼                                     ▼
    ┌───────────────────┐              ┌────────────────────┐
    │   KEK Derivation  │              │ Session Key Salt   │
    │ (PBKDF2 + password│              │ (for wrapping      │
    │  hash as input)   │              │  DATA_KEY)         │
    └─────────┬─────────┘              └────────────────────┘
              │
              ▼
    ┌───────────────────┐
    │    DATA_KEY       │ (random AES-256, wrapped by KEK)
    │  (symmetric key)  │
    └─────────┬─────────┘
              │
              ▼
    ┌───────────────────┐
    │   PRIVATE KEY     │ (RSA-2048, encrypted by DATA_KEY)
    │  (asymmetric)     │
    └─────────┬─────────┘
              │
              ▼
    ┌───────────────────┐
    │   ATTENDEE PII    │ (hybrid encrypted with public key)
    │  (name, email)    │
    └───────────────────┘
```

**Security Properties:**
- DB_ENCRYPTION_KEY alone cannot decrypt PII (needs password too)
- Password alone cannot decrypt PII (needs DB_ENCRYPTION_KEY too)
- Session token alone cannot decrypt PII (needs DB_ENCRYPTION_KEY in salt)
- Database dump alone cannot decrypt PII

---

## OWASP Top 10 Assessment

| Vulnerability | Status | Notes |
|---------------|--------|-------|
| A01:2021 – Broken Access Control | ✅ Protected | Session auth, CSRF, IDOR checks |
| A02:2021 – Cryptographic Failures | ✅ Strong | Modern algorithms, proper key management |
| A03:2021 – Injection | ✅ Protected | Parameterized queries, HTML escaping |
| A04:2021 – Insecure Design | ⚠️ Minor | Webhook SSRF risk (admin-only) |
| A05:2021 – Security Misconfiguration | ✅ Good | Security headers, strict cookies |
| A06:2021 – Vulnerable Components | ✅ N/A | Minimal dependencies |
| A07:2021 – Auth Failures | ✅ Strong | PBKDF2, rate limiting, session security |
| A08:2021 – Software/Data Integrity | ✅ Fixed | Stripe webhook signature verification added |
| A09:2021 – Security Logging | ⚠️ Minor | Debug logging in setup route |
| A10:2021 – SSRF | ⚠️ Low | Webhook URL admin-controlled only |

---

## Recommendations Summary

### ✅ Completed
1. ~~Implement Stripe webhook signature verification~~ - Done
2. ~~Add payment idempotency~~ - Done

### Priority 1 (Short-term)
3. Remove debug logging from setup route
4. Add SSRF protection for webhook URLs (blocklist private IPs)
5. Apply security headers to CSV exports

### Priority 2 (Nice-to-have)
6. Truncate CSV filenames
7. Document session cache TTL behavior

---

## New Environment Variables

After these changes, the following environment variable should be set:

| Variable | Required | Description |
|----------|----------|-------------|
| `STRIPE_WEBHOOK_SECRET` | For webhooks | Stripe webhook signing secret (starts with `whsec_`) |

Configure in Stripe Dashboard → Developers → Webhooks → Add endpoint:
- URL: `https://your-domain.com/payment/webhook`
- Events: `checkout.session.completed`

---

## Conclusion

The application demonstrates mature security practices, particularly in cryptography and authentication. The key hierarchy design is sophisticated and provides strong protection for sensitive data.

With the Stripe webhook signature verification now implemented, the payment flow is fully secured against replay attacks and follows Stripe's recommended integration pattern. The idempotency layer ensures reliable payment processing even with network retries.

**Remaining items are low priority and do not represent meaningful security risk for the intended single-admin deployment with strong password policy.**
