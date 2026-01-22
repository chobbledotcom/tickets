# Security Audit Report

**Date:** 2026-01-22
**Auditor:** Claude
**Application:** Ticket Reservation System

---

## Executive Summary

This security audit identified **16 vulnerabilities** across the ticket reservation system. The most critical issues relate to password handling, session management, and missing security controls. Immediate attention is required for the critical and high-severity findings.

| Severity | Count |
|----------|-------|
| Critical | 3 |
| High | 4 |
| Medium | 5 |
| Low | 4 |

---

## Critical Vulnerabilities

### 1. Plaintext Password Storage

**Location:** `src/lib/db.ts:163, 212-217`

**Description:** Admin passwords are stored in plaintext in the database and compared using direct string equality.

```typescript
// db.ts:163 - Stored as plaintext
await setSetting(CONFIG_KEYS.ADMIN_PASSWORD, adminPassword);

// db.ts:216 - Direct comparison
return stored !== null && stored === password;
```

**Risk:** If the database is compromised, all admin passwords are immediately exposed. This violates security best practices and compliance requirements (PCI-DSS, GDPR).

**Recommendation:** Use bcrypt or Argon2 for password hashing:
```typescript
import { hash, verify } from '@node-rs/argon2';

// When storing
await setSetting(CONFIG_KEYS.ADMIN_PASSWORD, await hash(password));

// When verifying
return stored !== null && await verify(stored, password);
```

---

### 2. Insecure Session Token Generation

**Location:** `src/server.ts:45-53`

**Description:** Session tokens are generated using `Math.random()`, which is NOT cryptographically secure.

```typescript
const generateSessionToken = (): string => {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let token = "";
  for (let i = 0; i < 32; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
};
```

**Risk:** `Math.random()` is predictable and can be reverse-engineered, allowing attackers to predict valid session tokens and hijack admin sessions.

**Recommendation:** Use cryptographically secure random generation:
```typescript
import { randomBytes } from 'crypto';

const generateSessionToken = (): string => {
  return randomBytes(32).toString('base64url');
};
```

---

### 3. Insecure Direct Object Reference (IDOR) in Payment Flow

**Location:** `src/server.ts:431, 466`

**Description:** Payment success and cancel URLs include `attendee_id` as a query parameter without cryptographic verification that the user owns that attendee record.

```typescript
// stripe.ts:68-69
const successUrl = `${baseUrl}/payment/success?attendee_id=${attendee.id}&session_id={CHECKOUT_SESSION_ID}`;
const cancelUrl = `${baseUrl}/payment/cancel?attendee_id=${attendee.id}`;
```

**Attack Scenario:**
1. Attacker reserves a ticket (creates attendee record)
2. Attacker modifies the `attendee_id` in the success URL
3. Attacker could potentially mark another user's reservation as paid

**Risk:** While Stripe session verification provides some protection, the `cancel` endpoint deletes the attendee without verifying ownership, enabling denial of service.

**Recommendation:**
- Add a signed token (HMAC) to callback URLs
- Verify the Stripe session's metadata matches the attendee_id
- Add rate limiting to prevent enumeration

---

## High Vulnerabilities

### 4. Missing CSRF Protection

**Location:** All POST endpoints in `src/server.ts`

**Description:** No CSRF tokens are implemented on any forms. All state-changing operations are vulnerable.

**Affected Endpoints:**
- `POST /setup/` - Initial setup
- `POST /admin/login` - Admin login
- `POST /admin/event` - Create event
- `POST /ticket/:id` - Reserve ticket

**Attack Scenario:** An attacker could craft a malicious page that submits forms to these endpoints when an authenticated admin visits it.

**Recommendation:** Implement CSRF tokens:
1. Generate token per session and store in database
2. Include token in hidden form field
3. Validate token on every POST request

---

### 5. Session Cookie Missing Security Attributes

**Location:** `src/server.ts:146-149`

**Description:** Session cookie is missing critical security attributes.

```typescript
return redirect(
  "/admin/",
  `session=${token}; HttpOnly; Path=/; Max-Age=86400`,
);
```

**Missing Attributes:**
- `Secure` - Cookie transmitted over HTTP
- `SameSite=Strict` - Vulnerable to CSRF

**Recommendation:**
```typescript
`session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/admin/; Max-Age=86400`
```

---

### 6. No Rate Limiting

**Location:** All endpoints

**Description:** No rate limiting is implemented anywhere in the application.

**Risks:**
- Brute force attacks on admin login
- Ticket reservation spam/DoS
- API abuse

**Recommendation:** Implement rate limiting middleware:
- Login: 5 attempts per 15 minutes per IP
- Ticket reservation: 10 per hour per IP
- General API: 100 requests per minute per IP

---

### 7. Open Redirect Vulnerability

**Location:** `src/server.ts:296`, `src/lib/html.ts:169, 291, 294`

**Description:** The `thank_you_url` field is user-controlled and used in redirects without validation.

```typescript
// server.ts:296
return redirect(event.thank_you_url);

// html.ts:294 - Used in JavaScript
window.location.href = "${escapeHtml(thankYouUrl)}";
```

**Attack Scenario:** Admin creates event with `thank_you_url` pointing to a phishing site. Users completing registration are redirected to the malicious site.

