# CRM-lite: privacy-preserving repeat-customer recognition

A design spec for approximating CRM functionality (repeat-customer recognition,
loyalty discounts, contact history) **without** turning each instance into a
permanent database of everyone who ever booked, and without incentivising
hirers to retain attendee PII forever.

Status: **proposal / not yet implemented.** This document is the plan.

---

## 1. Goals and non-goals

### Goals

- Recognise a returning customer **when they book again** and reward them
  (e.g. an automatic "welcome back" discount), reusing the new price-modifiers
  engine.
- Keep a compact, prunable record of "have we seen / contacted this contact
  before, how often, and when" — keyed only by an irreversible hash.
- Generalise the existing email-only mechanism to be **channel-agnostic**
  (email *and* SMS) before the in-progress SMS work forks a parallel structure.
- Bound table growth with TTL pruning and a right-to-erasure path.

### Non-goals (by design)

- **No customer directory.** We never store a list of customers you can browse,
  search by name, or export with contact details from the CRM-lite table.
- **No re-marketing to deleted attendees.** Once an attendee's PII is gone, the
  hash is one-way and we no longer hold their address — we *cannot* contact them
  again. That is the privacy guarantee, not a limitation to engineer around.
- **No replacement for a real CRM.** Hirers who want a permanent customer
  database should push to an external system they own (see §9); this keeps that
  liability an explicit, opt-in choice rather than a silent default.

### The boundary that shapes everything

`hashEmail` / `hmacHash` give us **recognition-on-presentation, not
enumeration**. We can answer "have I seen *this* identifier before?" only when
the customer hands it to us again at booking. We can never list past customers
or reach a deleted one. Every feature below lives inside that boundary.

---

## 2. What already exists

| Piece | File | Notes |
| --- | --- | --- |
| HMAC blind index | `src/shared/crypto/hashing.ts` (`hmacHash`) | HMAC-SHA256 keyed off `DB_ENCRYPTION_KEY` |
| Email hashing | `src/shared/db/email-preferences.ts` (`hashEmail`) | `hmacHash(email.trim().toLowerCase())` |
| Per-email row | `email_preferences` table | `email_hash` PK, plaintext `unsubscribed`, encrypted `stats_blob = {c,t,s}` |
| Owner-keypair crypto | `src/shared/crypto/keys.ts` | `encryptWithOwnerKey` (public, keyless) / `decryptWithOwnerKey` (private, admin only) |
| Phone normalisation | `src/shared/phone.ts` (`normalizePhone`) | `→ +{prefix}{local}` (E.164-ish) — ready to hash |
| Price modifiers | `src/shared/price-modifier.ts`, `src/shared/db/modifiers.ts`, `modifier-resolve.ts` | `trigger`, `code_index` (HMAC of a promo code), `scope`, `stock`, `min_subtotal` |
| Modifier resolution | `resolveModifiers(items)` | filters `automatic` modifiers by scope / `min_subtotal` / `stock` |
| Pruning framework | `src/shared/db/prune.ts` | `PRUNE_TASKS`, `isoAgePruner`, per-table `last_pruned_*` |

`email_preferences` is **already** the privacy-preserving primitive we want — it
just needs to become channel-agnostic, gain a keyless visit counter, and be
pruned. The modifiers engine already HMAC-indexes a gating value (`code_index`)
and gates on a threshold (`min_subtotal`), so a visit threshold is the same
shape of change.

---

## 3. Data model: `contact_preferences`

Generalise `email_preferences` into one channel-agnostic table. One row per
contact identity, keyed by an irreversible hash.

```
contact_preferences
  contact_hash   TEXT PRIMARY KEY    -- HMAC-SHA256, see §3.1
  last_activity  INTEGER NOT NULL     -- ms-epoch; bumped on booking & outreach; PRUNE key
  unsubscribed   INTEGER NOT NULL DEFAULT 0   -- plaintext opt-out (keyless /unsubscribe)
  visits         INTEGER NOT NULL DEFAULT 0   -- plaintext booking count (keyless modifier gate, §6)
  stats_blob     TEXT NOT NULL DEFAULT ''     -- owner-keypair-encrypted JSON, §3.3
```

No `channel` column: the channel is encoded in the **hash prefix** (§3.1), so
lookups already know it and a DB reader cannot tell which rows are email vs SMS —
one less piece of metadata at rest. No `created` column either: pruning keys off
`last_activity`, and "first seen" (if wanted) lives in the encrypted blob. The
migration backfills `last_activity` from the old `created` so existing
unsubscribe history survives, then drops `created`.

Indexes:

