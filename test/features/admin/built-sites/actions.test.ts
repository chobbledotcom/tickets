import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { expectedSiteSecrets } from "#shared/site-secrets.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestBuiltSite } from "#test-utils/db-helpers/built-sites.ts";
import { withEnv } from "#test-utils/env.ts";
import { adminFormPost, testCookie } from "#test-utils/session.ts";

describeWithEnv(
  "admin built-sites actions",
  { db: true, env: { CAN_BUILD_SITES: "true" } },
  () => {
    let secretStub: Stub;

    const installSecretStub = () =>
      stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
        Promise.resolve({ ok: true as const }),
      );

    beforeEach(() => {
      secretStub = installSecretStub();
    });

    afterEach(() => {
      if (!secretStub.restored) secretStub.restore();
    });

    describe("CSRF validation", () => {
      const postWithoutCsrf = async (siteId: number): Promise<Response> => {
        const cookie = await testCookie();
        return handleRequest(
          new Request(
            `http://localhost/admin/built-sites/${siteId}/bump-deadline`,
            {
              body: new URLSearchParams({ months: "1" }).toString(),
              headers: {
                "content-type": "application/x-www-form-urlencoded",
                cookie,
              },
              method: "POST",
            },
          ),
        );
      };

      test("POST without CSRF token returns 403", async () => {
        const site = await createTestBuiltSite({ name: "CSRF Test Site" });
        const response = await postWithoutCsrf(site.id);
        expect(response.status).toBe(403);
      });

      test("POST for a missing site returns 404 before CSRF validation", async () => {
        const response = await postWithoutCsrf(999999);
        expect(response.status).toBe(404);
      });
    });
  },
);

describeWithEnv(
  "admin built-sites add-secrets",
  {
    db: true,
    env: {
      BUNNY_API_KEY: "k",
      CAN_BUILD_SITES: "true",
      NTFY_URL: "https://ntfy.example.com/t",
    },
  },
  () => {
    /** Stub the live secret list + a recording setEdgeScriptSecret. */
    const stubSecrets = (present: string[]) => {
      const setCalls: { name: string; value: string }[] = [];
      const listStub = stub(bunnyCdnApi, "listEdgeScriptSecrets", () =>
        Promise.resolve({
          ok: true as const,
          secrets: present.map((Name) => ({
            Id: 1,
            LastModified: "2026-01-01T00:00:00Z",
            Name,
          })),
        }),
      );
      const setStub = stub(
        bunnyCdnApi,
        "setEdgeScriptSecret",
        (_id: number, name: string, value: string) => {
          setCalls.push({ name, value });
          return Promise.resolve({ ok: true as const });
        },
      );
      return {
        restore: () => {
          listStub.restore();
          setStub.restore();
        },
        setCalls,
      };
    };

    test("backfills secrets missing from the live list and logs the change", async () => {
      const site = await createTestBuiltSite({
        dbToken: "tok",
        dbUrl: "libsql://u",
        hostingId: "7100",
        name: "Backfill Site",
      });
      const secrets = stubSecrets([]); // nothing live yet — everything is missing
      try {
        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/add-secrets`,
        );
        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/secrets`,
          expect.stringContaining(", "),
        )(response);

        const setNames = secrets.setCalls.map((c) => c.name);
        expect(setNames).toContain("NTFY_URL");
        expect(setNames).toContain("DB_URL");
        // The unreproducible encryption key is never set.
        expect(setNames).not.toContain("DB_ENCRYPTION_KEY");

        const logs = await getAllActivityLog();
        expect(logs.some((l) => l.message.includes("missing secret"))).toBe(
          true,
        );
      } finally {
        secrets.restore();
      }
    });

    test("never overwrites a secret that already exists on the site", async () => {
      const site = await createTestBuiltSite({
        dbToken: "tok",
        dbUrl: "libsql://u",
        hostingId: "7101",
        name: "No Overwrite Site",
      });
      // Live list already has everything expected except NTFY_URL.
      const present = expectedSiteSecrets(site)
        .map(([name]) => name)
        .filter((name) => name !== "NTFY_URL");
      const secrets = stubSecrets(present);
      try {
        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/add-secrets`,
        );
        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/secrets`,
          "Set 1 missing secret(s): NTFY_URL",
        )(response);
        // Only the genuinely-missing secret is written.
        expect(secrets.setCalls.map((c) => c.name)).toEqual(["NTFY_URL"]);
      } finally {
        secrets.restore();
      }
    });

    test("sends the Botpoison keys' values to the site's secret store", async () => {
      const site = await createTestBuiltSite({
        dbToken: "tok",
        dbUrl: "libsql://u",
        hostingId: "7104",
        name: "Botpoison Site",
      });
      using _env = withEnv({
        BOTPOISON_PUBLIC_KEY: "pk_live_a1",
        BOTPOISON_SECRET_KEY: "sk_live_b2",
      });
      const secrets = stubSecrets([]); // nothing live yet — everything is missing
      try {
        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/add-secrets`,
        );
        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/secrets`,
          expect.stringContaining("BOTPOISON_SECRET_KEY"),
        )(response);
        expect(secrets.setCalls).toContainEqual({
          name: "BOTPOISON_PUBLIC_KEY",
          value: "pk_live_a1",
        });
        expect(secrets.setCalls).toContainEqual({
          name: "BOTPOISON_SECRET_KEY",
          value: "sk_live_b2",
        });
      } finally {
        secrets.restore();
      }
    });

    test("reports nothing to do when every expected secret is present", async () => {
      const site = await createTestBuiltSite({
        dbToken: "tok",
        dbUrl: "libsql://u",
        hostingId: "7102",
        name: "All Present Site",
      });
      const present = expectedSiteSecrets(site).map(([name]) => name);
      const secrets = stubSecrets(present);
      try {
        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/add-secrets`,
        );
        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/secrets`,
          "No missing secrets — nothing to set",
        )(response);
        expect(secrets.setCalls.length).toBe(0);
      } finally {
        secrets.restore();
      }
    });

    test("surfaces an error when a secret cannot be set", async () => {
      const site = await createTestBuiltSite({
        hostingId: "7103",
        name: "Push Fail Site",
      });
      const listStub = stub(bunnyCdnApi, "listEdgeScriptSecrets", () =>
        Promise.resolve({ ok: true as const, secrets: [] }),
      );
      const setStub = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
        Promise.resolve({ error: "edge push failed", ok: false as const }),
      );
      try {
        const { response } = await adminFormPost(
          `/admin/built-sites/${site.id}/add-secrets`,
        );
        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/secrets`,
          expect.stringContaining("Secrets could not be set"),
          false,
        )(response);
      } finally {
        listStub.restore();
        setStub.restore();
      }
    });

    test("returns 404 for a non-existent built site", async () => {
      const { response } = await adminFormPost(
        "/admin/built-sites/999999/add-secrets",
      );
      expect(response.status).toBe(404);
    });
  },
);
