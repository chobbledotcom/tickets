import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { bunnyCdnApi, type EdgeScriptSecret } from "#shared/bunny-cdn.ts";
import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestBuiltSite } from "#test-utils/db-helpers/built-sites.ts";
import { withEnv } from "#test-utils/env.ts";
import { withMocks } from "#test-utils/mocks.ts";
import { adminGet } from "#test-utils/session.ts";

/** Build a Bunny secret-list entry (name + metadata; the API never returns values). */
const secret = (name: string): EdgeScriptSecret => ({
  Id: 1,
  LastModified: "2026-01-01T00:00:00Z",
  Name: name,
});

describeWithEnv(
  "built site secrets page",
  { db: true, env: { CAN_BUILD_SITES: "true" } },
  () => {
    /** Render one site's Secrets tab with the host env and live secret names
     * given, so a test reads as "this host, this site, this page". */
    const secretsPage = async (
      siteId: number,
      env: Record<string, string | undefined>,
      present: string[] = [],
    ): Promise<string> => {
      using _env = withEnv(env);
      let html = "";
      await withMocks(
        () =>
          stub(bunnyCdnApi, "listEdgeScriptSecrets", () =>
            Promise.resolve({
              ok: true as const,
              secrets: present.map(secret),
            }),
          ),
        async () => {
          const response = await adminGet(
            `/admin/built-sites/${siteId}/secrets`,
          );
          html = await expectHtmlResponse(response, 200);
        },
      );
      return html;
    };

    test("offers the Botpoison keys to copy when the host has them", async () => {
      const site = await createTestBuiltSite({
        hostingId: "8100",
        name: "Botpoison Copy",
      });
      const html = await secretsPage(site.id, {
        BOTPOISON_PUBLIC_KEY: "pk_host_9f3a",
        BOTPOISON_SECRET_KEY: "sk_host_7c2e",
        BUNNY_API_KEY: "k",
        NTFY_URL: "https://ntfy.example.com/t",
      });
      expect(html).toContain("<code>BOTPOISON_PUBLIC_KEY</code>");
      expect(html).toContain("<code>BOTPOISON_SECRET_KEY</code>");
      expect(html).toContain(`/admin/built-sites/${site.id}/add-secrets`);
      // The secret key's value never reaches the page.
      expect(html).not.toContain("sk_host_7c2e");
    });

    test("leaves the Botpoison keys out when the host does not have them", async () => {
      const site = await createTestBuiltSite({
        hostingId: "8101",
        name: "No Botpoison",
      });
      const html = await secretsPage(site.id, {
        BUNNY_API_KEY: "k",
        NTFY_URL: "https://ntfy.example.com/t",
      });
      // An unset key sits out exactly like every other unset secret.
      expect(html).toContain("<code>NTFY_URL</code>");
      expect(html).not.toContain("BOTPOISON_PUBLIC_KEY");
      expect(html).not.toContain("BOTPOISON_SECRET_KEY");
    });
  },
);