**Recommendation:**
- Validate URLs against an allowlist of domains
- Or require URLs to be same-origin
- Display a warning before external redirects

---

## Medium Vulnerabilities

### 8. Timing Attack on Password Verification

**Location:** `src/lib/db.ts:216`

**Description:** Password comparison uses `===` which is vulnerable to timing attacks.

```typescript
return stored !== null && stored === password;
```

**Risk:** Attackers can measure response times to determine password correctness character by character.

**Recommendation:** Use constant-time comparison:
```typescript
import { timingSafeEqual } from 'crypto';

const storedBuf = Buffer.from(stored);
const passwordBuf = Buffer.from(password);
if (storedBuf.length !== passwordBuf.length) return false;
return timingSafeEqual(storedBuf, passwordBuf);
```

---

### 9. Missing Security Headers

**Location:** `src/server.ts` - all response functions

**Description:** No security headers are set on HTTP responses.

**Missing Headers:**
| Header | Purpose |
|--------|---------|
| `Content-Security-Policy` | Prevent XSS, injection attacks |
| `X-Content-Type-Options: nosniff` | Prevent MIME sniffing |
| `X-Frame-Options: DENY` | Prevent clickjacking |
| `Strict-Transport-Security` | Enforce HTTPS |
| `Referrer-Policy` | Control referrer information |

**Recommendation:** Add security headers to all responses:
```typescript
const securityHeaders = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};
```

---

### 10. Weak Email Validation

**Location:** `src/server.ts:278`

**Description:** Email validation only checks for non-empty string.

```typescript
if (!name.trim() || !email.trim()) {
  return htmlResponse(ticketPage(event, "Name and email are required"), 400);
}
```

**Risk:** Invalid emails accepted, potential for injection attacks.

**Recommendation:** Add proper email format validation:
```typescript
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
if (!emailRegex.test(email)) {
  return htmlResponse(ticketPage(event, "Invalid email format"), 400);
}
```

---

### 11. Missing Input Validation on Price

**Location:** `src/server.ts:178-181`

**Description:** Unit price accepts any integer including negative values.

```typescript
const unitPrice =
  unitPriceStr && unitPriceStr.trim() !== ""
    ? Number.parseInt(unitPriceStr, 10)
    : null;
```

**Risk:** Negative prices could cause financial discrepancies or unexpected behavior with Stripe.

**Recommendation:**
```typescript
const unitPrice = unitPriceStr && unitPriceStr.trim() !== ""
  ? Math.max(0, Number.parseInt(unitPriceStr, 10))
  : null;
```

---

### 12. XSS Risk in JavaScript Redirect

**Location:** `src/lib/html.ts:293-295`

**Description:** While `escapeHtml` is used, placing user-controlled URLs in JavaScript context requires additional escaping.

```typescript
<script>
  setTimeout(function() {
    window.location.href = "${escapeHtml(thankYouUrl)}";
  }, 3000);
</script>
```

**Risk:** Special characters or edge cases might bypass HTML escaping in JavaScript string context.

**Recommendation:** Use JSON.stringify for JavaScript string contexts:
```typescript
window.location.href = ${JSON.stringify(thankYouUrl)};
```

---

## Low Vulnerabilities

### 13. Information Disclosure in Error Messages

**Location:** `src/server.ts:139`

**Description:** Error message "Invalid password" confirms admin account exists.

**Recommendation:** Use generic message: "Invalid credentials"

---

### 14. No Account Lockout

**Location:** `src/server.ts:133-150`

**Description:** Unlimited login attempts allowed with no lockout mechanism.

**Recommendation:** Lock account after 5 failed attempts for 15 minutes.

---

### 15. Sessions Not Invalidated on Password Change

**Location:** N/A (not implemented)

**Description:** If admin password is changed, existing sessions remain valid.

**Recommendation:** Clear all sessions when password is changed.

---

### 16. Session Path Too Broad

**Location:** `src/server.ts:148`

**Description:** Session cookie path is `/` instead of `/admin/`.

```typescript
`session=${token}; HttpOnly; Path=/; Max-Age=86400`
```

**Risk:** Cookie sent with all requests, not just admin routes.

**Recommendation:** Change to `Path=/admin/` to limit cookie scope.

---

## Remediation Priority

### Immediate (This Week)
1. Implement password hashing (Critical #1)
2. Fix session token generation (Critical #2)
3. Add CSRF protection (High #4)
4. Fix session cookie attributes (High #5)

### Short-term (This Month)
5. Add rate limiting (High #6)
6. Validate thank_you_url (High #7)
7. Fix IDOR in payment flow (Critical #3)
8. Add security headers (Medium #9)

### Medium-term (Next Quarter)
9. Implement constant-time comparison (Medium #8)
10. Improve input validation (Medium #10, #11)
11. Fix JavaScript escaping (Medium #12)
12. Improve error messages (Low #13)
13. Add account lockout (Low #14)
14. Session invalidation on password change (Low #15)
15. Narrow session cookie path (Low #16)

---

## Summary

The application has significant security vulnerabilities that must be addressed before production deployment. The most critical issues are the plaintext password storage and insecure session token generation, which could lead to complete system compromise. Implementing the recommended fixes in priority order will significantly improve the security posture of the application.
