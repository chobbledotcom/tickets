# Security Audit Report

**System:** Ticket Reservation System
**Date:** 2026-01-22
**Auditor:** Claude (Automated Security Review)
**Previous Audit:** 2026-01-22 (initial review - most issues now resolved)

---

## Executive Summary

This security audit of the ticket reservation system found a **well-secured codebase** with proper implementation of security controls. Many issues from the initial audit have been resolved. The system uses modern cryptographic practices, parameterized queries, CSRF protection, and proper session management.

| Severity | Count | Status |
|----------|-------|--------|
| Critical | 0 | None found |
| High | 1 | Needs attention |
| Medium | 4 | Recommended fixes |
| Low | 4 | Hardening recommendations |

**Previous audit status:** 13 of 16 original findings have been remediated.

---

## Previously Identified Issues - NOW RESOLVED

The following critical issues from the initial audit have been fixed:

| # | Original Finding | Status | Implementation |
|---|------------------|--------|----------------|
| 1 | Plaintext password storage | **FIXED** | scrypt hashing + AES-256-GCM encryption (`crypto.ts:199-216`) |
| 2 | Insecure session tokens | **FIXED** | `crypto.getRandomValues()` with 256-bit tokens (`crypto.ts:35-42`) |
| 3 | IDOR in payment flow | **FIXED** | Stripe session metadata verification (`webhooks.ts:85-91`) |
| 4 | Missing CSRF protection | **FIXED** | Double-submit cookie pattern with constant-time comparison (`admin.ts:170-172`) |
| 5 | Missing cookie security | **FIXED** | HttpOnly, Secure, SameSite=Strict (`admin.ts:96`) |
| 6 | No rate limiting | **FIXED** | 5 attempts / 15-min lockout for login (`db.ts:484-560`) |
| 8 | Timing attack vulnerability | **FIXED** | Constant-time comparison for passwords and CSRF (`crypto.ts:18-29`) |
| 9 | Missing security headers | **FIXED** | X-Frame-Options, CSP, X-Content-Type-Options, Referrer-Policy (`middleware.ts:8-30`) |
| 10 | Weak email validation | **FIXED** | Regex validation added (`fields.ts:39-46`) |
| 11 | Missing price validation | **FIXED** | Non-negative validation (`fields.ts:28-34`) |
| 13 | Info disclosure in errors | **FIXED** | Generic "Invalid credentials" message (`admin.ts:83`) |
| 14 | No account lockout | **FIXED** | IP-based lockout implemented (`db.ts:484-560`) |
| 15 | Sessions not invalidated | **FIXED** | All sessions cleared on password change (`db.ts:231`) |

---

## Current Findings

### HIGH SEVERITY

#### 1. Error Message Information Disclosure in Edge Script

**Location:** `src/edge/bunny-script.ts:36-42`

**Issue:** The edge script error handler exposes full error messages to clients:

```typescript
return new Response(
  JSON.stringify({
    error: "Internal server error",
    message: String(error),  // ← Exposes implementation details
  }),
  { status: 500, headers: { "content-type": "application/json" } },
);
```

**Risk:** Error messages may leak implementation details, file paths, database structure, or stack traces that could aid attackers.

**Recommendation:** Log detailed errors server-side and return generic messages to clients:

```typescript
console.error("[Tickets] Request error:", error);
return new Response(
  JSON.stringify({ error: "Internal server error" }),
  { status: 500, headers: { "content-type": "application/json" } },
);
```

---

### MEDIUM SEVERITY

#### 2. Potential Open Redirect via thank_you_url

**Location:** `src/routes/public.ts:110`

**Issue:** After ticket reservation, users are redirected to `event.thank_you_url` without re-validation:

```typescript
return redirect(event.thank_you_url);
```

While URLs are validated on event creation (`fields.ts:10-23`), risk exists if:
- The database is compromised
- The encryption key is leaked
- A future code change bypasses validation

**Risk:** Open redirect vulnerabilities can facilitate phishing attacks.

**Recommendation:** Re-validate URLs before redirect or implement an allowlist.

#### 3. Environment Variables Not Validated on Startup

**Location:** `src/index.ts:9-17`, `src/lib/db.ts:21-33`

**Issue:** Only `DB_ENCRYPTION_KEY` is validated at startup. `DB_URL` and `DB_TOKEN` validation is deferred until first database access.

**Risk:** Server starts successfully but fails on first request if credentials are missing.

**Recommendation:** Validate all required environment variables at startup.

#### 4. No Encryption Key Rotation Mechanism

**Location:** `src/lib/crypto.ts`

**Issue:** No mechanism exists for rotating `DB_ENCRYPTION_KEY`. If compromised, all historical encrypted data is exposed.

**Recommendation:** Implement versioned encryption format supporting key rotation.

#### 5. Missing Rate Limiting on Public Ticket Endpoint

**Location:** `src/routes/public.ts:75-111`

**Issue:** The `/ticket/:id` POST endpoint has no rate limiting (login is properly rate-limited).

**Risk:** Reservation spam, event ID enumeration, database load.

**Recommendation:** Implement IP-based rate limiting (e.g., 10 reservations per IP per hour).

---

### LOW SEVERITY

#### 6. Lenient Email Validation

**Location:** `src/templates/fields.ts:39-46`

```typescript
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
```

**Issue:** The regex allows some technically invalid formats (e.g., `test@.com`).

**Impact:** Minimal - data quality issue rather than security risk.

#### 7. Missing Domain Attribute on Session Cookies

**Location:** `src/routes/admin.ts:96, 110, 198`

