import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  addMissingSiteSecrets,
  expectedSiteSecrets,
  loadSiteSecretsStatus,
} from "#shared/site-secrets.ts";
import {
  recordingSecretSetter,
  stubEdgeScriptSecrets,
} from "#test-utils/builder-mocks.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { testBuiltSite } from "#test-utils/factories.ts";
import { withMocks } from "#test-utils/mocks.ts";

const buildSite = (): ReturnType<typeof testBuiltSite> =>
  testBuiltSite({
    dbToken: "tok-123",
    dbUrl: "libsql://site.turso.io",
    hostingId: "555",
  });

/** Names we'd copy to a fresh build of the standard test site. */
const expectedNamesFor = (site: ReturnType<typeof buildSite>): string[] =>
  expectedSiteSecrets(site).map(([name]) => name);

describeWithEnv(
  "site secret pairs",
  {
    env: {
      BOTPOISON_PUBLIC_KEY: "pk_host_9f3a",
      BOTPOISON_SECRET_KEY: "sk_host_7c2e",
      BUNNY_API_KEY: "k",
    },
  },
  () => {
    /** Live list holding every expected secret except the named one. */
    const presentExcept = (absent: string): string[] =>
      expectedNamesFor(buildSite()).filter((n) => n !== absent);

    /** Run the backfill against a live list that holds every expected secret
     * except the secret key, with a recording write double. */
    const backfillHalfPair = async (confirmPairs: boolean) => {
      const listStub = stubEdgeScriptSecrets(
        presentExcept("BOTPOISON_SECRET_KEY"),
      );
      const set = recordingSecretSetter();
      try {
        return {
          calls: set.calls,
          result: await addMissingSiteSecrets(buildSite(), confirmPairs),
        };
      } finally {
        listStub.restore();
        set.stub.restore();
      }
    };

    test("reports no pair conflict when the site holds neither key", async () => {
      await withMocks(
        () => stubEdgeScriptSecrets([]),
        async () => {
          const view = await loadSiteSecretsStatus(buildSite());
          expect(view.ok).toBe(true);
          if (!view.ok) return;
          expect(view.pairConflicts).toEqual([]);
        },
      );
    });

    test("reports the pair conflict from either half of the pair", async () => {
      for (const absent of ["BOTPOISON_SECRET_KEY", "BOTPOISON_PUBLIC_KEY"]) {
        await withMocks(
          () => stubEdgeScriptSecrets(presentExcept(absent)),
          async () => {
            const view = await loadSiteSecretsStatus(buildSite());
            expect(view.ok).toBe(true);
            if (!view.ok) return;
            expect(view.missing).toEqual([absent]);
            expect(view.pairConflicts).toEqual([absent]);
          },
        );
      }
    });

    test("refuses to complete a pair the site holds half of", async () => {
      const { calls, result } = await backfillHalfPair(false);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("The site already holds");
        expect(result.error).toContain("the two keys match");
        expect(result.error).toContain("Tick the confirm box");
      }
      // Nothing is copied while the conflict stands.
      expect(calls).toEqual([]);
    });

    test("completes the pair when the operator confirms", async () => {
      const { calls, result } = await backfillHalfPair(true);
      expect(result).toEqual({ added: ["BOTPOISON_SECRET_KEY"], ok: true });
      // Only the missing half is written; the held half is never touched.
      expect(calls).toEqual([["BOTPOISON_SECRET_KEY", "sk_host_7c2e"]]);
    });
  },
);
