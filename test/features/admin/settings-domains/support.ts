import { expect } from "@std/expect";
import { afterEach } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockFormRequest, withMockBunnyCdnApi } from "#test-utils/mocks.ts";
import { adminGet, testCookie, testCsrfToken } from "#test-utils/session.ts";

export { requirePaymentProviderRecovery as setAmbiguousPaymentProvider } from "#test-utils/settings.ts";

export const advancedPageHtml = async (): Promise<string> =>
  (await adminGet("/admin/settings-advanced")).text();

export const expectActivityLogged = async (text: string): Promise<void> => {
  const log = await getAllActivityLog();
  expect(log.some((entry) => entry.message.includes(text))).toBe(true);
};

export const enableBunnyCdn = (): (() => void) => {
  Deno.env.set("BUNNY_API_KEY", "test-bunny-key");
  Deno.env.set("BUNNY_SCRIPT_ID", "99");
  const original = bunnyCdnApi.getCdnHostname;
  bunnyCdnApi.getCdnHostname = () =>
    Promise.resolve({ hostname: "mysite.b-cdn.net", ok: true as const });
  return () => {
    bunnyCdnApi.getCdnHostname = original;
  };
};

export const describeCustomDomain = (
  name: string,
  body: (enable: () => void) => void,
): void =>
  describeWithEnv(
    name,
    {
      db: true,
      env: { BUNNY_API_KEY: undefined, BUNNY_SCRIPT_ID: undefined },
    },
    () => {
      let restore: (() => void) | null = null;
      const enable = () => {
        restore = enableBunnyCdn();
      };
      afterEach(() => {
        restore?.();
        restore = null;
      });
      body(enable);
    },
  );

export const enableBunnyDns = (): (() => void) => {
  Deno.env.set("BUNNY_API_KEY", "test-bunny-key");
  Deno.env.set("BUNNY_SCRIPT_ID", "test-script-id");
  Deno.env.set("BUNNY_DNS_ZONE_ID", "42");
  Deno.env.set("BUNNY_DNS_SUBDOMAIN_SUFFIX", ".tickets");
  const original = bunnyCdnApi.getCdnHostname;
  bunnyCdnApi.getCdnHostname = () =>
    Promise.resolve({ hostname: "test.b-cdn.net", ok: true as const });
  return () => {
    bunnyCdnApi.getCdnHostname = original;
  };
};

export const withValidatedDomain = (body: () => Promise<void>): Promise<void> =>
  withMockBunnyCdnApi(
    { validateCustomDomain: () => Promise.resolve({ ok: true as const }) },
    body,
  );

export const postSubdomain = async (subdomain: string): Promise<Response> =>
  handleRequest(
    mockFormRequest(
      "/admin/settings/host-subdomain",
      { csrf_token: await testCsrfToken(), subdomain },
      await testCookie(),
    ),
  );

export const subdomainCheck = (available: boolean) => ({
  available,
  fullDomain: "mylisting.tickets.example.com",
  ok: true as const,
});

export const withSubdomainCheck = (
  result: Awaited<ReturnType<typeof bunnyCdnApi.checkSubdomainAvailable>>,
  body: () => Promise<void>,
): Promise<void> =>
  withMockBunnyCdnApi(
    { checkSubdomainAvailable: () => Promise.resolve(result) },
    body,
  );
