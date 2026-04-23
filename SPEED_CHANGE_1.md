# SPEED_CHANGE_1 — Split `test-utils/index.ts` into focused sub-modules

## Problem

`src/test-utils/index.ts` is a 3,230-line monolith. Every test that imports *anything* from `#test-utils` eagerly loads `node-forge` (~large crypto library), `@libsql/client`, `#routes/index.ts` (entire route tree), `#routes/admin/auth.ts`, and ~20 other production modules. Even a simple unit test that only needs `mockRequest` or `expectStatus` pays this cost on every Deno worker process (15 workers by default).

Additionally, `setRethrowErrorsForTest` (defined in `#routes/index.ts`) and `setSkipLoginDelayForTest` (defined in `#routes/admin/auth.ts`) are imported by `#test-utils`, dragging the entire route tree into every test that uses `setupTestEncryptionKey` or `describeWithEnv`.

## Approach

### 1. Create `src/lib/test-overrides.ts`

A tiny module containing just the two setter functions currently defined in route files. Uses `lazyRef` from `#fp` (same pattern as currently used in the route files). This breaks the dependency on `#routes/index.ts` and `#routes/admin/auth.ts`.

```typescript
import { lazyRef } from "#fp";
import { getEnv } from "#lib/env.ts";

const [getRethrowErrors, setRethrowErrors] = lazyRef<boolean | null>(() => null);
export { getRethrowErrors, setRethrowErrors };

const [getSkipLoginDelay, setSkipLoginDelay] = lazyRef(() => !!getEnv("TEST_SKIP_LOGIN_DELAY"));
export { getSkipLoginDelay, setSkipLoginDelay };
```

Then update `#routes/index.ts` to import `getRethrowErrors`/`setRethrowErrors` from `#lib/test-overrides` instead of defining locally, and update `#routes/admin/auth.ts` similarly for `getSkipLoginDelay`/`setSkipLoginDelay`.

### 2. Split into sub-modules

