# SMS Gateway — Design (SMS Gate free cloud API + end-to-end encryption)

## Decision

Add an SMS gateway to Chobble Tickets using **[SMS Gateway for Android™
(SMS Gate)](https://sms-gate.app/)** — an existing, open-source, maintained app
— in **Cloud mode against its free public API** (`api.sms-gate.app`), with
**[end-to-end encryption](https://docs.sms-gate.app/privacy/encryption/)**
enabled so the relay never sees recipient numbers or message text.

**We build only server-side code, entirely on our existing Bunny + libsql
stack.** No Android app to build/fork/maintain, no Firebase to configure, and —
in this cloud configuration — **no self-hosted server, tunnel, or VPS at all**.
The phone runs the official Play Store app; Bunny encrypts message content with
the shared passphrase and POSTs ciphertext to the free cloud API.

> Evolution of this doc: started as "fork textbee / build an APK" → "self-host
> SMS Gate (Local mode) behind a Tailscale exit node" → **this**: SMS Gate's
> free cloud API + E2EE. Each step removed infrastructure while preserving
> privacy. The self-hosted variants remain valid fallbacks (see *Migration
> path*) because the API and encryption scheme are identical.

## Why this over the alternatives

| Concern | Cloud + E2EE (chosen) | Self-host Local mode + Tailscale | Build/fork an app |
| ------- | --------------------- | -------------------------------- | ----------------- |
| App to build/maintain | None (official app) | None (official app) | Yes |
| Firebase | None for us | None | Your own project |
| Infrastructure | **None** | VPS/box + tunnel/exit node | CI + signing + Play |
| Privacy of content/recipients | **E2EE — relay sees ciphertext only** | Stays on your wire | Depends |
| New code | Bunny/libsql only | Bunny/libsql + relay agent | App + server |
| Third-party dependency | Free cloud relay (mitigated) | None | None |

E2EE is what makes the cloud relay acceptable: the documented scheme encrypts
exactly the sensitive fields, and we can reproduce it with **built-in WebCrypto**
(no libraries), so the relay and Google FCM only ever carry opaque ciphertext.

## End-to-end encryption (the privacy mechanism)

Per the SMS Gate spec:

- **Encrypted fields**: `textMessage.text` (or `dataMessage.data`) and **every
  entry in `phoneNumbers`**. `id`, `simNumber`, `ttl` stay clear. Set
  `isEncrypted: true`.
- **Scheme**: `AES-256-CBC`, key via `PBKDF2-HMAC-SHA1`, 256-bit key, **16-byte
  random salt generated per message that doubles as the IV**, default **75,000**
  iterations (configurable).
- **Encoded format**:
  `$aes-256-cbc/pbkdf2-sha1$i=<iterations>$<base64 salt>$<base64 ciphertext>`
- **Passphrase**: a shared secret configured identically on the phone (app
  settings) and in our API client. The server never receives the passphrase or
  any plaintext.

### Reproducing it on Bunny edge (WebCrypto, mirrors `src/shared/crypto/`)

```ts
// salt (16B) is BOTH the PBKDF2 salt and the AES-CBC IV. WebCrypto adds PKCS#7.
async function encryptField(plaintext: string, passphrase: string, iterations = 75_000) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const km = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-1", salt, iterations }, km,
    { name: "AES-CBC", length: 256 }, false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: salt }, key, enc.encode(plaintext)));
  return `$aes-256-cbc/pbkdf2-sha1$i=${iterations}$${b64(salt)}$${b64(ct)}`;
}
// decrypt: split on '$', read iterations + salt, re-derive key, AES-CBC decrypt with iv=salt.
```

Decryption parses the `$`-delimited string, re-derives the key from the embedded
salt + iterations, and AES-CBC-decrypts with `iv = salt`. ~40 lines total,
unit-tested against the official client's encrypt/decrypt output for parity.

## Architecture

```
Admin "Send SMS to booking" ─▶ Bunny edge (Deno + libsql)
   1. write sms_outbox row (status=queued)
   2. encrypt text + phoneNumbers (WebCrypto, shared passphrase); isEncrypted=true
   3. POST https://api.sms-gate.app/3rdparty/v1/messages   (HTTP Basic auth)
                          │   relay stores/forwards CIPHERTEXT + metadata only
                          ▼
              api.sms-gate.app ──FCM push (opaque)──▶ Phone (official app, Cloud mode)
                          ▲                                │ decrypts with passphrase
                          │                                │ SmsManager sends the SMS
              status / inbound webhook ───────────────────┘
                          ▼
              Bunny  POST /api/sms/webhook  (decrypts encrypted fields) → reconcile
```

The cloud owns push delivery, retry, and multi-device fan-out; we don't build
dispatch infrastructure.

## Server side on Bunny (what we actually build — reuses our stack)

1. **E2EE helper** — `encryptField` / `decryptField` (WebCrypto) + tests for
   format parity. Lives alongside `src/shared/crypto/`.
2. **Gateway settings** — store cloud username, password, and the E2EE
   passphrase **encrypted** via the existing settings crypto
   (`src/shared/db/settings.ts`), set on an admin settings page (same pattern as
   Stripe/email secrets).
3. **`sms_outbox`** (+ optional `sms_inbox`) — for our own record, idempotency,
   and status display. db-module pattern (`src/shared/db/*.ts`, curried `#fp`)
   + migration in `src/shared/db/migrations.ts`.
4. **Send** — encrypt fields, `POST /3rdparty/v1/messages` with Basic auth via
   our existing `fetch` helper; store the returned message id on the outbox row.
   *(Confirm the exact path/prefix against the SMS Gate OpenAPI spec at
   implementation time.)*
5. **Webhook receiver** — `POST /api/sms/webhook` (mounted like the existing
   `apiRoutes` in `src/features/api/index.ts`), verifies a shared secret,
   **decrypts** any encrypted fields, and moves outbox rows to
   `sent`/`delivered`/`failed`; inbound SMS → `sms_inbox`.
6. **Admin UI** — a "Send SMS" affordance on attendee/booking views, an outbox
   list with status, and a gateway-health indicator.

### Edge constraints — all satisfied

- **No cron / no queues / no background workers** — the cloud handles delivery;
  our `sms_outbox` is just a record + status mirror.
- **No Firebase / `firebase-admin`** — push is the cloud's concern.
- **Outbound HTTPS + WebCrypto only** — both already first-class in our codebase.

## Privacy properties

- **Protected by E2EE**: message text and recipient phone numbers — never seen
  by the relay or Google FCM (ciphertext only).
- **Still visible as metadata**: that a given device sent N messages of size S at
  time T, message ids, and `ttl`/`simNumber`. E2EE does not hide traffic
  metadata.
- No attendee PII leaves our system beyond the (encrypted) per-message recipient
  + body, produced by an authenticated admin action.

## Caveats / risks + migration path

- **Dependency on a free third-party SaaS** (`api.sms-gate.app`): no SLA; it
  could rate-limit, change, or monetise. **Mitigation**: the 3rd-party API *and*
  the E2EE scheme are identical for self-hosted **Private** or **Local** mode, so
  moving off the cloud later is a settings change (new base URL/creds), not a
  rewrite. The earlier "Local mode + Tailscale exit node + relay agent" design is
  the drop-in sovereign fallback.
- **Verify free-tier limits/quotas** before depending on it for volume — not
  documented; check or email the maintainer.
- **Passphrase management** — shared secret on phone + in encrypted settings;
  rotation updates both.
- **Trust** — relies on the open-source app implementing E2EE correctly and not
  leaking the passphrase (auditable).
- **Battery** — encryption modestly increases the phone's battery use (their
  note); irrelevant server-side.
- **Reliability** — a dead/offline phone surfaces as outbox rows stuck `queued`
  past a threshold → drives the health indicator / optional alert.

## Effort & phasing

| Piece | Effort | Notes |
| ----- | ------ | ----- |
| E2EE encrypt/decrypt helper + parity tests | Low | WebCrypto, ~40 lines |
| Encrypted gateway settings + admin page | Low | Reuse settings crypto |
| `sms_outbox` table + migration + db module | Low | Existing pattern |
| Send call to `/3rdparty/v1/messages` | Low | Existing `fetch` helper |
| `POST /api/sms/webhook` + decrypt + reconcile | Low–Med | Mounted like `apiRoutes` |
| Admin "Send SMS" UI + outbox + health | Med | New templates/actions |
| `sms_inbox` + reply handling | Optional | Defer to v2 |

**No Android toolchain, no Gradle/signing/Play review, no tunnel, no VPS, no
Firebase.** Everything new is Deno/libsql in this repo.

### Phasing

1. **Spike**: register a test phone on the free cloud with E2EE; from a scratch
   script, encrypt a message and `POST /3rdparty/v1/messages`; confirm the phone
   decrypts and sends, and inspect the webhook payload shape.
2. **Crypto**: ship `encryptField`/`decryptField` with parity tests.
3. **Server core**: settings, `sms_outbox`, send, webhook receiver.
4. **Admin UX**: send action, outbox view, health indicator.
5. **Automation**: booking-confirmation / reminder SMS hooks.
6. **(Optional)** inbound replies (`sms_inbox`); or migrate to self-hosted
   Private/Local mode if the free cloud proves insufficient.

## API reference (cloud 3rd-party API)

> Base URL: `https://api.sms-gate.app`. Auth: **HTTP Basic** (username +
> password issued to the account). Paths confirmed from the docs; re-verify the
> exact prefix against the OpenAPI spec during the spike.

### Send a message — `POST /3rdparty/v1/messages`

```jsonc
{
  "id": "<optional client-supplied id, for idempotency>",
  "textMessage": { "text": "<encrypted text>" },
  "phoneNumbers": ["<encrypted recipient>", "..."],
  "isEncrypted": true,            // set when text + phoneNumbers are E2E-encrypted
  "withDeliveryReport": true,
  "ttl": 86400,                   // optional seconds-to-live
  "simNumber": null,              // optional SIM selection
  "priority": 0
}
```

Response carries a message `id` and per-recipient `state`
(`Pending → Processed → Sent → Delivered`, or `Failed`). Query later with
`GET /3rdparty/v1/messages/{id}`.

### Webhooks (status + inbound)

Register: `POST /3rdparty/v1/webhooks` with `{ url, event, deviceId? }` (one
webhook per event). Events: `sms:sent`, `sms:delivered`, `sms:failed`,
`sms:received`, `sms:data-received`, `mms:received`, `system:ping`.

Delivery envelope:

```jsonc
{ "deviceId": "...", "event": "sms:delivered", "id": "...",
  "webhookId": "...", "payload": { /* event-specific */ } }
```

**Signature**: headers `X-Signature` (hex) and `X-Timestamp` (unix seconds);
verify with `HMAC-SHA256(secret, rawBody + timestamp)` (the signing key is set
in the app). Our receiver verifies this before mutating state. *(Whether inbound
webhook fields are themselves E2E-encrypted is unconfirmed — verify in the
spike; if so, the receiver decrypts with the passphrase.)*

## End-to-end key + the v1 encryption flow

A dedicated **SMS E2E passphrase** ("the E2E key") is generated once and stored
**encrypted under `DATA_KEY`** in settings (same crypto as the Stripe/email
secrets). The owner enters the same passphrase into the phone app. It is the
only thing that can decrypt outbox ciphertext, so the outbox is safe at rest.

Sending a text to an attendee (owner is authenticated → holds the private key):

1. **Decrypt** the attendee's phone with the owner's private key
   (`decryptAttendeeFields` / `decryptPiiBlob`, `src/shared/db/attendees/pii.ts`).
2. **Compose** the message text.
3. **Re-encrypt** the phone number and the message text with the E2E passphrase
   via `encryptField` (`src/shared/sms/e2e.ts`).
4. **Enqueue** an `sms_outbox` row containing **only** the E2E ciphertext
   (`phone_enc`, `body_enc`) + status `queued`. Plaintext PII is never written.
5. **Dispatch**: POST the already-encrypted payload (`isEncrypted: true`) to the
   cloud; store the returned message id and mark `sent`. Webhooks later move it
   to `delivered`/`failed`.

This keeps the encryption-at-rest invariant intact: attendee PII is decrypted
only transiently in memory under the owner's key, re-encrypted under the E2E
key, and only ciphertext touches the database or the network.

### Modules (v1)

| Module | Role | Status |
| ------ | ---- | ------ |
| `src/shared/sms/e2e.ts` | SMS Gate E2E encrypt/decrypt (WebCrypto) | ✅ built + tested |
| `src/shared/db/sms-outbox.ts` | outbox table ops (stores ciphertext only) | planned |
| `src/shared/sms/gateway.ts` | cloud client: send + (later) webhook verify | planned |
| settings (`sms_gateway_*`) | encrypted passphrase + Basic-auth creds | planned |
| admin "contact" route + template | adapt the attendee email flow | planned |

## Open questions

- **Free-tier limits**: confirmed by the operator as effectively unlimited "as
  long as you don't affect deliverability" — so throttle sends to stay polite.
- **Exact send path/prefix** and whether inbound webhook fields are encrypted —
  confirm against the OpenAPI spec / a live test in the spike.
- **Passphrase rotation** UX in admin settings (re-key invalidates in-flight
  outbox rows).
- **Inbound SMS** (`sms_inbox`) — deferred beyond v1.
