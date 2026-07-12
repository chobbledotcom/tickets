import { lazyRef } from "#fp";

export const TEST_ADMIN_USERNAME = "testadmin";

export const TEST_ADMIN_PASSWORD = "testpassword123";

export const TEST_ENCRYPTION_KEY =
  "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

// The standard Bunny CDN test zone. Single source of truth shared by the
// storage-mock helpers (as a runWithStorageConfig object) and describeWithEnv's
// `storage: "cdn"` option (as STORAGE_ZONE_KEY/NAME env vars).
export const TEST_STORAGE_ZONE = {
  zoneKey: "testkey",
  zoneName: "testzone",
} as const;

type TestSession = { cookie: string; csrfToken: string };

// Resettable test cache as a lazyRef cell (set(null) clears) — no module-level
// `let`. The setup-state cache lives in #test-utils/test-state.ts.
export const [getInternalTestSession, setTestSession] =
  lazyRef<TestSession | null>(() => null);

export const resetTestSession = (): void => setTestSession(null);

// Mutable counter held in a const object (mutated in place, never reassigned).
const _nameCounter = { value: 0 };

export const resetTestSlugCounter = (): void => {
  _nameCounter.value = 0;
};

export const generateTestListingName = (): string => {
  _nameCounter.value++;
  return `Test Listing ${_nameCounter.value}`;
};

export interface DescribeEnvOptions {
  db?: boolean;
  encryptionKey?: boolean;
  env?: Record<string, string | undefined>;
  /**
   * Establish an image-storage backend for every test in the suite, instead of
   * wrapping each body in `withStorageEnabled` / `withLocalStorageEnabled`:
   * - `"cdn"`: the standard Bunny test zone (`isStorageEnabled()` ⇒ true).
   * - `"local"`: a fresh temp dir per test (path via `getTestStoragePath()`),
   *   created before the test and removed after.
   * An individual test can still override with a per-body `runWithStorageConfig`
   * scope (e.g. `withStorageDisabled`), which wins over the suite's env default.
   */
  storage?: "cdn" | "local";
  triggers?: boolean;
}

// The temp dir backing `storage: "local"`; set per test in describeWithEnv's
// beforeEach and cleared/removed in afterEach. Tests that write through the
// local backend read the active dir from here.
export const [getTestStoragePath, setTestStoragePath] = lazyRef<string | null>(
  () => null,
);

export interface TestRequestOptions {
  cookie?: string;
  data?: Record<string, string>;
  method?: string;
}

export interface FetchCall {
  init: RequestInit | undefined;
  url: string;
}

export type AdminTestContext = {
  listing: import("#shared/types.ts").Listing;
  attendee: import("#shared/types.ts").Attendee;
  cookie: string;
  csrfToken: string;
};

export type BookAttendeeOpts = Partial<
  Omit<import("#shared/db/attendee-types.ts").ListingBooking, "listingId">
> & {
  name?: string;
  email?: string;
  phone?: string;
  address?: string;
  special_instructions?: string;
  paymentId?: string;
};

export type RawListingRange = {
  start_at: string | null;
  end_at: string | null;
  quantity: number;
};

export type PaymentProviderType =
  import("#shared/payments.ts").PaymentProviderType;

export type SessionMetadata = import("#shared/payments.ts").SessionMetadata;

export type { BuiltSiteFormInput } from "#shared/db/built-sites.ts";
export type { GroupInput } from "#shared/db/groups.ts";
export type { HolidayInput } from "#shared/db/holidays.ts";
export type { ListingInput } from "#shared/db/listings.ts";
export type { EmailEntry, EmailListing } from "#shared/email.ts";
export type { WebhookAttendee } from "#shared/webhook.ts";
