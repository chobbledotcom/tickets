# Database Upgrade: Attendee Storage Optimization

## Problem

Each attendee row uses ~4.3 KB due to hybrid encryption (RSA-2048 + AES-256-GCM) on every field. The hybrid envelope alone adds ~392 bytes per field (344 bytes for the RSA-wrapped AES key + IV + prefix), repeated across 9 fields per row. This limits a 1 GB database to ~200,000 attendee records.

The biggest waste:
- `checked_in` and `refunded` store "true"/"false" (~5 bytes) in ~404 bytes each
- `price_paid` uses symmetric encryption (~51 bytes) for a simple integer
- 5 PII fields each carry their own ~370-byte RSA-wrapped key overhead

## Solution

1. **Bundle all PII** (name, email, phone, address, special_instructions, payment_id, ticket_token) into a single hybrid-encrypted JSON blob → one RSA envelope instead of seven
2. **Convert `checked_in` and `refunded`** to plaintext integer columns (0/1)
3. **Convert `price_paid`** to a plaintext integer column (minor currency units)

### Storage Impact

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| PII fields | 7 × ~410 bytes = ~2,870 bytes | 1 × ~750 bytes | -2,120 bytes |
| checked_in | ~404 bytes (hybrid) | 1 byte (integer) | -403 bytes |
| refunded | ~404 bytes (hybrid) | 1 byte (integer) | -403 bytes |
| price_paid | ~51 bytes (symmetric) | 4 bytes (integer) | -47 bytes |
| **Total per row** | **~4,350 bytes** | **~1,400 bytes** | **-2,950 bytes (~68%)** |
| **Attendees per 1 GB** | **~200,000** | **~600,000** | **~3x capacity** |

## Migration Strategy

This is an **admin-initiated migration** because the data is encrypted with the admin's RSA private key, which is only available during an authenticated admin session.

### Phase 1: Schema Changes (automatic, in `migrations.ts`)

Add new columns alongside old ones. No data is touched.

```sql
-- New blob column for consolidated PII
ALTER TABLE attendees ADD COLUMN pii_blob TEXT NOT NULL DEFAULT '';

-- New plaintext columns for non-PII status fields
ALTER TABLE attendees ADD COLUMN checked_in_v2 INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attendees ADD COLUMN refunded_v2 INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attendees ADD COLUMN price_paid_v2 INTEGER NOT NULL DEFAULT 0;
```

Add a setting to track migration status:

```sql
INSERT OR IGNORE INTO settings (key, value) VALUES ('attendee_blob_migrated', '');
```

When `attendee_blob_migrated` is empty, the migration has not been performed.

### Phase 2: Admin-Initiated Migration (new `/admin/migrate` page)

#### Entry Point

When `attendee_blob_migrated` is empty, the admin dashboard shows a banner linking to `/admin/migrate`. This page explains the restructuring and provides a "Start Migration" button.

#### Migration Process

The migration endpoint processes attendees in chunks:

1. **SELECT** a batch of attendees (e.g., 50) where `pii_blob = ''`
2. For each attendee in the batch:
   a. **Decrypt** all hybrid-encrypted fields using the admin's private key:
      - `name`, `email`, `phone`, `address`, `special_instructions`, `payment_id`, `ticket_token`
      - `checked_in`, `refunded` (to get boolean values)
   b. **Decrypt** `price_paid` using symmetric decryption
   c. **Build JSON blob** from the PII fields:
      ```json
      {
        "n": "Alice Smith",
        "e": "alice@example.com",
        "p": "+1-555-0123",
        "a": "123 Main St",
        "s": "Vegetarian",
        "pi": "pi_1A2B3C4D",
        "t": "a1b2c3d4e5"
      }
      ```
   d. **Hybrid-encrypt** the JSON blob with the public key
   e. **UPDATE** the row:
      ```sql
      UPDATE attendees
      SET pii_blob = ?,
          checked_in_v2 = ?,
          refunded_v2 = ?,
          price_paid_v2 = ?
      WHERE id = ?
      ```
3. **Return progress** to the browser (e.g., "migrated 50/1200 attendees")
4. The page auto-continues with the next batch via fetch until all rows are processed
5. When no more rows have `pii_blob = ''`, write `attendee_blob_migrated` setting to current ISO timestamp

#### Blob JSON Keys

Short keys to minimize encrypted payload size:

