# SMS Gateway — Minimal First-Party Android App (Feasibility & Design)

## Decision

Build a **minimal, first-party Android APK** (produced as part of our build
process) that turns an owner's spare Android phone into an SMS gateway for
Chobble Tickets. The phone authenticates with a **scoped API key** created
through the normal admin UI, **polls our Bunny edge server** for queued
messages, sends them with the system `SmsManager`, and reports status back.

**No Firebase. No MongoDB. No Redis. No queues. No third party at all** — just
our existing Deno/libsql edge app plus one tiny Kotlin app talking HTTPS to it.

[textbee](https://github.com/vernu/textbee) (MIT licensed) is used purely as a
reference for the parts that are genuinely hard — the Android `SmsManager`
send/multipart/delivery-receipt code — and we discard everything else.

## Why polling, not push

textbee's server reaches the phone exclusively through **Firebase Cloud
Messaging** (`firebaseAdmin.messaging().sendEach(...)` in
`api/src/gateway/gateway.service.ts`, received by `FCMService.onMessageReceived`
in the app). Adopting that would tie us to a Google Firebase project forever and
pull the `firebase-admin` Node SDK into a runtime (Bunny edge / Deno) that can't
run it.

Polling removes Google from the picture entirely. The tradeoff is latency and a
little battery: the phone checks in every N seconds instead of being pushed to.
For our use cases (booking confirmations, reminders, low volume, latency-
tolerant) that is the right call, and it matches the app's "our servers only"
philosophy.

## Architecture

```
Admin UI ──"send SMS to booking"──▶ Bunny edge (Deno + libsql)
                                         │  writes row to sms_outbox (status=queued)
                                         ▼
                                    [ sms_outbox table ]
                                         ▲
   Owner's phone (our APK) ──poll every Ns, x-api-key (scoped)──┘
        │   GET  /api/sms/poll        → claims queued rows (status=sending)
        │   SmsManager.sendMultipartTextMessage(...)
        └── POST /api/sms/status      → reports sent / delivered / failed
```

Everything server-side is request-driven, which is exactly what Bunny edge
supports. There is no background worker on the server — the phone is the worker,
and it drives the loop.

## Server side (Bunny edge — reuse existing stack)

### 1. Scoped credential ("device key")

Our current API keys are **deliberately over-powered for a phone in someone's
pocket**: each key wraps the master `DATA_KEY`, so holding one grants full
admin-level access *and* the ability to decrypt all attendee PII
(`src/shared/db/api-keys.ts`, `src/features/auth.ts` `authenticateApiKey`). We
must **not** put that on an SMS gateway device.

Introduce a **scoped key** that can reach only the SMS gateway endpoints and
carries **no PII-decryption capability**:

- Add a `scope` column to `api_keys` (default `admin`, new value `sms_device`),
  or a dedicated `sms_device_keys` table — a `scope` column reuses the existing
  create/list/delete/auth plumbing with the least churn.
- A `sms_device` key has **no `wrapped_data_key`** (or a wrapped key for a
  separate, PII-free data scope). It cannot call `getPrivateKey()` and therefore
  cannot decrypt attendees.
- Extend the auth layer: today `withAuth` + the `ADMIN_API` policy
  (`src/features/auth.ts`) gates Bearer keys for `/api/*`. Add an `SMS_DEVICE`
  policy / capability check so the new endpoints accept *only* `sms_device`
  keys, and the existing admin endpoints reject them.
- Keys are still created "through the usual users bit": the API-keys admin page
  (`src/features/admin/api-keys.ts`, `src/ui/templates/admin/api-keys.tsx`)
  gains a "device key" type. Inherit/record which user owns it for audit
  (`last_used`, name).

The message body the phone receives *is* the SMS text (not encrypted at rest in
a way the device must unwrap), so the device never needs the PII key — it only
needs the already-rendered recipient number + message, which the **admin**
session produced when queuing.

### 2. Tables (libsql)

- `sms_devices` — `id`, `key_id` (FK to the scoped api key), `name`,
  `last_seen`, `enabled`. Optional; a key alone can act as the device identity
  for v1.
- `sms_outbox` — `id`, `recipient`, `body`, `status`
  (`queued|sending|sent|delivered|failed`), `claimed_by`, `claimed_at`,
  `attempts`, `error`, `created`, `updated`, plus a link back to the
  attendee/booking that triggered it (for the admin view).
- `sms_inbox` — only if we want inbound SMS later. **Skip for v1.**

Follow the existing `src/shared/db/*.ts` module pattern (curried `#fp`,
`getDb()`, `insert`, `queryOne`, `queryAll`) and add a migration in
`src/shared/db/migrations.ts`.

### 3. Endpoints (the polling protocol)

All under `/api/sms/*`, mounted like the existing `apiRoutes`
(`src/features/api/index.ts` → `defineRoutes`/`createRouter`), authenticated
with the new `SMS_DEVICE` policy.

| Method & path          | Purpose |
| ---------------------- | ------- |
| `GET  /api/sms/poll`   | Atomically claim up to N `queued` rows → flip to `sending`, stamp `claimed_by`/`claimed_at`, return `[{id, recipient, body}]`. Also updates device `last_seen`. |
| `POST /api/sms/status` | Body `[{id, status, error?, sentAt?, deliveredAt?}]`. Move rows to `sent`/`delivered`/`failed`. |
| `POST /api/sms/heartbeat` *(optional)* | Lightweight liveness ping + config echo (poll interval, send delay). Lets the admin UI show "gateway online". |

Claiming must be race-safe (a single `UPDATE ... WHERE status='queued' ...
RETURNING` or a transaction) so two isolates / a double-poll can't double-send.
A reaper isn't a cron job: any `poll` can opportunistically reclaim `sending`
rows whose `claimed_at` is older than a timeout (re-queue for retry), since the
phone is the only thing that ever calls in.

### Edge constraints — all handled by this design

- **No cron** → textbee's hourly heartbeat-check and 5-min status-reconcile
  crons are gone; liveness is derived from `last_seen` on each poll, retries are
  handled opportunistically on poll.
- **No Redis/BullMQ** → `sms_outbox` *is* the queue; large batches are just many
  rows the phone drains over successive polls.
- **No `firebase-admin`** → no push at all.
- **Outbound HTTPS** isn't even needed server→phone (phone initiates), so we
  don't touch the `fetch` path the email senders use.

## Android app (minimal — built by us)

### What we keep from textbee (the only genuinely valuable part)

The ~100 lines that correctly handle Android SMS sending, adapted from
`android/.../helpers/SMSHelper.kt` and `workers/SmsSendWorker.kt`:

- `SmsManager.divideMessage()` + `sendMultipartTextMessage()` for long SMS.
- `PendingIntent`-based **sent / delivered** receipts → maps to our
  `sent`/`delivered`/`failed` statuses.
- Permission handling for `SEND_SMS` (+ `READ_PHONE_STATE` only if we keep
  multi-SIM selection — probably drop for v1).

### What we drop (the "crap we don't need")

- **All of Firebase**: `firebase-messaging`, `google-services.json`,
  `FCMService`, crashlytics, the `com.google.gms` Gradle plugins.
- The Next.js **web dashboard** (our admin UI replaces it).
- **Billing / plans / Polar**, webhooks, mail, support modules.
- QR onboarding, multi-device, the entire Compose UI suite. Our app is **one
  screen**: paste/scan host URL + API key, grant SMS permission, toggle
  "gateway on", show last-sync + counters.
- Inbound SMS receiving (v1).

### Components (tiny)

- A **foreground service** (or periodic `WorkManager`, ≥15-min floor) running
  the poll loop with a sticky notification ("SMS gateway active") — required for
  Android to keep us alive and for Play Store transparency.
- A `Retrofit`/`OkHttp` (or plain `HttpURLConnection`) client with three calls
  matching the protocol above; `x-api-key` header.
- `SharedPreferences` for host + key + enabled flag (textbee's
  `SharedPreferenceHelper` pattern).
- One config/setup `Activity`.

Realistically **a few hundred lines of Kotlin**, versus textbee's ~6,500.

### Build & distribution ("part of our build process")

Important reality check: **our current build is Deno + esbuild for the edge**
(`scripts/build-edge.ts`, `deno task build:edge`). It cannot produce an APK — an
Android build needs the Android SDK + Gradle/JDK, which is a different toolchain.
So "part of our build process" means a **separate CI job**, not the Deno build:

- A new `.github/workflows/android.yml` (we already have CI workflows like
  `bunny-deploy.yml`, `release.yml`) that runs `./gradlew assembleRelease` on a
  runner with the Android SDK, signs the APK, and attaches it to a GitHub
  release / our `release.yml` flow.
- The app source lives in a subdirectory (e.g. `android/`) or a sibling repo.
  Keeping it in-repo means the host URL can be injected at build time as a
  `buildConfigField` (textbee already does exactly this:
  `API_BASE_URL` in `android/app/build.gradle`), so each release is pinned to
  our domain by default while still allowing a custom host at setup.
- The owner installs the signed APK by side-load/download link from their admin
  area. **Publishing to the Play Store is optional and carries real cost**:
  Google's `SEND_SMS` permission policy review is strict (apps using SMS perms
  face extra scrutiny/justification). Side-loading a signed APK avoids that
  entirely for a self-hosted operator.

