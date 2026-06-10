# Plan: Encrypt SumUp checkout staging metadata at rest

## Problem

`sumup_checkouts.metadata` currently stores booking metadata — including PII
(name, email, phone, address, special instructions) — as **plaintext JSON** in
our database. Every other PII store in this app is encrypted (`attendees.pii_blob`
via public-key hybrid encryption, `processed_payments.ticket_tokens` via the DB
key). This table is the only place attendee PII would sit readable at rest.

The table exists because SumUp checkouts cannot carry arbitrary metadata
(unlike Stripe sessions / Square orders), so we stage the booking intent
locally between checkout creation and payment completion.

## Why the `pii_blob` password-gated pattern cannot apply

`pii_blob` works because the webhook is only ever a **writer** of attendee PII:
encryption uses the public key (no auth), decryption requires the private key
(password → KEK → data key → private key). The SumUp staging row is the
opposite: the **passwordless webhook is the reader**. It must reconstruct the
booking intent to:

1. build the `pii_blob` bundle (which packs PII together with `payment_id` —
   the SumUp transaction id that doesn't exist until payment completes — and
   the ticket token into one encrypted blob);
2. send the confirmation email (plaintext email + name);
3. fire the event-level `webhook_url` notification (POSTs name, email, phone).

Any key the passwordless webhook can use is by definition not password-gated.
This matches the existing Stripe/Square trust model, where the same PII rests
at the *provider*, readable at webhook time with just the API key. The password
gate has always begun at attendee creation; it still does.

## Design: reference-derived encryption (no decryption material at rest)

The checkout reference is a `crypto.randomUUID()` (122 bits of entropy) that we
generate and hand to SumUp. After this change, **the plaintext reference never
rests in our database** — it arrives at runtime from outside:

- the redirect URL (`/payment/success?session_id=<reference>`), or
- SumUp's API (`checkout_reference` on the fetched checkout, during webhooks).

### New row shape

| column            | content                                                       |
| ----------------- | ------------------------------------------------------------- |
| `reference_index` | `hmacHash(reference)` — PRIMARY KEY (lookup only, not invertible) |
| `wrapped_key`     | fresh AES data key, wrapped via `wrapKeyWithToken(dataKey, reference)` |
| `metadata`        | `encryptWithKey(JSON.stringify(metadata), dataKey)`           |
| `created_at`      | ISO timestamp (prune key, unchanged)                          |

### Write path — `storeSumupCheckout(reference, metadata)`

1. `dataKey = await generateDataKey()`
2. `wrapped = await wrapKeyWithToken(dataKey, reference)`
3. `ciphertext = await encryptWithKey(JSON.stringify(metadata), dataKey)`
4. `index = await hmacHash(reference)`
5. INSERT `(reference_index, wrapped_key, metadata, created_at)`

### Read path — `getSumupCheckoutMetadata(reference)`

1. `index = await hmacHash(reference)` → SELECT; missing row → `null`
   (unknown checkout — same semantics as today)
2. `dataKey = await unwrapKeyWithToken(row.wrapped_key, reference)`
3. `JSON.parse(await decryptWithKey(row.metadata, dataKey))`

Unwrap/decrypt failures on a row that *was* found indicate corruption and are
allowed to throw — consistent with `parseBookingItems`' deliberate
throw-on-corruption policy. (A wrong reference cannot reach decryption: the
HMAC lookup misses first.)

All primitives already exist and are battle-tested in this codebase:
- `hmacHash` — same pattern as `ticket_token_index`, `username_index`, `slug_index`
- `generateDataKey` / `wrapKeyWithToken` / `unwrapKeyWithToken` — exactly how
  sessions wrap the user data key with the session token (`deriveTokenKey` is
  PBKDF2(1 iter) over a high-entropy token, salted with `DB_ENCRYPTION_KEY`,
  so the env key is *necessary but not sufficient* to unwrap)
- `encryptWithKey` / `decryptWithKey` — how the RSA private key is stored

**Zero new cryptography is introduced.**

## Shrink the window: dedicated 24h prune retention

Currently `sumup_checkouts` rows prune on `PRUNE_PAYMENTS_RETENTION_MS`
(7 days). Nothing legitimate needs a staging row that long:

- SumUp hosted checkouts expire after **30 minutes**
- SumUp webhook retries max out at **2 hours** (1m → 5m → 20m → 2h)
- the success redirect happens immediately after payment

New: `PRUNE_SUMUP_RETENTION_HOURS` (default **24**, env-overridable via the
existing `readLimit` mechanism, with an entry in the documented limits
registry) and `PRUNE_SUMUP_RETENTION_MS`. `pruneSumupCheckouts` switches to it.

