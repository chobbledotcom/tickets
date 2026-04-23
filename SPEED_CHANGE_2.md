# SPEED_CHANGE_2 — Make wallet cert generation lazy

## Problem

`src/test-utils/index.ts` lines 2846-2902 generate 3 RSA-2048 keypairs at module load time via IIFE using `node-forge` (pure JavaScript, ~5s per keypair). Since `node-forge` is eagerly imported by every test that uses `#test-utils`, this IIFE runs in all 15 parallel Deno workers — ~45 seconds of CPU time for keygen alone, plus the time to load the large `node-forge` module.

Only 6 test files actually use `generateTestCerts` or `generateGoogleTestCreds`:
- `test/lib/apple-wallet.test.ts`
- `test/lib/google-wallet.test.ts`
- `test/lib/server-wallet.test.ts`
- `test/lib/server-wallet-webservice.test.ts`
- `test/lib/server-google-wallet.test.ts`
- `test/lib/server-debug.test.ts`

## Approach

### 1. Convert IIFEs to lazy initialization

In the new `src/test-utils/crypto.ts` (created as part of Change 1), replace the module-level IIFEs with lazy initialization:

**Before (eager — runs at import time in every worker):**
```typescript
import forge from "node-forge";

const _testCerts: SigningCredentials = (() => {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  // ... ~40 lines of cert generation ...
  return { passTypeId: "pass.com.test.tickets", ... };
})();

const _googleTestCreds: GoogleWalletCredentials = (() => {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  // ... key conversion ...
  return { issuerId: "1234567890", ... };
})();

export const generateTestCerts = (): SigningCredentials => _testCerts;
export const generateGoogleTestCreds = (): GoogleWalletCredentials => _googleTestCreds;
```

**After (lazy — only generates on first call, only in workers that need it):**
```typescript
import forge from "node-forge";

let _testCerts: SigningCredentials | null = null;

export const generateTestCerts = (): SigningCredentials => {
  if (!_testCerts) {
    _testCerts = buildTestCerts();
  }
  return _testCerts;
};

function buildTestCerts(): SigningCredentials {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  // ... same cert generation logic ...
  return { passTypeId: "pass.com.test.tickets", ... };
}

let _googleTestCreds: GoogleWalletCredentials | null = null;

export const generateGoogleTestCreds = (): GoogleWalletCredentials => {
  if (!_googleTestCreds) {
    _googleTestCreds = buildGoogleTestCreds();
  }
  return _googleTestCreds;
};

function buildGoogleTestCreds(): GoogleWalletCredentials {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  // ... same key conversion logic ...
  return { issuerId: "1234567890", ... };
}
```

The private `_testCerts` and `_googleTestCreds` variables become module-level `let` with `null` initial state, populated on first call. This preserves the caching behavior — subsequent calls within the same worker return the cached result.

**Note on `generateGoogleTestCreds`:** Some callers currently `await` it (`await generateGoogleTestCreds()`), even though it's synchronous. The lazy version remains synchronous — `await` on a non-Promise is a no-op, so existing callers work without changes.

### 2. Keep `node-forge` import in `crypto.ts` only

`node-forge` is imported only in `test-utils/crypto.ts`. It is NOT re-exported from the barrel (`src/test-utils.ts`). This means:

- Workers that don't run wallet tests never load `node-forge` at all
- The 6 test files that need wallet certs import directly from `#test-utils/crypto`
- The barrel still re-exports everything else, so most test files are unaffected

### 3. Update the 6 wallet test files

Change imports from `#test-utils` to `#test-utils/crypto`:

```typescript
// Before:
import { generateTestCerts, generateGoogleTestCreds } from "#test-utils";

// After:
import { generateTestCerts, generateGoogleTestCreds } from "#test-utils/crypto";
```

Files to update:
- `test/lib/apple-wallet.test.ts` — uses `generateTestCerts`
- `test/lib/google-wallet.test.ts` — uses `generateGoogleTestCreds`
- `test/lib/server-wallet.test.ts` — uses `generateTestCerts`
- `test/lib/server-wallet-webservice.test.ts` — uses `generateTestCerts`
- `test/lib/server-google-wallet.test.ts` — uses `generateGoogleTestCreds`
- `test/lib/server-debug.test.ts` — uses both `generateTestCerts` and `generateGoogleTestCreds`

Note: if a file imports other symbols from `#test-utils` as well (e.g., `server-debug.test.ts` imports `adminGet`, `describeWithEnv`, etc.), it keeps those imports from their respective sub-modules. Only the wallet cert imports move to `#test-utils/crypto`.

### 4. Do NOT re-export from barrel

The barrel `src/test-utils.ts` must NOT re-export `generateTestCerts` or `generateGoogleTestCreds`. If it did, importing `#test-utils` would transitively load `test-utils/crypto.ts` and thus `node-forge`, defeating the purpose.

Add a comment in the barrel file:
```typescript
// NOTE: generateTestCerts and generateGoogleTestCreds are NOT re-exported.
// Import them directly from "#test-utils/crypto" to avoid loading node-forge.
```

## What about `getTestDataKey` and `getTestPrivateKey`?

These functions are also in the "crypto" category. They depend on:
- `getTestDataKey` — uses `unwrapKeyWithToken` from `#lib/crypto/keys`
- `getTestPrivateKey` — uses `unwrapKeyWithToken`, `importPrivateKey` from `#lib/crypto/keys`, `decryptWithKey` from `#lib/crypto/encryption`

These do NOT depend on `node-forge` — they use the production crypto modules which are much lighter. However, since they're crypto-related, they belong in `test-utils/crypto.ts` and will be co-located with the wallet cert functions.

The 8 test files that use `getTestPrivateKey` or `getTestDataKey` will import from `#test-utils/crypto`. Since these files typically also use `describeWithEnv` (which imports from `#test-utils/db`), they'll load the crypto sub-module anyway — but without `node-forge` loading until `generateTestCerts`/`generateGoogleTestCreds` is actually called.

## Expected impact

Workers that don't run wallet tests (the vast majority — 203 out of 209 test files) skip `node-forge` loading and RSA keygen entirely. With 15 workers, this saves **~10-15 seconds of wall-clock time** since most workers would not have run wallet tests. The `node-forge` module load itself is also avoided (~0.5-1s per worker that doesn't need it).

Combined with Change 1 (which ensures `node-forge` isn't transitively loaded via the barrel), the total time saved is even greater: previously ALL 15 workers loaded `node-forge` and generated 3 RSA keypairs; after both changes, only the 1-2 workers running wallet tests will pay that cost.

## Relationship to Change 1

This change is applied **as part of** creating `src/test-utils/crypto.ts` in Change 1. The lazy initialization pattern is written into the new sub-module from the start.

If Change 2 is applied before Change 1, the modification would be made directly in `src/test-utils/index.ts` — converting the IIFEs to lazy init functions at lines 2846-2902. Change 1 would then move those functions to the new `crypto.ts` sub-module.

## Files to modify

If applied standalone (before Change 1):
- `src/test-utils/index.ts` — convert IIFEs to lazy init functions

If applied as part of Change 1:
- `src/test-utils/crypto.ts` — new file with lazy init (included in Change 1 file list)
- 6 wallet test files — update import paths

## Verification

After this change, running only non-wallet tests should show noticeably faster startup. Running wallet tests should have equivalent or slightly better performance (lazy init means keygen happens once on first call instead of at import time, but the time itself is the same).