## Security model

- The device key is **scoped and PII-blind** — worst case if a phone is stolen
  is enumerating/sending the *queued* outbound messages, not reading the
  attendee database. Revoke the key in the admin UI to kill the device.
- Recipient numbers + bodies are produced by an authenticated **admin** action
  when queued; the phone only ever sees what it must send.
- Rate-limit `poll`/`status` per key (we already have
  `src/shared/db/api-key-attempts.ts` patterns and `src/shared/limits.ts`).
- Audit via existing `last_used`/`last_seen` and the named-key UI.

## Effort estimate

| Piece | Effort | Notes |
| ----- | ------ | ----- |
| `sms_outbox` (+`sms_devices`) tables + migration | Low | Existing db-module pattern |
| Scoped `sms_device` key type + auth policy | Low–Med | Touches `api-keys.ts`, `auth.ts`, admin UI |
| `/api/sms/{poll,status,heartbeat}` routes | Low | CRUD + atomic claim |
| Admin UI: "send SMS", gateway status, device-key management | Med | New templates + actions |
| Minimal Kotlin app (poll loop + SmsManager send) | Med | ~Few hundred LOC, adapt textbee send code |
| Android CI job + signing + release wiring | Med | New toolchain in CI |
| Play Store `SEND_SMS` review | Optional/High | Avoid by side-loading |

Nothing here is blocked. The server side reuses our stack almost wholesale; the
only genuinely new surface is the Kotlin app and its CI, which is the smallest
possible Android footprint that does the job.

## Phasing

1. **Server spike** — `sms_outbox` table + `poll`/`status` routes + scoped key,
   driven by `curl` standing in for the phone. Proves the protocol end-to-end
   with zero Android work.
2. **Admin UX** — "send SMS to this booking/attendee", outbox view, device-key
   management page, gateway-online indicator.
3. **The APK** — minimal Kotlin app + signing + CI job + in-app setup.
4. **(Later, optional)** inbound SMS (`sms_inbox` + receive endpoint),
   multi-SIM, delivery-receipt surfacing in the UI.

## Open questions

- **Scope storage**: `scope` column on `api_keys` vs a separate
  `sms_device_keys` table. (Recommend: column — least churn.)
- **Poll cadence vs latency/battery**: default interval (e.g. 10–30s while the
  service is foregrounded) and whether to expose it in setup.
- **App home**: in-repo `android/` subdir (build-time host pinning, single repo)
  vs separate repo (cleaner toolchain split). Recommend in-repo subdir.
- **Distribution**: side-load signed APK only, or also pursue Play Store
  (triggers `SEND_SMS` policy review).
