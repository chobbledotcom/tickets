import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { bunnyHostingProvider } from "#shared/bunny-cdn.ts";
import { toBase64Url } from "#shared/crypto/utils.ts";
import { insertBuiltSite } from "#shared/db/built-sites.ts";

export const TEST_SCHEDULED_KEY = toBase64Url(new Uint8Array(32).fill(7));

export const SCHEDULED_OWNER_ENV = {
  BUNNY_API_KEY: "test-key",
  CAN_BUILD_SITES: "true",
  SCHEDULED_TASK_KEY: TEST_SCHEDULED_KEY,
} as const;

export const scheduledAuthorization = (
  key = TEST_SCHEDULED_KEY,
): Record<string, string> => ({ authorization: `Bearer ${key}` });

export const expectScheduledResponse = async (
  response: Response,
  status: number,
): Promise<void> => {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toBe("");
};

export const stubBunnySchedulerSecrets = (
  stubs: { restore(): void }[],
  names: string[],
  result: { ok: true } | { error: string; ok: false },
): void => {
  stubs.push(
    stub(bunnyHostingProvider, "getSecretNames", () =>
      Promise.resolve({ ok: true, value: names }),
    ),
    stub(bunnyHostingProvider, "setSecrets", () =>
      Promise.resolve(result.ok ? { ...result, value: undefined } : result),
    ),
  );
};

export const insertScheduledTestSite = (
  active: string | null = TEST_SCHEDULED_KEY,
) =>
  insertBuiltSite(
    "Child",
    "child.example.test",
    "",
    "",
    false,
    "42",
    undefined,
    "bunny",
    "bunny",
    active,
  );
