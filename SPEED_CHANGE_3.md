# SPEED_CHANGE_3 — Batch DB restore inserts with transactions

## Problem

In `createTestDbWithSetup()`, when the cached snapshot is available (which is every call after the first), the function restores ~20 settings rows and ~1 user row via individual `await getClient().execute(insert(...))` calls. Each call is a separate async operation with its own implicit SQLite transaction.

This runs in `beforeEach` for every `describeWithEnv({ db: true })` test — 126+ test suites with multiple test cases each, meaning hundreds of invocations across a full test run.

Current code (`src/test-utils/index.ts` lines 155-183):

```typescript
if (cachedSetupSettings) {
  // Clear any rows initDb() may have inserted to avoid UNIQUE conflicts
  await getClient().execute("DELETE FROM settings");
  for (const row of cachedSetupSettings) {
    await getClient().execute(
      insert("settings", {
        key: row.key,
        value: row.value,
      }),
    );
  }
  if (cachedSetupUsers) {
    for (const row of cachedSetupUsers) {
      await getClient().execute(
        insert("users", {
          admin_level: row.admin_level as InValue,
          id: row.id as InValue,
          invite_code_hash: row.invite_code_hash as InValue,
          invite_expiry: row.invite_expiry as InValue,
          password_hash: row.password_hash as InValue,
          username_hash: row.username_hash as InValue,
          username_index: row.username_index as InValue,
          wrapped_data_key: row.wrapped_data_key as InValue,
        }),
      );
    }
  }
  settings.invalidateCache();
  await settings.loadAll();
  settings.setForTest({ timezone: "UTC" });
  return;
}
```

Each `getClient().execute(...)` is an async call that yields to the event loop, starts an implicit transaction, executes the SQL, commits, and returns. With ~21 rows, that's:
- ~21 individual SQLite transactions
- ~21 async yield points
- ~21 round-trips through the libsql client layer

## Approach

### Wrap the INSERT loop in a single SQL transaction

```typescript
if (cachedSetupSettings) {
  await getClient().execute("DELETE FROM settings");
  await getClient().execute("BEGIN");
  for (const row of cachedSetupSettings) {
    await getClient().execute(
      insert("settings", {
        key: row.key,
        value: row.value,
      }),
    );
  }
  if (cachedSetupUsers) {
    for (const row of cachedSetupUsers) {
      await getClient().execute(
        insert("users", {
          admin_level: row.admin_level as InValue,
          id: row.id as InValue,
          invite_code_hash: row.invite_code_hash as InValue,
          invite_expiry: row.invite_expiry as InValue,
          password_hash: row.password_hash as InValue,
          username_hash: row.username_hash as InValue,
          username_index: row.username_index as InValue,
          wrapped_data_key: row.wrapped_data_key as InValue,
        }),
      );
    }
  }
  await getClient().execute("COMMIT");
  settings.invalidateCache();
  await settings.loadAll();
  settings.setForTest({ timezone: "UTC" });
  return;
}
```

SQLite in-memory databases fully support `BEGIN`/`COMMIT` transactions. libsql/client's `execute()` method accepts raw SQL strings for transaction statements.

By wrapping all INSERTs in a single transaction, we reduce:
- SQLite journal overhead from ~21 individual transactions to 1
- Async yield overhead from ~21 await points to 23 (BEGIN + 21 INSERTs + COMMIT)
- The overall wall time per `createTestDbWithSetup()` call

### Why not use a single multi-row INSERT?

We considered building a single `INSERT INTO settings (key, value) VALUES (...), (...), ...` statement, but this requires manual SQL escaping of values and is more fragile than the `insert()` helper which uses parameterized queries. The transaction approach is equally effective and safer since it reuses the existing `insert()` helper.

### Why not batch `settings.loadAll()` + `settings.setForTest()`?

`settings.loadAll()` is already a single SELECT query. The subsequent `settings.setForTest()` just updates the in-memory cache. These are fast and don't benefit from batching.

## Expected impact

Each `createTestDbWithSetup()` call saves ~18-20 transaction cycle overheads (BEGIN/COMMIT pairs). With 126+ `describeWithEnv({ db: true })` test suites × ~3-5 test cases each = 400-600+ invocations, the savings compound:

**Estimated savings: ~10-20 seconds** across a full test run.

The exact savings depend on:
- Number of cached settings rows (currently ~20; more rows = more savings)
- SQLite in-memory transaction overhead (~0.01ms per transaction on modern hardware)
- The overhead of additional awaits in the JS event loop

## Relationship to Changes 1 & 2

This change modifies code that will be moved to `src/test-utils/db.ts` as part of Change 1. It can be applied either:
- **Before Change 1:** Modify `src/test-utils/index.ts` directly
- **As part of Change 1:** Write the transaction-wrapped version directly into the new `src/test-utils/db.ts`

Either way, the change is the same 2-line addition (BEGIN before loop, COMMIT after loop).

## Files to modify

If applied standalone (before Change 1):
- `src/test-utils/index.ts` — wrap INSERT loop in BEGIN/COMMIT

If applied as part of Change 1:
- `src/test-utils/db.ts` — new file with transaction-wrapped INSERT loop (included in Change 1 file list)

## Verification

After this change, run the full test suite and verify:
1. All tests pass (no regression)
2. `deno task test:coverage` still shows 100% coverage
3. Time the test suite before and after — expect ~10-20 second improvement

To measure the impact in isolation, you can time a single `createTestDbWithSetup()` call:
```typescript
Deno.bench("createTestDbWithSetup (cached)", async () => {
  await createTestDbWithSetup();
});
```