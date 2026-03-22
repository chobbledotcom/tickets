# Gate admin behind migration + simplify PII decryption

## What was done

### 1. Gate admin access behind migration (`src/routes/admin/index.ts`)

`routeAdmin` now checks `isAttendeeBlobMigrated()` for authenticated sessions.
If not migrated, all routes except `/admin`, `/admin/login`, `/admin/logout`, and
`/admin/migrate` redirect to `/admin/migrate`.

### 2. Curried migration guard (`src/routes/admin/migrate.ts`)

Extracted `whenNotMigrated(doneResponse)(handler)` — a curried helper that checks
migration status and returns `doneResponse` if already complete. Used by both GET
and POST handlers.

### 3. Removed pre-migration read path (`src/lib/db/attendees.ts`)

Deleted:
- `encryptContactFields` — no longer writes to individual encrypted columns
- `decryptBoolField` — only used by pre-migration path
- `decryptField` — only used by pre-migration path
- Pre-migration branch in `decryptAttendeeFields`
- `decryptAttendeesForTable` and `DecryptMode` concept
- `activeFields` parameter from `decryptAttendeeFields`

`decryptAttendeeFields` now only reads from `pii_blob` + v2 columns.

### 4. Stopped writing to legacy columns

- `encryptAttendeeFields` now only produces `pii_blob` + `ticket_token_index`
- INSERT only writes: `event_id`, `created`, `quantity`, `ticket_token_index`,
  `date`, `pii_blob`, `checked_in_v2`, `refunded_v2`, `price_paid_v2`
- Legacy columns get their DEFAULT values (empty strings / zeros)
- `updateAttendee` only writes `pii_blob`, `event_id`, `quantity`
- `markRefunded` / `updateCheckedIn` only write v2 integer columns
- `updateEncryptedField` replaced with simpler `updateV2Field`

### 5. Simplified `getActiveEventStats`

Always reads `price_paid_v2` directly. Removed `isAttendeeBlobMigrated` branch
and `decrypt(price_paid)` path.

### 6. Removed dashboard migration banner

The banner in `adminDashboardPage` is unnecessary since admin is now gated.
Removed `migrationNeeded` parameter and the banner markup.

### 7. Updated callers

- `calendar.ts`, `groups.ts` — replaced `decryptAttendeesForTable` with
  `decryptAttendees(rows, pk, paidEvent)`
- `events.ts` — removed `DecryptMode` import and `"table"` argument
- `utils.ts` — removed `DecryptMode`, simplified `withDecryptedAttendees` and
  `withEventAttendeesAuth`

### 8. Test updates

- `createTestDbWithSetup` now calls `setAttendeeBlobMigrated()` so admin routes
  work in tests
- `migrate.test.ts` clears the flag in `beforeEach` to test un-migrated state
- Removed `decryptAttendeesForTable` test block from `db.test.ts`
- Added admin gating tests (redirect when not migrated, allow after migration)

### What's preserved

- Legacy columns remain in the schema (disaster recovery)
- `migrateAttendeeBatch` still reads/decrypts individual fields for migration
- `decrypt` import kept for `migrateAttendeeBatch` price_paid decryption
