# Adding Email Support via HTTP Email API

## Context

The ticket reservation system runs on Bunny Edge Scripting, which only supports `fetch()` — no raw TCP sockets. Traditional SMTP (nodemailer, etc.) requires TCP connections, so it's not viable on the edge. The solution is to use an HTTP-based email API service (Resend, Postmark, or SendGrid) which sends email via a simple `fetch()` POST — identical to the existing webhook and ntfy patterns.

**Emails to send:**
1. **Registration confirmation** to the attendee after ticket purchase (with ticket link)
2. **Admin notification** to the business email when registrations come in
3. **Ticket delivery** with ticket URL to the attendee

Both **HTML and plain text** versions are sent for every email. The existing **business email** setting is used as the `Reply-To` address. Email errors are logged to the **activity log** (same pattern as webhook failures).

## Provider API Reference

All three providers support sending both HTML + plain text in a single request.

### Resend
```
POST https://api.resend.com/emails
Authorization: Bearer <API_KEY>
Content-Type: application/json

{
  "from": "Name <sender@domain.com>",
  "to": ["recipient@example.com"],
  "reply_to": "business@example.com",
  "subject": "Subject",
  "html": "<h1>HTML content</h1>",
  "text": "Plain text content"
}

Response 200: { "id": "uuid" }
```
- `from`, `to`, `subject` required; at least one of `html`/`text` required
- Optional: `cc`, `bcc`, `reply_to`, `headers`, `attachments`, `tags`
- Idempotency: `Idempotency-Key` header (24h expiry)

### Postmark
```
POST https://api.postmarkapp.com/email
X-Postmark-Server-Token: <API_KEY>
Content-Type: application/json
Accept: application/json

{
  "From": "Name <sender@domain.com>",
  "To": "recipient@example.com",
  "ReplyTo": "business@example.com",
  "Subject": "Subject",
  "HtmlBody": "<h1>HTML content</h1>",
  "TextBody": "Plain text content"
}

Response 200: { "To": "...", "MessageID": "uuid", "ErrorCode": 0, "Message": "OK" }
```
- `From`, `To` required; at least one of `HtmlBody`/`TextBody` required
- Optional: `Cc`, `Bcc`, `ReplyTo`, `Tag`, `Headers`, `Attachments`, `TrackOpens`, `MessageStream`

### SendGrid
```
POST https://api.sendgrid.com/v3/mail/send
Authorization: Bearer <API_KEY>
Content-Type: application/json

{
  "personalizations": [{ "to": [{ "email": "recipient@example.com" }] }],
  "from": { "email": "sender@domain.com", "name": "Name" },
  "reply_to": { "email": "business@example.com" },
  "subject": "Subject",
  "content": [
    { "type": "text/plain", "value": "Plain text content" },
    { "type": "text/html", "value": "<h1>HTML content</h1>" }
  ]
}

Response 202: (empty body on success)
```
- `personalizations`, `from`, `content` required
- Plain text MUST come before HTML in the `content` array
- Optional: `reply_to`, `headers`, `attachments`, `send_at`

## SDK Strategy

**Runtime**: Plain `fetch()` calls only — no SDK in the production bundle (keeps bundle small, no dependencies).

**Dev dependencies**: Add provider SDKs for type-checking our request/response shapes at compile time and for integration testing:
- `resend` (192KB) — types for request/response validation
- `postmark` (345KB, 1 dependency) — types for request/response validation
- `@sendgrid/mail` — types for request/response validation

These are dev-only (not bundled for edge). Tests can import SDK types to validate that our hand-crafted fetch payloads match the expected shapes.

## Implementation Plan

### 1. Add dev dependencies

```
deno add --dev npm:resend npm:postmark npm:@sendgrid/mail
```

### 2. Config: Email settings in DB (`src/lib/db/settings.ts`)

