import type { Row } from "@libsql/client";

export const TEST_ADMIN_USERNAME = "testadmin";

export const TEST_ADMIN_PASSWORD = "testpassword123";

export const TEST_ENCRYPTION_KEY =
  "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

type AdminSessionRow = {
  token: string;
  csrf_token: string;
  expires: number;
  wrapped_data_key: string | null;
  user_id: number | null;
};

type TestSession = { cookie: string; csrfToken: string };

let _cachedSetupSettings: Array<{ key: string; value: string }> | null = null;
let _cachedSetupUsers: Row[] | null = null;
let _cachedAdminSession: {
  cookie: string;
  sessionRow: AdminSessionRow;
} | null = null;
let _testSession: TestSession | null = null;
let _nameCounter = { value: 0 };

export const getCachedSetupSettings = () => _cachedSetupSettings;
export const setCachedSetupSettings = (
  v: Array<{ key: string; value: string }> | null,
) => {
  _cachedSetupSettings = v;
};
export const getCachedSetupUsers = () => _cachedSetupUsers;
export const setCachedSetupUsers = (v: Row[] | null) => {
  _cachedSetupUsers = v;
};
export const getCachedAdminSession = () => _cachedAdminSession;
export const setCachedAdminSession = (
  v: {
    cookie: string;
    sessionRow: AdminSessionRow;
  } | null,
) => {
  _cachedAdminSession = v;
};
export const getInternalTestSession = (): TestSession | null => _testSession;
export const setTestSession = (v: TestSession | null) => {
  _testSession = v;
};

export const resetTestSession = (): void => {
  _testSession = null;
};

export const resetTestSlugCounter = (): void => {
  _nameCounter = { value: 0 };
};

export const generateTestEventName = (): string => {
  _nameCounter.value++;
  return `Test Event ${_nameCounter.value}`;
};

export interface DescribeEnvOptions {
  db?: boolean;
  encryptionKey?: boolean;
  env?: Record<string, string | undefined>;
}

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
  event: import("#lib/types.ts").Event;
  attendee: import("#lib/types.ts").Attendee;
  cookie: string;
  csrfToken: string;
};

export type BookAttendeeOpts = Partial<
  Omit<import("#lib/db/attendee-types.ts").EventBooking, "eventId">
> & {
  name?: string;
  email?: string;
  phone?: string;
  address?: string;
  special_instructions?: string;
  paymentId?: string;
};

export type RawEventRange = {
  start_at: string | null;
  end_at: string | null;
  quantity: number;
};

export type PaymentProviderType =
  import("#lib/payments.ts").PaymentProviderType;

export type SessionMetadata = import("#lib/payments.ts").SessionMetadata;

export type { BuiltSiteFormInput } from "#lib/db/built-sites.ts";
export type { EventInput } from "#lib/db/events.ts";
export type { GroupInput } from "#lib/db/groups.ts";
export type { HolidayInput } from "#lib/db/holidays.ts";
export type { EmailEntry, EmailEvent } from "#lib/email.ts";
export type { WebhookAttendee } from "#lib/webhook.ts";