- PK on `contact_hash`.
- `idx_contact_prefs_unsubscribed` on `unsubscribed` (recipient filtering, mirrors
  `getUnsubscribedHashSet`).
- `idx_contact_prefs_last_activity` on `last_activity` (prune scans).

This is exactly the requested shape: **hashes, timestamps, and an encrypted blob
of ints/bools** — plus two plaintext operational scalars (`unsubscribed`, which
is already plaintext today, and `visits`, justified in §5).

### 3.1 Keying

Namespace the hash input by channel so an email and a phone can never collide,
and so one table cleanly holds both:

```ts
const contactHash = (channel: "email" | "sms", id: string) =>
  hmacHash(`${channel}:${normalizeFor(channel, id)}`);
//   email → email.trim().toLowerCase()
//   sms   → normalizePhone(phone, settings.countryDiallingCode)
```

The HMAC key is the existing `DB_ENCRYPTION_KEY`-derived HMAC key, so the hash is
deterministic within an instance and useless across instances or without the
env key.

### 3.2 Plaintext fields — what's safe to leave readable

Only values the **keyless public path** must read live in plaintext:

- `unsubscribed` — the public `/unsubscribe` page toggles it without a key
  (unchanged from today).
- `last_activity` — the fire-and-forget prune context has no private key, so it
  must prune on a plaintext timestamp (same reason sessions/logins do).
- `visits` — the public checkout must read it to apply a returning-customer
  modifier (§5, §6).

All three are non-identifying scalars against a one-way hash: no name, no
address, not reversible, not enumerable to a person.

### 3.3 Encrypted blob (`stats_blob`)

Everything behavioural/sensitive stays encrypted with the owner's public key and
is readable only in an authenticated admin session (`decryptWithOwnerKey`).
Because each row is **single-channel** (email and SMS hash to different rows), the
blob keeps today's exact `{c,t,s}` shape — the `c` counter is naturally "emails
sent" for an email row and "SMS sent" for an SMS row, with no per-channel split:

```jsonc
{
  "c": 3,                   // sends on this row's channel
  "t": "2026-01-04T...",   // last send (ISO)
  "s": "Summer sale"        // last subject
}
```

(`visits` — bookings, customer→us — is the separate plaintext counter; `c` here
is outreach, us→customer.)

Note the split of concerns:

- **Customer → us** (a booking): bump plaintext `visits` + `last_activity`.
  Keyless, so it **cannot** touch the encrypted blob (no private key on the
  public path).
- **Us → customer** (an email/SMS send): update the encrypted blob (counts, last
  subject) via the admin path that already holds the private key — this is the
  generalised `recordContacts`.

---

## 4. The one real design decision: keyless gate readability

A returning-customer discount has to be decided at **checkout, which is keyless**
— but the rich counters are encrypted and only an admin session can read them.
So the value that gates an automatic public discount **must live outside the
encrypted blob.** Three ways to resolve this:

| Option | How | Privacy | Cost |
| --- | --- | --- | --- |
| **D1 — plaintext `visits` int (recommended)** | `SET visits = visits + 1` at booking (keyless); modifier reads it | An int per opaque hash — same class as `unsubscribed`/`last_activity`; no identity | Smallest change; fully automatic |
| **D2 — customer-held signed token** | After 1st booking, issue a signed "returning" token (cookie/email link) via `signed-token.ts`; unlock the discount through the existing `code` trigger | Nothing readable server-side; counts can stay fully encrypted | Customer must present it; cleared cookie = lost recognition |
| **D3 — admin-only recognition** | Counts stay fully encrypted; "returning" is only surfaced/segmented in admin, no automatic public discount | Maximum | Loses the automatic discount |

**Recommendation: D1.** A bare visit count keyed to a one-way HMAC is not PII,
isn't reversible, and can't be enumerated to a person — it's the same privacy
class as the `unsubscribed` flag we already store in plaintext. Keep the
*sensitive* detail (spend, subjects, channel breakdown) encrypted; expose only
the coarse counter the keyless path needs. Offer D2 later as a "maximum privacy"
toggle for operators who don't want any plaintext counter.

> Generalise the rule: **any** value a public modifier gates on must be
> plaintext. Add `lifetime_spend_minor` as a second plaintext gate only if you
> actually want spend-tier discounts at keyless checkout; otherwise keep spend
> in the encrypted blob.

---

## 5. Lifecycle

### Seed + increment (booking, keyless)

Today `attendees/create.ts:227` calls
`ensureEmailPreference(await hashEmail(email))`. Replace with a channel-aware
upsert that also bumps the counter, **once per order** (not per ticket — a
multi-listing booking is one visit):