| Module | Exports | Heavy dependencies |
|---|---|---|
| `test-utils/internal.ts` | Shared state: `cachedSetupSettings`, `cachedSetupUsers`, `cachedAdminSession`, `testSession`, `getClient`, `resetTestSession`, `resetTestSlugCounter`, `generateTestEventName`, `TEST_ADMIN_USERNAME`, `TEST_ADMIN_PASSWORD`, `TEST_ENCRYPTION_KEY`, type exports (`DescribeEnvOptions`, `TestRequestOptions`, `FetchCall`, `AdminTestContext`, `BookAttendeeOpts`, `RawEventRange`, `EventInput`, `GroupInput`, `HolidayInput`, `BuiltSiteFormInput`, `PaymentProviderType`, `SessionMetadata`, `EmailEntry`, `EmailEvent`, `WebhookAttendee`) | `@libsql/client` (types only) |
| `test-utils/db.ts` | `createTestDb`, `createTestDbWithSetup`, `resetDb`, `invalidateTestDbCache`, `describeWithEnv`, `rawEventRange` | `@libsql/client`, `#lib/db/*`, `#lib/test-overrides`, `#lib/crypto/*` |
| `test-utils/env.ts` | `setupTestEncryptionKey`, `clearTestEncryptionKey`, `setTestEnv` | `#lib/test-overrides`, `#lib/crypto/*`, `#lib/db/settings`, `#lib/logger` |
| `test-utils/mocks.ts` | `mockRequest`, `mockRequestWithHost`, `mockFormRequest`, `mockMultipartRequest`, `mockWebhookRequest`, `mockAdminLoginRequest`, `mockSetupFormRequest`, `mockTicketFormRequest`, `withFetchMock`, `installUrlHandler`, `stubFetchJson`, `stubFetchRecorder`, `useFetchStub`, `withMockBunnyCdnApi`, `withStorageMock`, `withCdnProxy`, `withCdnRejecting`, `withStorageEnabled`, `withStorageDisabled`, `withLocalStorageEnabled`, `cdnOkResponse`, `successResponse`, `errorResponse`, `mockProviderType`, `withExpectedError`, `testRequest`, `awaitTestRequest`, `withMocks`, `urlFromFetchInput` | `#lib/cookies`, `#lib/csrf`, `#lib/form-data`, lazy `#routes` |
| `test-utils/assertions.ts` | `expectStatus`, `expectJsonResponse`, `assertJson`, `assertFormRedirect`, `assertAdminHtml`, `assertAdminHtmlWithCookie`, `assertPublicHtml`, `expectHtmlResponse`, `expectRedirect`, `expectAdminRedirect`, `expectFlash`, `expectRedirectWithFlash`, `expectCheckoutRedirect`, `followRedirect`, `followRedirectWithFlash`, `expectResultError`, `expectResultNotFound`, `getHeader`, `matchGroup`, `FLASH_TEST_ID` | `@std/expect`, `#lib/cookies`, `#lib/forms.tsx`, lazy `#routes` |
| `test-utils/csrf.ts` | `extractCsrfToken`, `extractInputValue`, `hasInputWithValue`, `hasCheckedInput`, `hasSelectedOption`, `getCsrfTokenFromCookie`, `getAdminLoginCsrfToken`, `getJoinCsrfToken`, `requireJoinCsrfToken`, `getSetupCsrfToken`, `getTicketCsrfToken`, `getPageCsrfToken`, `flashCookieHeader`, `submitJoinForm`, `submitTicketForm`, `submitMultiTicketForm` | `#lib/cookies`, `#lib/csrf`, lazy `#routes` |
| `test-utils/factories.ts` | `testEvent`, `testEventWithCount`, `testAttendee`, `testGroup`, `testHoliday`, `testBuiltSite`, `testEventInput`, `baseEventForm`, `webhookMeta`, `singleItem`, `JPEG_HEADER`, `PDF_BYTES`, `makeTestEvent`, `makeTestAttendee`, `makeTestEntry` | `#lib/types`, `#lib/currency`, `#fp` |
| `test-utils/validation.ts` | `expectValid`, `expectInvalid`, `expectInvalidForm` | `@std/expect`, `#lib/forms.tsx` |
| `test-utils/session.ts` | `loginAsAdmin`, `getTestSession`, `resetTestSession`, `testCookie`, `testCsrfToken`, `createTestManagerSession`, `createTestApiKeyToken`, `createTestApiKeyFull`, `requestAsApiKey`, `requestAsSession`, `apiRequest`, `setupEventAndLogin`, `adminFormPost`, `adminGet`, `adminAttendeeAction`, `adminEventPage`, `setupAdminTest` | `#lib/db/*`, `#lib/crypto/*`, lazy `#routes` |
| `test-utils/db-helpers.ts` | `createTestEvent`, `updateTestEvent`, `deactivateTestEvent`, `reactivateTestEvent`, `createTestAttendee`, `createTestAttendeeDirect`, `createTestAttendeeWithToken`, `createDailyTestEvent`, `createDailyTestAttendee`, `createPaidTestAttendee`, `bookAttendee`, `createTestGroup`, `updateTestGroup`, `deleteTestGroup`, `createTestHoliday`, `updateTestHoliday`, `deleteTestHoliday`, `createTestBuiltSite`, `updateTestBuiltSite`, `deleteTestBuiltSite`, `createTestInvite`, `priceFormValue`, `getEmbeddableTicketResponse` | `#lib/db/*`, lazy `#routes` |
| `test-utils/settings.ts` | `withSetting`, `useSetting`, `testWithSetting`, `setupStripe`, `stubWebhookVerify` | `#lib/db/settings`, `#lib/stripe-provider` |
| `test-utils/crypto.ts` | `generateTestCerts`, `generateGoogleTestCreds`, `getTestDataKey`, `getTestPrivateKey` | `node-forge`, `#lib/crypto/*` |

### 3. Barrel re-export file (`src/test-utils.ts`)

Create a barrel file that re-exports everything EXCEPT `generateTestCerts` and `generateGoogleTestCreds` (those must be imported directly from `#test-utils/crypto` to avoid loading `node-forge` unnecessarily).

```typescript
// Re-export all sub-modules for convenience
export * from "./test-utils/internal.ts";
export * from "./test-utils/db.ts";
export * from "./test-utils/env.ts";
export * from "./test-utils/mocks.ts";
export * from "./test-utils/assertions.ts";
export * from "./test-utils/csrf.ts";
export * from "./test-utils/factories.ts";
export * from "./test-utils/validation.ts";
export * from "./test-utils/session.ts";
export * from "./test-utils/db-helpers.ts";
export * from "./test-utils/settings.ts";
export { TestBrowser } from "./test-utils/test-browser.ts";
// NOTE: generateTestCerts and generateGoogleTestCreds are NOT re-exported.
// Import them directly from "#test-utils/crypto" to avoid loading node-forge.
```