Add new `CONFIG_KEYS`:
```typescript
EMAIL_PROVIDER: "email_provider"         // "resend" | "postmark" | "sendgrid" | "" (plaintext)
EMAIL_API_KEY: "email_api_key"           // encrypted
EMAIL_FROM_ADDRESS: "email_from_address" // encrypted (verified sender address)
```

Add getter/setter functions following the existing encrypted settings pattern (like `getStripeSecretKeyFromDb`/`updateStripeKey`):
- `getEmailProviderFromDb()` → plaintext setting (returns `string | null`)
- `getEmailApiKeyFromDb()` → decrypt (returns `string | null`)
- `updateEmailApiKey(key)` → encrypt + setSetting
- `getEmailFromAddressFromDb()` → decrypt (returns `string | null`)
- `updateEmailFromAddress(address)` → encrypt + setSetting

### 3. Error code (`src/lib/logger.ts`)

Add `EMAIL_SEND = "E_EMAIL_SEND"` to the `ErrorCode` enum.

Add `"Email"` to the `LogCategory` type union.

### 4. Email sending module (`src/lib/email.ts`)

New file following the `src/lib/webhook.ts` pattern:

```typescript
type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
};

type EmailConfig = {
  provider: string;
  apiKey: string;
  fromAddress: string;
};
```

**Core functions:**
- `getEmailConfig()` — reads provider, API key, from address from DB settings (cached via settings cache). Returns `null` if no provider configured.
- `sendEmail(config, message)` — dispatches to provider-specific fetch call
- `sendViaResend(config, message)` — POST to `https://api.resend.com/emails` with `{ from, to, reply_to, subject, html, text }`
- `sendViaPostmark(config, message)` — POST to `https://api.postmarkapp.com/email` with `{ From, To, ReplyTo, Subject, HtmlBody, TextBody }`
- `sendViaSendGrid(config, message)` — POST to `https://api.sendgrid.com/v3/mail/send` with `{ personalizations, from, reply_to, subject, content: [text/plain, text/html] }`
- `sendRegistrationEmails(entries, currency)` — builds confirmation + admin emails:
  1. Gets email config (early return if not configured)
  2. Gets business email for reply-to
  3. Builds attendee confirmation email (to: attendee email)
  4. Builds admin notification email (to: business email)
  5. Sends both via `Promise.allSettled()`
- Error handling: `logError({ code: ErrorCode.EMAIL_SEND, ... })` + `logActivity()` for failures (same pattern as `sendWebhook`). Never throws.

### 5. Email templates (`src/templates/email/`)

Two new template files, each exporting functions that return `{ subject: string, html: string, text: string }`:

**`registration-confirmation.ts`**:
- Input: registration entries, currency, ticket URL
- Subject: `"Your tickets for [Event Name]"` (or `"Your tickets for [Event1] and [Event2]"` for multi)
- HTML: styled inline-CSS confirmation with event details, ticket link, quantity, price paid
- Text: plain text equivalent with same info

**`admin-notification.ts`**:
- Input: registration entries, currency, attendee contact info
- Subject: `"New registration: [Attendee Name] for [Event Name]"`
- HTML: registration summary for admin review — attendee name, events, quantities, total price
- Text: plain text equivalent

Templates use inline CSS only (email clients strip `<link>` and `<style>` tags in most cases).

### 6. Integration: Hook into registration flow (`src/lib/webhook.ts`)

Modify `logAndNotifyRegistration()` and `logAndNotifyMultiRegistration()` to also queue email sends alongside webhook sends:

```typescript
// In logAndNotifyRegistration:
addPendingWork(sendRegistrationEmails([{ event, attendee }], currency));

// In logAndNotifyMultiRegistration:
addPendingWork(sendRegistrationEmails(entries, currency));
```

This runs in parallel with webhook sends via the existing `pending-work.ts` queue.

### 7. Admin UI: Email settings (`src/templates/admin/settings.tsx` + `src/routes/admin.ts`)

Add email configuration section to the existing settings page:
- Provider dropdown: None / Resend / Postmark / SendGrid
- API key field (password input, encrypted at rest)
- From address field (e.g., `tickets@yourdomain.com`)
- "Send test email" button (sends test to the business email address)

