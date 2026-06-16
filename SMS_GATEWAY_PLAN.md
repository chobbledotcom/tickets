# SMS Gateway — Design (built on SMS Gate / sms-gate.app)

## Decision

Add an SMS gateway to Chobble Tickets by using **[SMS Gateway for Android™
(SMS Gate)](https://sms-gate.app/)** — an existing, open-source
([Apache-2.0](https://github.com/android-sms-gateway/server)), actively
maintained app — as the on-phone radio, and building **only the server side on
our existing Bunny + libsql stack**.

**We do not build, fork, or maintain an Android app, and we do not use
Firebase.** We run SMS Gate in **Local Server mode** (the phone runs its own
HTTP server, no Google dependency) and make the phone reachable from our cloud
edge through a **tunnel**. Our Bunny app owns the queue, retries, admin UI, and
status/inbound webhooks; the phone is a dumb endpoint we `POST` to.

> Supersedes the earlier "fork textbee / build our own minimal APK" idea.
> textbee is dropped entirely: its server→phone path is Firebase-only, and
> building/maintaining any Android app (Kotlin or JS) is avoided by adopting
> SMS Gate's official signed app.

## Why SMS Gate, and why Local mode specifically

SMS Gate ships four wiring modes. None satisfies *all* of our constraints at
once, so we pick the one that satisfies the three that matter (no app building,
no Firebase, our-servers-only):

| Mode | No app build | No Firebase | Our servers only | Reuses Bunny/libsql |
| ---- | :----------: | :---------: | :--------------: | :-----------------: |
| **Cloud** (their SaaS relay) | ✅ | ✅ (their FCM) | ❌ their cloud | ❌ |
| **Private server** (self-host their Go+MySQL) | ✅ | ✅ (no FCM setup) | ⚠️ push hops via `api.sms-gate.app` | ❌ separate VPS |
| **Local mode + tunnel** ← chosen | ✅ | ✅ **none at all** | ✅ **fully** | ⚠️ Bunny calls phone |
| **Fully independent** | ❌ fork+rebuild | ❌ your own Firebase | ✅ | ⚠️ reimplement mobile API |

Two facts (from the maintainer and the server repo) rule out the "obvious"
paths:

- **There is no out-of-the-box, Firebase-free *pull* mode.** In Private Server
  mode the phone still receives push wake-ups via `api.sms-gate.app` → FCM (the
  relayed payload contains no phone numbers or message text, but it is still a
  dependency on their server). Making the official app *pull* from our Bunny
  server with no Firebase would require **forking + rebuilding the app with our
  own Firebase project** — exactly the app-maintenance burden we are avoiding.
- **Local mode uses no Firebase at all**, because the phone *is* the server: the
  app runs an HTTP server on `:8080` and we send by POSTing to it. Official,
  unmodified app.

The only cost of Local mode is reachability (phone is on its LAN, behind carrier
NAT). A tunnel solves it.

## Architecture (Local mode + tunnel)

```
Admin "Send SMS to booking" ─▶ Bunny edge (Deno + libsql)
                                  │  1. write sms_outbox row  (status=queued)
                                  │  2. POST /message  { textMessage, phoneNumbers }
                                  │     Basic Auth, over HTTPS
                                  ▼
                      Tailscale Funnel public HTTPS URL
                                  │
                                  ▼
                      Phone :8080  (SMS Gate local server)
                                  │  SmsManager sends the SMS
                                  ▼
        webhook (sms:sent / sms:delivered / sms:received)
                                  │  POST back
                                  ▼
                      Bunny  POST /api/sms/webhook  → update sms_outbox / sms_inbox
```

### What runs where

- **Phone**: the official SMS Gate app in Local Server mode (foreground service)
  + a tunnel client (Tailscale app with **Funnel**, or Cloudflare Tunnel /
  ngrok) exposing `localhost:8080` as a public HTTPS URL. Both apps exempted
  from battery optimisation (Doze).
- **Bunny edge (our app)**: owns the queue, retry/backoff, the admin send UI,
  and the inbound/status webhook receiver. Calls out to the phone's tunnel URL
  exactly like we already call Stripe / email providers via `fetch`
  (`src/shared/fetch.ts`, `src/shared/email.ts`).

### The phone-side protocol (we consume it, we don't build it)

- **Send**: `POST http://<tunnel-host>/message`, Basic Auth, body
  `{"textMessage":{"text":"…"},"phoneNumbers":["+44…"]}`.
- **Status + inbound**: SMS Gate posts webhooks (`sms:sent`, `sms:delivered`,
  `sms:failed`, `sms:received`) to a URL we register; we receive them at
  `POST /api/sms/webhook` and reconcile.

## Server side on Bunny (what we actually build — reuses our stack)

### 1. Connection settings (encrypted, admin-managed)

Store the gateway endpoint + Basic Auth creds in our existing encrypted settings
mechanism (`src/shared/db/settings.ts`, like the Stripe/email secrets), set on
an admin settings page. No new secret-handling code — reuse the pattern.

### 2. Tables (libsql)

- `sms_outbox` — `id`, `recipient`, `body`, `status`
  (`queued|sending|sent|delivered|failed`), `attempts`, `provider_message_id`,
  `error`, link to the triggering attendee/booking, `created`, `updated`.
- `sms_inbox` — only if/when we want to act on replies. Optional for v1.

Follow the existing db-module pattern (`src/shared/db/*.ts`: curried `#fp`,
`getDb()`, `insert`, `queryOne`, `queryAll`) + a migration in
`src/shared/db/migrations.ts`.

### 3. Routes / flow

- **Enqueue**: an admin action ("send SMS to this attendee/booking", or
  automatic booking-confirmation/reminder hooks) writes a `queued` row.
- **Dispatch**: because Bunny edge has **no cron/background worker**, dispatch is
  triggered inline at enqueue time (POST to the phone immediately) and, for
  retries of rows the phone couldn't take (offline), opportunistically on the
  next request or via an external uptime pinger hitting a dispatch endpoint.
  `sms_outbox` *is* the queue; the phone has no store-and-forward in Local mode,
  so Bunny owning retry/backoff is required and natural.
- **Webhook receiver**: `POST /api/sms/webhook` (mounted like the existing
  `apiRoutes` in `src/features/api/index.ts`) verifies the shared secret /
  signature and moves rows to `sent`/`delivered`/`failed`; inbound SMS land in
  `sms_inbox`.
- **Admin UI**: a "Send SMS" affordance on attendee/booking views, an outbox
  list with status, a gateway-health indicator (last successful send /
  last webhook), and the settings page for endpoint + creds.

### Edge constraints — all satisfied

- **No cron / no queue infra needed** — `sms_outbox` is the queue; dispatch is
  request-driven; retries are opportunistic.
- **No Firebase / no `firebase-admin`** — irrelevant in Local mode.
- **Outbound HTTPS only** — already a solved pattern in our codebase.

## Security

- The tunnel exposes the phone's SMS API publicly: protect with **Basic Auth
  over HTTPS + a hard-to-guess Funnel hostname**, and where possible an
  allowlist / Tailscale ACL / Cloudflare Access so only our Bunny egress can
  reach it.
- Gateway creds + webhook secret stored **encrypted** via the existing settings
  crypto.
- Webhook endpoint verifies a shared secret before mutating `sms_outbox`.
- No attendee PII ever needs to leave our system except the single recipient
  number + body of each message, produced by an authenticated admin action.

## Reliability realities (independent of our code)

- Phone must stay powered, online, and running **two** foreground apps (SMS Gate
  + tunnel). Document the Doze/battery-optimisation exemptions for both.
- Local mode has no on-phone retry — Bunny must retry, which it does.
- A dead/unreachable phone surfaces as `sms_outbox` rows stuck `queued` past a
  threshold → drives the gateway-health indicator and (optionally) an alert.
- Carrier SMS limits / costs still apply; throttle sends (a small per-message
  delay) to avoid carrier throttling.

## Effort & phasing

| Piece | Effort | Notes |
| ----- | ------ | ----- |
| Encrypted gateway settings + admin settings page | Low | Reuse settings crypto pattern |
| `sms_outbox` table + migration + db module | Low | Existing pattern |
| Dispatch (POST to phone) + retry/backoff | Low–Med | Inline + opportunistic |
| `POST /api/sms/webhook` receiver + status reconcile | Low | Mounted like `apiRoutes` |
| Admin "Send SMS" UI + outbox + health indicator | Med | New templates/actions |
| Phone setup runbook (SMS Gate + Tailscale Funnel + Doze) | Low | Docs, not code |
| `sms_inbox` + reply handling | Optional | Defer to v2 |

**No Android toolchain, no Gradle, no signing keystore, no Play Store review, no
Kotlin/JS app to maintain.** All new code is Deno/libsql in our existing repo.

### Phasing

1. **Spike**: stand up SMS Gate Local mode on a test phone + Tailscale Funnel;
   `curl` the `/message` endpoint to confirm end-to-end send + webhook shape.
2. **Server core**: settings, `sms_outbox`, dispatch + retry, webhook receiver.
3. **Admin UX**: send action, outbox view, health indicator.
4. **Automation**: booking-confirmation / reminder SMS hooks.
5. **(Optional v2)**: inbound replies (`sms_inbox`), multi-phone, or migrate to
   **Private Server mode** if we outgrow a single tunneled phone (same
   `POST /api/3rdparty/v1/message` integration, minimal server-side change).

## Open questions

- **Tunnel choice**: Tailscale Funnel (first-class Android app, public HTTPS) vs
  Cloudflare Tunnel vs ngrok. Recommend **Tailscale Funnel**.
- **Dispatch trigger for retries**: purely opportunistic (on next request) vs an
  external uptime-cron pinging a dispatch endpoint every minute. Recommend an
  external pinger for predictable retry latency.
- **When to graduate to Private Server mode**: multiple phones / higher volume /
  wanting a gateway-side queue — accept the content-free push hop through
  `api.sms-gate.app` at that point.
- **Send throttle default** (per-message delay) to stay under carrier limits.
