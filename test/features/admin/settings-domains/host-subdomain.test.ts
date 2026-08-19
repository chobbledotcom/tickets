import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import {
  advancedPageHtml,
  enableBunnyDns,
  expectActivityLogged,
  postSubdomain,
  requirePaymentProviderRecovery,
  subdomainCheck,
  withSubdomainCheck,
} from "#test/features/admin/settings-domains/support.ts";
import {
  expectErrorFlash,
  expectFlashRedirect,
  expectRedirectWithFlash,
  followRedirectWithFlash,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  mockFormRequest,
  mockRequestWithHost,
  withMockBunnyCdnApi,
} from "#test-utils/mocks.ts";
import {
  adminFormPost,
  testCookie,
  testCsrfToken,
} from "#test-utils/session.ts";

const PATH = "/admin/settings/host-subdomain";
const REDIRECT =
  "/admin/settings-advanced?form=settings-host-subdomain#settings-host-subdomain";

describeWithEnv(
  "host subdomain settings",
  {
    db: true,
    env: {
      BUNNY_API_KEY: undefined,
      BUNNY_DNS_SUBDOMAIN_SUFFIX: undefined,
      BUNNY_DNS_ZONE_ID: undefined,
      BUNNY_SCRIPT_ID: undefined,
    },
  },
  () => {
    let restore: (() => void) | null = null;
    const enable = () => {
      restore = enableBunnyDns();
    };
    afterEach(() => {
      restore?.();
      restore = null;
    });

    test("hides the section when DNS is not configured", async () => {
      expect(await advancedPageHtml()).not.toContain(
        'id="settings-host-subdomain"',
      );
    });

    test("shows the section when DNS is configured", async () => {
      enable();
      const html = await advancedPageHtml();
      expect(html).toContain('id="settings-host-subdomain"');
      expect(html).toContain("Host Subdomain");
      expect(html).toContain(
        "Check Availability &amp; Preview Complete Domain",
      );
    });

    test("shows a registered subdomain on its secure host", async () => {
      enable();
      const cookie = await testCookie();
      const token = cookie.split("=").slice(1).join("=").split(";")[0];
      await settings.update.bunnySubdomain("mylisting.tickets.example.com");
      const response = await handleRequest(
        mockRequestWithHost(
          "/admin/settings-advanced",
          "mylisting.tickets.example.com",
          {
            headers: { cookie: `__Host-session=${token}` },
          },
        ),
      );
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain("mylisting.tickets.example.com");
      expect(html).toContain("permanent and cannot be changed");
      expect(html).toContain("can be active at the same time");
    });

    test("rejects registration when DNS is not configured", async () => {
      const response = await postSubdomain("mylisting");
      expectRedirectWithFlash(REDIRECT, "Not configured", false)(response);
    });

    test("rejects a change after a subdomain is set", async () => {
      enable();
      const csrfToken = await testCsrfToken();
      const cookie = await testCookie();
      const token = cookie.split("=").slice(1).join("=");
      await settings.update.bunnySubdomain("existing.tickets.example.com");
      const response = await handleRequest(
        mockRequestWithHost(PATH, "existing.tickets.example.com", {
          body: `subdomain=mylisting&csrf_token=${encodeURIComponent(csrfToken)}`,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `__Host-session=${token}`,
          },
          method: "POST",
        }),
      );
      expectRedirectWithFlash(
        REDIRECT,
        "Subdomain has already been set and cannot be changed",
        false,
      )(response);
    });

    for (const subdomain of ["", "-invalid"]) {
      test(`rejects invalid subdomain ${JSON.stringify(subdomain)}`, async () => {
        enable();
        const response = await postSubdomain(subdomain);
        expectRedirectWithFlash(
          REDIRECT,
          "Invalid subdomain format",
          false,
        )(response);
      });
    }

    test("previews an available subdomain", async () => {
      enable();
      await withSubdomainCheck(subdomainCheck(true), async () => {
        const cookie = await testCookie();
        const response = await handleRequest(
          mockFormRequest(
            PATH,
            { csrf_token: await testCsrfToken(), subdomain: "mylisting" },
            cookie,
          ),
        );
        expectRedirectWithFlash(
          REDIRECT,
          "mylisting.tickets.example.com is available",
        )(response);
        const html = await (
          await followRedirectWithFlash(response, handleRequest, cookie)
        ).text();
        expect(html).toContain("mylisting.tickets.example.com");
      });
    });

    test("reports an availability-check error", async () => {
      enable();
      await withSubdomainCheck(
        { error: "DNS zone error", ok: false as const },
        async () => {
          expectErrorFlash(await postSubdomain("mylisting"), "DNS zone error");
        },
      );
    });

    test("reports a subdomain that is already taken", async () => {
      enable();
      await withSubdomainCheck(subdomainCheck(false), async () => {
        expectRedirectWithFlash(
          REDIRECT,
          'Subdomain "mylisting" is already taken',
          false,
        )(await postSubdomain("mylisting"));
      });
    });

    test("blocks registration until provider recovery is complete", async () => {
      enable();
      await requirePaymentProviderRecovery();
      const { response } = await adminFormPost(PATH, {
        save: "1",
        subdomain: "mylisting",
      });
      expectRedirectWithFlash(
        REDIRECT,
        "Choose the provider for existing payments before changing your domain.",
        false,
      )(response);
      expect(settings.bunnySubdomain).toBe("");
    });

    test("registers and logs a subdomain while holding its task lock", async () => {
      enable();
      await withMockBunnyCdnApi(
        {
          registerBunnySubdomain: () => {
            expect(settings.currentTask).toBe("host-subdomain");
            return Promise.resolve({
              fullDomain: "mylisting.tickets.example.com",
              ok: true as const,
            });
          },
        },
        async () => {
          const { response } = await adminFormPost(PATH, {
            save: "1",
            subdomain: "mylisting",
          });
          expectRedirectWithFlash(
            REDIRECT,
            "Subdomain registered: mylisting.tickets.example.com",
          )(response);
          expect(settings.bunnySubdomain).toBe("mylisting.tickets.example.com");
          await expectActivityLogged(
            "Host subdomain set to mylisting.tickets.example.com",
          );
        },
      );
    });

    test("reports a registration failure", async () => {
      enable();
      await withMockBunnyCdnApi(
        {
          registerBunnySubdomain: () =>
            Promise.resolve({ error: "DNS error", ok: false as const }),
        },
        async () => {
          const { response } = await adminFormPost(PATH, {
            save: "1",
            subdomain: "mylisting",
          });
          expectRedirectWithFlash(REDIRECT, "DNS error", false)(response);
        },
      );
    });

    test("rejects registration while another task is running", async () => {
      enable();
      await settings.update.currentTask("some-other-task");
      try {
        const { response } = await adminFormPost(PATH, {
          save: "1",
          subdomain: "mylisting",
        });
        await expectFlashRedirect(
          REDIRECT,
          expect.stringContaining("Another task is already in progress"),
          false,
        )(response);
      } finally {
        await settings.update.currentTask("");
      }
    });
  },
);