```sql
INSERT INTO contact_preferences (contact_hash, last_activity, visits)
VALUES (?, ?, 1)
ON CONFLICT(contact_hash) DO UPDATE
  SET visits = visits + 1, last_activity = excluded.last_activity;
```

Seed a row for both the email **and** (when present) the phone, so SMS-only
recognition works too. Keyless: touches only plaintext columns, never the blob.

### Outreach update (admin send, has private key)

Generalise `recordContacts` to update the encrypted blob (bump `c`, set last
subject `s`, set `t` and `last_activity`) for each recipient hash — unchanged in spirit,
just channel-aware and writing to `contact_preferences`.

### Unsubscribe (keyless)

Unchanged behaviour: `/unsubscribe` toggles the plaintext `unsubscribed` flag by
hash. Generalise so an SMS STOP keyword can flip the same flag for a phone hash.

---

## 6. Modifiers integration (the repeat-visitor tie-in)

The marquee feature: an **automatic returning-customer discount**, expressed as
an ordinary price modifier.

### Schema

Add one column to `modifiers`, a sibling to the existing `min_subtotal`:

```
modifiers.min_visits  INTEGER NOT NULL DEFAULT 0
```

A modifier with `min_visits = 0` behaves exactly as today. `min_visits = 1`
means "only for someone we've seen at least once before."

### Resolution

`resolveModifiers` currently takes only the cart `items`. Thread a small context
carrying the buyer's visit count (looked up keyless by hashing the email/phone
entered on the form):

```ts
type PricingContext = { visits: number };   // 0 when unknown / first-time

export const resolveModifiers = async (
  items: CheckoutItem[],
  ctx: PricingContext,
): Promise<ModifierSpec[]> => {
  const automatic = (await getActiveModifiers())
    .filter((m) => m.trigger === "automatic")
    .filter((m) => ctx.visits >= m.min_visits);   // ← new gate, mirrors min_subtotal
  // ...existing scope / min_subtotal / stock filtering unchanged...
};
```

The visit lookup is a single keyless read:

```ts
const visitsFor = async (email?: string, phone?: string): Promise<number> => {
  const hashes = compact([
    email && contactHash("email", email),
    phone && contactHash("sms", phone),
  ]);
  // max visits across the buyer's identifiers
  return maxVisits(await Promise.all(hashes.map(readVisits)));
};
```

### Anti-spoofing

`min_subtotal` is already re-checked server-side in the webhook
(`specsFromRefs` / re-resolution) so provider metadata is never trusted. Do the
same for `min_visits`: **re-read `visits` server-side** when rebuilding specs in
the webhook, so a crafted checkout can't claim returning status. If the
re-resolved total disagrees, the existing mismatch-refund path covers it.

### Example modifiers this unlocks

- **Welcome back** — `trigger=automatic`, `direction=discount`, `calc=percent 10`,
  `min_visits=1`, `scope=all`.
- **Loyalty tier** — `min_visits=5` for a bigger discount (stacks naturally via
  the existing pipeline).
- **First-timer promo** — the inverse isn't expressible with `min_visits` alone;
  if wanted, add a `max_visits` companion later.

### Nice consequence

Because `visits` resets when a stale `contact_preferences` row is pruned (§7),
"returning" status is **recency-bounded**: someone who hasn't booked in the
retention window is treated as new again. That is both privacy-positive and a
reasonable loyalty policy.

---

## 7. Growth control

### TTL prune (new prune task)

Add a `contact_preferences` pruner to the existing framework in `prune.ts`:

```ts
export const pruneContacts = async (): Promise<number> => {
  const cutoffMs = nowMs() - PRUNE_CONTACTS_RETENTION_MS;
  const result = await getDb().execute({
    args: [cutoffMs],
    sql: "DELETE FROM contact_preferences WHERE last_activity < ?",
  });
  return result.rowsAffected;
};
```

- Add `PRUNE_CONTACTS_RETENTION_MS` to `limits.ts` (default e.g. 18–24 months,
  `DAY_MS`-based like the others) and a `last_pruned_contacts` setting.
- Register it in `PRUNE_TASKS` alongside the rest.
- Optionally two-tier: prune `unsubscribed = 1` rows sooner (you only need to
  honour suppression while you might still contact them).

### Right-to-erasure

A tiny admin (or keyless, given the address) action: hash the supplied
email/phone, `DELETE FROM contact_preferences WHERE contact_hash = ?`. Cheap
GDPR "forget me".

### Forget-on-unsubscribe (optional)

When someone unsubscribes, blank `stats_blob` and keep only the suppression flag
— maximal data minimisation.