Note on the true upper bound: prune sweeps run on `PRUNE_INTERVAL_HOURS` (24h),
so a row's actual lifetime is ≤ retention + one sweep interval ≈ **48h worst
case** — versus indefinite PII-at-provider for Stripe/Square. Acceptable.

## Considered and rejected: delete-on-finalize

I previously suggested deleting the staging row immediately after the attendee
is finalized. Race analysis kills it:

- **Webhook wins, deletes row → redirect loses.** The user lands on
  `/payment/success?session_id=<ref>`; `validatePaidSession` →
  `retrieveSession` → metadata gone → **"Payment session not found"** error
  page for a customer who just paid. The already-processed recovery branch
  (`handleReservationConflict` → `alreadyProcessedResult`) is only reachable
  *after* metadata extraction succeeds, so deleting the row breaks the loser
  of the race. The same applies to back-button revisits of the redirect URL.

Deleting on redirect-consumption instead has the mirror-image problem plus
worse back-button behaviour. The 24h prune achieves nearly all of the benefit
with zero race or UX risk, so prune-only is the design.

## Honest threat model (what this does and doesn't achieve)

| Attacker has…                     | Outcome                                                        |
| --------------------------------- | -------------------------------------------------------------- |
| DB dump alone                     | Nothing: HMAC index + ciphertext + wrapped key, no references  |
| DB + `DB_ENCRYPTION_KEY`          | Cannot decrypt rows directly (needs per-row reference). Can decrypt the stored SumUp API key, query SumUp's API for `checkout_reference`s, and then decrypt — i.e. PII is recoverable **only via the payment provider**, which is exactly the Stripe/Square posture (their PII sits at the provider, API-key-readable). |
| DB + env, post-payment window     | `processed_payments.payment_session_id` holds the plaintext reference after processing (provider-agnostic idempotency table). For ≤24h it may coexist with the staging ciphertext. Equivalent to the row above in practice; noted for completeness, not mitigated (the same attacker already has the SumUp API route). |
| User's password                   | Not required for this table and never will be — see "why pii_blob cannot apply". The password gate begins at attendee creation, as it does for every provider. |

## File-by-file changes

1. **`src/shared/limits.ts`** — add `PRUNE_SUMUP_RETENTION_HOURS`
   (`readLimit`, default 24), `PRUNE_SUMUP_RETENTION_MS`, and the limits-
   registry entry alongside the existing `PRUNE_*` entries.
2. **`src/shared/db/migrations.ts`** — redefine the `sumup_checkouts` table:
   `reference_index TEXT PRIMARY KEY`, `wrapped_key TEXT NOT NULL DEFAULT ''`,
   `metadata TEXT NOT NULL`, `created_at TEXT NOT NULL`. Bump `LATEST_UPDATE`.
   The table has never shipped (this PR is unmerged), so no data migration is
   needed; the `DEFAULT ''` is cheap insurance so `ADD COLUMN` self-heals any
   dev DB that ran the earlier branch revision (SQLite cannot `ADD COLUMN`
   `NOT NULL` without a default, and cannot add a PK column — stale rows
   become unreachable and age out via prune).
3. **`src/shared/db/sumup-checkouts.ts`** — rewrite `storeSumupCheckout` /
   `getSumupCheckoutMetadata` per the write/read paths above. Public API
   (signatures, null semantics) unchanged, so `sumup.ts` and
   `sumup-provider.ts` need no changes.
4. **`src/shared/db/prune.ts`** — `pruneSumupCheckouts` switches to
   `PRUNE_SUMUP_RETENTION_MS`.
5. **`plan.md`** — this document (committed first; can be deleted on merge).

## Test plan

1. **New `test/lib/db/sumup-checkouts.test.ts`** (behavior-level, per test
   quality standards):
   - round-trip: store → get returns the exact metadata object
   - unknown reference → `null`
   - **at-rest assertions** (the point of the change): raw-SELECT the row and
     assert the stored `metadata` does not contain the plaintext email/name,
     no column contains the plaintext reference, and `reference_index` ≠
     reference
   - two rows with different references don't interfere (index isolation)
2. **`test/lib/db/prune.test.ts`** — update the `insertSumupCheckout` helper
   to the new columns; retention assertions move to
   `PRUNE_SUMUP_RETENTION_MS` (import from production, no magic numbers).
3. **Existing SumUp tests** — `sumup.test.ts` and `sumup-provider.test.ts`
   exercise `storeSumupCheckout`/`getSumupCheckoutMetadata` through their
   public API only, so they should pass unchanged — a good refactor signal.
4. Full gate: `deno task typecheck && deno task lint && deno task cpd &&
   deno task build:edge && deno task test:coverage` (100% line + branch).

## Rollout

None required: the table is pre-release, rows are transient (≤48h), and the
public module API is unchanged.
