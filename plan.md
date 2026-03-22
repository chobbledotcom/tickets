# Gate admin behind migration + simplify PII decryption

## Context

The codebase has dual-path decryption (pre-migration individual fields vs post-migration pii_blob). Since PII is only ever read from admin pages (it's write-only for public routes), we can gate admin access behind migration completion and remove the legacy read path entirely.

## Changes

### 1. Gate admin access behind migration in `routeAdmin` (`src/routes/admin/index.ts`)

In `routeAdmin`, after auth check, check `isAttendeeBlobMigrated()`. If not migrated, only allow `/admin/migrate` and auth routes (`/admin`, `/admin/login`, `/admin/logout`) through — redirect everything else to `/admin/migrate`.

### 2. Extract migration guard helper in `src/routes/admin/migrate.ts`

Create a curried `whenNotMigrated` helper that checks `isAttendeeBlobMigrated()` and returns an "already done" response if migrated, otherwise calls through. Both GET and POST handlers use this to eliminate the duplicated guard.

### 3. Remove pre-migration read path from `decryptAttendeeFields` (`src/lib/db/attendees.ts`)

Since admin is gated behind migration, `decryptAttendeeFields` only sees rows with `pii_blob`. Remove:
- The entire pre-migration branch (lines 152-199)
- `decryptField` helper (line 115)
- `decryptBoolField` helper (line 108)
- The `activeFields` parameter (blob decryption gets all fields for free)

### 4. Simplify `getActiveEventStats` (`src/lib/db/attendees.ts`)

Remove the pre-migration branch that decrypts `price_paid`. Always read from `price_paid_v2`.

### 5. Simplify `decryptAttendeesForTable` → collapse with `decryptAttendees`

With blob decryption, selective field skipping is pointless (single decrypt gives all fields). Remove `DecryptMode` and `decryptAttendeesForTable`, use `decryptAttendees` everywhere.

### 6. Keep legacy columns and write path

Continue writing to both old encrypted columns AND new blob/v2 columns on insert. Columns stay as disaster recovery fallback. Only the **read** path is simplified.

### 7. Update tests

- Remove/update tests exercising pre-migration read paths
- Add tests for the admin gating logic
- Ensure 100% coverage