### Attendee-PII auto-expiry (the strong move, separate work)

The deeper privacy win is to also expire the **attendee** PII a configurable
window after the event, so the primary PII store self-empties and
`contact_preferences` is the only (opaque) residue. Out of scope here but pairs
naturally — track separately.

---

## 8. SMS tie-in (do this now)

The in-progress SMS work should write to `contact_preferences` from day one
rather than cloning a phone-only table:

- Hash phones with `contactHash("sms", phone)` using the existing
  `normalizePhone`.
- Record SMS sends through the generalised `recordContacts` — same `{c,t,s}`
  blob, just on the SMS-hashed row (each row is single-channel).
- Honour the shared `unsubscribed` flag for STOP handling.
- Loyalty/`min_visits` then works identically whether the buyer gave an email, a
  phone, or both.

Generalising the table is the cheapest moment **before** SMS hardcodes a parallel
structure.

---

## 9. External CRM (push model) — brief

For hirers who genuinely want a permanent customer database, push out rather than
hoard in:

- **C1 — existing webhook (works today).** The per-booking registration webhook
  already carries name/email/phone/address/amount/tickets. Point it at a small
  adapter (n8n/Make or a serverless fn) that upserts a Contact + logs the
  booking. Document this as the recommended path — zero new code, hirer owns the
  connector and its GDPR duties.
- **C2 — first-class connector (future).** Typed integration in admin settings
  (CRM type + base URL + encrypted API key + field mapping). Easiest targets:
  **EspoCRM** (simple API-key REST) and **CiviCRM** (APIv4; fits the Chobble CIC
  ethos); **SuiteCRM** is doable but its v8 OAuth2 + JSON:API is the heaviest.
- **C3 — standards export.** vCard/CSV export any CRM can import — a small
  extension of the existing CSV/ICS/RSS machinery, no per-CRM auth.

This keeps the long-term "remember everyone" decision explicit and hirer-owned,
which is the whole point.

---

## 10. Testing notes (100% coverage expected)

- **Hashing**: `contactHash` is deterministic, channel-namespaced (email vs sms
  of the "same" string differ), and case/whitespace-insensitive for email.
- **Keyless increment**: booking bumps `visits` + `last_activity` without a
  private key; a multi-listing order increments **once**.
- **Encrypted blob**: write with public key on outreach, read with private key in
  admin; unsubscribe state survives a blob rewrite (regression already implicit
  in current `recordContacts`).
- **Modifier gating**: `min_visits` filters correctly at resolve time; webhook
  re-read prevents spoofing; total-mismatch refund fires when a claimed discount
  doesn't re-resolve.
- **Prune**: rows older than the cutoff go, newer rows stay; boundary at exactly
  the cutoff.
- **Erasure**: deletes only the targeted hash.

---

## 11. Open decisions for review

1. **D1 vs D2** for the keyless gate (§4) — recommend D1 (plaintext `visits`),
   with D2 as a later opt-in.
2. **Migrate-in-place vs additive** — rename/extend `email_preferences →
   contact_preferences` (precedent: the event→listing rename) vs add a new table
   and dual-write. Recommend rename/extend; the table is new (2026-06-14) with
   little production data, and the system auto-migrates.
3. **Spend tiers?** — only add `lifetime_spend_minor` as a second plaintext gate
   if spend-based discounts at keyless checkout are actually wanted.
4. **Retention window** default for `PRUNE_CONTACTS_RETENTION_MS`.

---

## 12. Phased plan

1. **Generalise the table** — `email_preferences → contact_preferences`
   (migration + rename refs), add `last_activity` + `visits`, backfill
   `last_activity` from `created` then drop `created`; keep
   `unsubscribed`/`stats_blob`. Channel lives in the hash prefix, not a column.
   Update `LATEST_UPDATE`.
2. **Keyless visit counter** — bump `visits`/`last_activity` at booking for email
   and phone; once per order.
3. **Modifiers gate** — add `modifiers.min_visits`; thread `PricingContext` into
   `resolveModifiers` + webhook re-resolution; admin UI field next to
   `min_subtotal`.
4. **Pruning + erasure** — `pruneContacts`, `PRUNE_CONTACTS_RETENTION_MS`,
   `last_pruned_contacts`, erasure action.
5. **SMS** — route the in-progress SMS work through `contact_preferences`.
6. **Docs / external CRM** — document the C1 webhook→CRM recipe; consider C2/C3
   later.

Steps 1–3 deliver the headline feature (automatic returning-customer discount);
4 keeps it bounded; 5 unifies channels; 6 is the escape hatch for hirers who want
a real CRM.