### 4. Update `deno.json` import map

```jsonc
{
  "imports": {
    // Change from:
    "#test-utils": "./src/test-utils/index.ts",
    // To:
    "#test-utils": "./src/test-utils.ts",

    // Already exists, keep:
    "#test-utils/": "./src/test-utils/",

    // New:
    "#lib/test-overrides": "./src/lib/test-overrides.ts"
  }
}
```

### 5. Update `#routes/index.ts` and `#routes/admin/auth.ts`

Replace the local `setRethrowErrorsForTest`/`setSkipLoginDelayForTest` definitions with imports from `#lib/test-overrides`.

**`src/routes/index.ts`:**
```typescript
// Before:
import { lazyRef, once, reduce } from "#fp";
const [getRethrowErrors, setRethrowErrors] = lazyRef<boolean | null>(() => null);
export const setRethrowErrorsForTest = (rethrow: boolean | null): void =>
  setRethrowErrors(rethrow);

// After:
import { once, reduce } from "#fp";
import { getRethrowErrors, setRethrowErrorsForTest } from "#lib/test-overrides";
// Remove the lazyRef definition and export — now imported
```

**`src/routes/admin/auth.ts`:**
```typescript
// Before:
import { lazyRef } from "#fp";
const [getSkipLoginDelay, setSkipLoginDelay] = lazyRef(
  () => !!getEnv("TEST_SKIP_LOGIN_DELAY"),
);
export const setSkipLoginDelayForTest = (skip: boolean): void =>
  setSkipLoginDelay(skip);

// After:
import { getSkipLoginDelay, setSkipLoginDelayForTest } from "#lib/test-overrides";
// Remove the lazyRef definition and export — now imported
```

### 6. Update every test file's imports

Change from single `#test-utils` import to specific sub-module imports. For example:

```typescript
// Before:
import {
  describeWithEnv,
  createTestEvent,
  mockRequest,
} from "#test-utils";

// After:
import { describeWithEnv } from "#test-utils/db";
import { createTestEvent } from "#test-utils/db-helpers";
import { mockRequest } from "#test-utils/mocks";
```

Files that import `generateTestCerts` or `generateGoogleTestCreds` must use:
```typescript
import { generateTestCerts } from "#test-utils/crypto";
```

### 7. Delete `src/test-utils/index.ts`

After all sub-modules are created and all imports are updated, delete the monolithic `src/test-utils/index.ts`.

## Expected impact

Test files that only need lightweight helpers (mocks, assertions, factories) will no longer load `node-forge`, `@libsql/client`, or the route tree. With 15 parallel workers, this saves module parsing and initialization time. The exact wall-clock savings depends on which tests land on which worker, but we expect **20-40 seconds** saved on a typical run.

## Files to create

- `src/lib/test-overrides.ts` — extracted setter functions
- `src/test-utils.ts` — barrel re-export
- `src/test-utils/internal.ts` — shared state and types
- `src/test-utils/db.ts` — DB setup/teardown
- `src/test-utils/env.ts` — encryption key and env var setup
- `src/test-utils/mocks.ts` — request/response mocking
- `src/test-utils/assertions.ts` — test assertions
- `src/test-utils/csrf.ts` — CSRF and form submission helpers
- `src/test-utils/factories.ts` — test data factories
- `src/test-utils/validation.ts` — form validation helpers
- `src/test-utils/session.ts` — login/session/admin helpers
- `src/test-utils/db-helpers.ts` — REST API entity creation
- `src/test-utils/settings.ts` — settings overrides and Stripe setup
- `src/test-utils/crypto.ts` — wallet cert generation (with Change 2 applied)

## Files to modify

- `src/test-utils/index.ts` — DELETE (replaced by sub-modules)
- `src/routes/index.ts` — import from `#lib/test-overrides`
- `src/routes/admin/auth.ts` — import from `#lib/test-overrides`
- `deno.json` — update `#test-utils` import map entry, add `#lib/test-overrides`
- **~160 test files** — update import paths from `#test-utils` to specific sub-modules
- `scripts/profile-cold-boot.ts` — update import path