| Key | Field |
|-----|-------|
| `n` | name |
| `e` | email |
| `p` | phone |
| `a` | address |
| `s` | special_instructions |
| `pi` | payment_id |
| `t` | ticket_token |

#### Error Handling

- If a batch fails, the migration stops and shows the error. Already-migrated rows are safe (they have `pii_blob` filled).
- The migration is idempotent: re-running skips rows that already have `pii_blob` set.
- Old columns are never cleared during this phase — they serve as a backup.

### Phase 3: Code Reads from New Columns

Once `attendee_blob_migrated` is set:

#### Reading Attendees (`decryptAttendeeFields`)

- Decrypt `pii_blob` (single hybrid decryption) and parse the JSON to extract name, email, phone, address, special_instructions, payment_id, ticket_token
- Read `checked_in_v2`, `refunded_v2`, `price_paid_v2` directly as integers
- Fall back to old columns if `pii_blob` is empty (handles any edge cases)

#### Writing Attendees (`createAttendeeAtomic`, `updateAttendee`)

- Build JSON blob from contact fields, hybrid-encrypt once, write to `pii_blob`
- Write `checked_in_v2` as 0, `refunded_v2` as 0, `price_paid_v2` as integer
- Also write old columns for backward compatibility during rollout

#### Updating Status Fields

- `updateCheckedIn`: writes integer to `checked_in_v2` (no encryption needed)
- `markRefunded`: writes integer to `refunded_v2` (no encryption needed)

### Phase 4: Drop Old Columns (future, after all sites migrated)

A later release (weeks after Phase 3 is deployed) removes the legacy columns:

```sql
-- These are destructive and only run after confirming migration is complete
ALTER TABLE attendees DROP COLUMN name;
ALTER TABLE attendees DROP COLUMN email;
ALTER TABLE attendees DROP COLUMN phone;
ALTER TABLE attendees DROP COLUMN address;
ALTER TABLE attendees DROP COLUMN special_instructions;
ALTER TABLE attendees DROP COLUMN payment_id;
ALTER TABLE attendees DROP COLUMN ticket_token;
ALTER TABLE attendees DROP COLUMN checked_in;
ALTER TABLE attendees DROP COLUMN refunded;
ALTER TABLE attendees DROP COLUMN price_paid;
```

**Note:** SQLite supports `DROP COLUMN` as of version 3.35.0 (2021-03-12). Verify the libsql version supports this before proceeding.

## Implementation Checklist

### Phase 1 — Schema
- [ ] Add `pii_blob`, `checked_in_v2`, `refunded_v2`, `price_paid_v2` columns in `migrations.ts`
- [ ] Add `attendee_blob_migrated` setting (empty = not migrated)
- [ ] Update `LATEST_UPDATE` constant

### Phase 2 — Migration Page
- [ ] Add `/admin/migrate` route (GET: info page, POST: process batch)
- [ ] Add migration template with progress UI
- [ ] Add dashboard banner when `attendee_blob_migrated` is empty
- [ ] Batch processing endpoint: decrypt old fields → build blob → encrypt blob → write new columns
- [ ] Auto-continue via client-side fetch loop until complete
- [ ] Set `attendee_blob_migrated` to timestamp when done

### Phase 3 — Read/Write from New Columns
- [ ] Update `decryptAttendeeFields` to read from `pii_blob` when populated
- [ ] Update `createAttendeeAtomic` to write `pii_blob` + new integer columns
- [ ] Update `updateAttendee` to write `pii_blob`
- [ ] Update `updateCheckedIn` to write `checked_in_v2` directly (no encryption)
- [ ] Update `markRefunded` to write `refunded_v2` directly (no encryption)
- [ ] Continue writing old columns for backward compatibility
- [ ] Update `getActiveEventStats` to read `price_paid_v2` directly (no decryption)
- [ ] Tests for all new read/write paths

### Phase 4 — Cleanup (separate future PR)
- [ ] Drop old encrypted columns
- [ ] Remove legacy read/write code paths
- [ ] Remove backward-compatibility dual writes
- [ ] Update `Attendee` type to remove legacy fields

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Migration interrupted halfway | Idempotent: skips rows with `pii_blob` already set |
| New code deployed before migration run | Falls back to old columns when `pii_blob` is empty |
| Blob decryption fails | Old columns still intact; revert `attendee_blob_migrated` setting to retry |
| Admin forgets to run migration | Dashboard banner persists until migration is complete |
| Large databases time out | Batch processing (50 rows at a time) with client-driven continuation |