**Issue:** No explicit `Domain` attribute set. In subdomain deployments, cookies may be accessible to sibling subdomains.

**Impact:** Low for dedicated domain deployments; higher in subdomain scenarios.

#### 8. Encryption Key Cached Indefinitely

**Location:** `src/lib/crypto.ts:53-87`

**Issue:** The encryption key is cached without TTL. Memory dumps could expose the cached key.

**Recommendation:** For high-security environments, consider periodic cache clearing.

#### 9. No Session IP Binding

**Location:** `src/routes/utils.ts:54-70`

**Issue:** Sessions validated by token only, not bound to originating IP.

**Impact:** Stolen session cookies (unlikely due to HttpOnly) can be used from any IP.

---

## Security Controls - Properly Implemented

### Cryptography
- **AES-256-GCM encryption** via @noble/ciphers (audited library) - `crypto.ts:119-120`
- **12-byte random nonces** for GCM mode - `crypto.ts:112`
- **256-bit key enforcement** - `crypto.ts:77-80`
- **scrypt password hashing** (N=16384, r=8, p=1, dkLen=32) - `crypto.ts:199-216`
- **Constant-time comparison** for passwords and CSRF - `crypto.ts:18-29, 265-270`

### SQL Injection Prevention
All queries use parameterized statements:
```typescript
await getDb().execute({
  sql: "SELECT * FROM events WHERE id = ?",
  args: [id],
});
```
**No SQL injection vulnerabilities found** - reviewed all 25+ queries in `db.ts`.

### CSRF Protection
- Double-submit cookie pattern - `setup.ts:126-172`, `admin.ts:170-172`
- Constant-time token comparison
- 256-bit cryptographically secure tokens

### Session Security
- `HttpOnly` - prevents JavaScript access
- `Secure` - HTTPS-only transmission
- `SameSite=Strict` - prevents CSRF from third-party sites
- `Path=/admin/` - scoped to admin routes
- 24-hour expiration
- Password change invalidates all sessions - `db.ts:231`

### CORS Protection
- Origin/Referer validation on POST requests - `middleware.ts:42-71`
- Content-Type validation - `middleware.ts:77-84`
- Requests without valid origin rejected

### Rate Limiting (Login)
- 5 failed attempts trigger 15-minute lockout - `db.ts:484-486`
- Attempts cleared on successful login - `admin.ts:87`
- IP-based tracking

### Security Headers
- `X-Frame-Options: DENY` - `middleware.ts:27`
- `Content-Security-Policy: frame-ancestors 'none'` - `middleware.ts:28`
- `X-Content-Type-Options: nosniff` - `middleware.ts:9`
- `Referrer-Policy: strict-origin-when-cross-origin` - `middleware.ts:10`

### Data Protection (Encryption at Rest)
- Attendee PII (name, email) - `db.ts:364-365`
- Admin password hash - `db.ts:172`
- Stripe secret key - `db.ts:175-176`
- Payment IDs - `db.ts:366-368`

### IDOR Protection
- Payment success callback verifies Stripe session metadata - `webhooks.ts:85-91`
- Replay attack prevention via existing payment ID check - `webhooks.ts:93-97`

### Input Validation
- URL validation (https://, http://, relative paths) - `fields.ts:10-23`
- Price non-negative validation - `fields.ts:28-34`
- Password minimum length (8 chars) - `admin.ts:145-150`, `setup.ts:57-61`
- Form validation framework - `forms.tsx`

---

## Recommendations Summary

| Priority | Finding | Action |
|----------|---------|--------|
| **High** | Error disclosure in edge script | Sanitize error messages before client response |
| **Medium** | Open redirect risk | Re-validate thank_you_url before redirect |
| **Medium** | Startup validation | Validate all env vars at startup |
| **Medium** | Key rotation | Document and implement rotation procedure |
| **Medium** | Public endpoint rate limiting | Add reservation throttling |
| **Low** | Email validation | Consider stricter regex (optional) |
| **Low** | Cookie Domain attribute | Set explicit domain or document requirements |
| **Low** | Key caching | Consider cache TTL for high-security deployments |
| **Low** | Session IP binding | Consider optional IP validation for admin sessions |

---

## Files Reviewed

| File | Security Relevance |
|------|-------------------|
| `src/lib/crypto.ts` | Encryption, hashing, token generation |
| `src/lib/db.ts` | Database queries, data storage, rate limiting |
| `src/routes/admin.ts` | Authentication, session management |
| `src/routes/middleware.ts` | Security headers, CORS |
| `src/routes/utils.ts` | Session validation, CSRF |
| `src/routes/webhooks.ts` | Payment callbacks, IDOR protection |
| `src/routes/public.ts` | Ticket reservation, redirects |
| `src/routes/setup.ts` | Initial setup, CSRF |
| `src/templates/fields.ts` | Input validation definitions |
| `src/edge/bunny-script.ts` | Edge deployment entry point |

---

## Conclusion

The ticket reservation system demonstrates **strong security practices**. The development team has addressed the critical and high-severity findings from the initial audit, implementing:

- Proper cryptographic primitives (AES-256-GCM, scrypt)
- Comprehensive session security
- CSRF protection with constant-time comparison
- Rate limiting on authentication
- Input validation and parameterized queries
- Security headers

**Current status:** Production-ready with minor improvements recommended.

**Immediate action required:** Fix error message disclosure in edge script (`bunny-script.ts:39`).

**Before production deployment:**
1. Fix high-severity error disclosure issue
2. Validate all required environment variables at startup
3. Document key rotation procedures