POST handler in `src/routes/admin.ts` for saving email settings + test email endpoint.

### 8. Activity log integration

Email send failures are logged to the activity log (like webhook failures in `sendWebhook`):

```typescript
// On non-OK response:
await logActivity(`Email failed (status ${response.status}) for '${eventName}'`);

// On fetch error:
logError({ code: ErrorCode.EMAIL_SEND, detail: error.message });
```

This gives admins visibility into email delivery issues via the existing activity log UI.

### 9. Tests

**`src/lib/email.test.ts`**:
- Test each provider's fetch call (URL, headers, body shape)
- Verify Resend body: `{ from, to, reply_to, subject, html, text }`
- Verify Postmark body: `{ From, To, ReplyTo, Subject, HtmlBody, TextBody }`
- Verify SendGrid body: `{ personalizations, from, reply_to, subject, content: [text/plain, text/html] }`
- Test error handling (non-200 response logs to activity log, fetch failure logs error)
- Test graceful skip when no provider configured
- Test `sendRegistrationEmails` builds and sends both confirmation + admin notification
- Verify business email used as reply-to
- Use SDK types as compile-time validation of request shapes

**`src/templates/email/registration-confirmation.test.ts`**:
- Test HTML output contains event name, ticket URL, price, quantity
- Test plain text output contains same info
- Test multi-event subject formatting
- Test free event (no price shown)

**`src/templates/email/admin-notification.test.ts`**:
- Test HTML output contains attendee name, event name, quantity, price
- Test plain text output contains same info

## Files to Modify

| File | Change |
|------|--------|
| `deno.json` | Add dev dependencies: `resend`, `postmark`, `@sendgrid/mail` |
| `src/lib/db/settings.ts` | Add `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM_ADDRESS` config keys + getters/setters + export via `settingsApi` |
| `src/lib/logger.ts` | Add `EMAIL_SEND` error code + `"Email"` log category |
| `src/lib/webhook.ts` | Add `sendRegistrationEmails()` call in `logAndNotifyRegistration` + `logAndNotifyMultiRegistration` |
| `src/templates/admin/settings.tsx` | Add email provider config UI section |
| `src/routes/admin.ts` | Add POST handler for email settings save + test email |
| **New:** `src/lib/email.ts` | Email sending module (provider dispatch, registration emails) |
| **New:** `src/templates/email/registration-confirmation.ts` | Attendee confirmation email template |
| **New:** `src/templates/email/admin-notification.ts` | Admin notification email template |
| **New:** `src/lib/email.test.ts` | Tests for email module |
| **New:** `src/templates/email/registration-confirmation.test.ts` | Template tests |
| **New:** `src/templates/email/admin-notification.test.ts` | Template tests |

## Key Design Decisions

1. **No runtime dependencies** — just `fetch()`, same as webhooks/ntfy
2. **Both HTML and plain text** — always send both; never rely on provider auto-conversion
3. **Provider-agnostic** — switch providers by changing a dropdown, not code
4. **Business email as reply-to** — existing setting reused, not duplicated
5. **Encrypted credentials** — API key + from address stored encrypted in DB (same pattern as Stripe/Square keys)
6. **Fire-and-forget via pending-work** — email failures don't block registration
7. **Graceful degradation** — if no email provider configured, silently skipped
8. **Activity log for errors** — email failures logged to activity log like webhook failures, visible to admins
9. **SDK types for dev testing** — dev dependencies only, validates our fetch payloads match API specs at compile time

## Verification

1. `deno task test` — all existing + new tests pass
2. `deno task test:coverage` — 100% coverage maintained
3. `deno task precommit` — typecheck, lint, tests all pass
4. `deno task build:edge` — bundle builds under 10MB (SDKs are dev-only, not bundled)
5. Manual: configure email provider in admin settings → trigger registration → verify both confirmation + admin emails received
