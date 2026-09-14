/**
 * The domain routes directly: an over-long custom domain or host subdomain
 * is refused by the central single-line limit before any Bunny call.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import {
  handleCustomDomainPost,
  handleHostSubdomainPost,
} from "#routes/admin/settings-domains.ts";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import { expectFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";

// Bunny stays unconfigured, so a length message here proves the limit runs
// before the config refusal, not after it.
const DOMAIN_ROUTES = [
  {
    check: () => expect(settings.customDomain).toBe(""),
    field: "custom_domain",
    handler: handleCustomDomainPost,
    // One character over the limit, still shaped like a real domain.
    message: "Domain must be 250 characters or fewer",
    path: "/admin/settings/custom-domain",
    value: `${"a".repeat(MAX_INPUT_LENGTH - 11)}.example.com`,
  },
  {
    check: () => expect(settings.bunnySubdomain).toBe(""),
    field: "subdomain",
    handler: handleHostSubdomainPost,
    message: "Subdomain must be 250 characters or fewer",
    path: "/admin/settings/host-subdomain",
    value: "s".repeat(MAX_INPUT_LENGTH + 1),
  },
] as const;

describeWithEnv(
  "settings (domain routes single-line limit)",
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
    for (const {
      check,
      field,
      handler,
      message,
      path,
      value,
    } of DOMAIN_ROUTES) {
      test(`refuses an over-long ${field} before any Bunny call`, async () => {
        using fetch = stubFetch(new Error("Unexpected external call"));
        const response = await handler(
          mockFormRequest(
            path,
            { [field]: value, csrf_token: await testCsrfToken() },
            await testCookie(),
          ),
        );

        expect(response.status).toBe(302);
        expectFlash(response, message, false);
        expect(fetch.calls).toHaveLength(0);
        check();
      });
    }
  },
);
