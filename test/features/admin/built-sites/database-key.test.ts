/** The database key option on a built site's Secrets tab: which sites can
 *  change their key, and what the two rotation steps answer. */

import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import { findBuiltSiteByIdPrimary } from "#db/built-sites.ts";
import { readOnlyBlock } from "#routes/app/read-only.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { bunnyDbProvider } from "#shared/bunny-db.ts";
import { DATABASE_KEY_PAUSE_SECONDS } from "#shared/database-key-rotation.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { expectErrorFlash } from "#test-utils/assertions/redirect.ts";
import {
  expectFlashRedirect,
  expectIncludesAll,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestBuiltSite } from "#test-utils/db-helpers/built-sites.ts";
import { withMocks } from "#test-utils/mocks.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

const BUNNY_DB_URL = "libsql://managed-key.lite.bunnydb.net";

const LOCAL_DB_URL = "file:local.db";

const ROTATION_STARTED = "Rotated database";

const LINK_EXPIRED =
  "This rotation link is no longer valid. Start the rotation again.";

const LOCAL_DB_MESSAGE =
  "This site's database is a local file, so its key cannot be changed.";

/** The Secrets tab's body for one site, with no secrets set yet. */
const secretsTabHtml = async (siteId: number): Promise<string> => {
  using _secrets = stub(bunnyCdnApi, "listEdgeScriptSecrets", () =>
    Promise.resolve({ ok: true as const, secrets: [] }),
  );
  return await (await adminGet(`/admin/built-sites/${siteId}/secrets`)).text();
};

/** The key the site record holds now. */
const storedKey = async (siteId: number): Promise<string> =>
  (await findBuiltSiteByIdPrimary(siteId))!.dbToken;

/** Every activity-log line that started a rotation. */
const rotationLogs = async (): Promise<number> =>
  (await getAllActivityLog()).filter((entry) =>
    entry.message.startsWith(ROTATION_STARTED),
  ).length;

/** The signed link out of the timer page's meta refresh. */
const finishUrlOf = (html: string): string => {
  const match = new RegExp(
    `content="${DATABASE_KEY_PAUSE_SECONDS};url=([^"]+)"`,
  ).exec(html);
  const url = match?.[1];
  if (url === undefined) throw new Error("The timer page carries no link");
  return url.replaceAll("&amp;", "&");
};

/** One site whose database key the host manages. */
const keySite = (name = "Key Route"): Promise<{ id: number }> =>
  createTestBuiltSite({
    dbToken: "old-key",
    dbUrl: BUNNY_DB_URL,
    hostingId: "8400",
    name,
  });

/** Step one of a rotation for one site: its answer. */
const postRotation = async (siteId: number): Promise<Response> =>
  (await adminFormPost(`/admin/built-sites/${siteId}/rotate-database-key`))
    .response;

/** The signed step-two link a started rotation answers. */
const timerPageLink = async (siteId: number): Promise<string> =>
  finishUrlOf(await (await postRotation(siteId)).text());

/** Open one rotation link as the timer page does, once the pause has passed.
 * The request runs inside the faked clock, so its answer comes back before the
 * clock is restored. */
const openLink = async (url: string): Promise<Response> => {
  using time = new FakeTime(Date.now());
  time.tick(DATABASE_KEY_PAUSE_SECONDS * 1000);
  const response = await adminGet(url);
  return response;
};

/** Step two for one site: the timer page's link, opened. */
const finishRotation = async (siteId: number): Promise<Response> =>
  openLink(await timerPageLink(siteId));

/** The calls a rotation test can read after its faked answers ran. */
interface RotationCalls {
  invalidate: { calls: readonly { args: readonly unknown[] }[] };
  issue: { calls: readonly unknown[] };
  pushes: unknown[][];
}

/** The answers the provider steps and the secret push give. A step a test
 * leaves out answers success. */
interface KeyAnswers {
  invalidate?: Result<void>;
  issue?: Result<string>;
  push?: Result<void>;
}

/** Run one rotation test with the provider steps and the push faked. */
const withKeyAnswers = (
  answers: KeyAnswers,
  run: (calls: RotationCalls) => Promise<void>,
): Promise<void> => {
  const pushes: unknown[][] = [];
  return withMocks(
    () => ({
      invalidate: stub(bunnyDbProvider, "invalidateDatabaseTokens", () =>
        Promise.resolve(answers.invalidate ?? okResult(undefined)),
      ),
      issue: stub(bunnyDbProvider, "issueDatabaseToken", () =>
        Promise.resolve(answers.issue ?? okResult("new-key")),
      ),
      push: stub(bunnyCdnApi, "setEdgeScriptSecret", (...sent) => {
        pushes.push(sent);
        return Promise.resolve(answers.push ?? okResult(undefined));
      }),
    }),
    async ({ invalidate, issue }) => {
      await run({ invalidate, issue, pushes });
    },
  );
};

/** Check a refused rotation link made no new key: the site keeps the one it
 * had. */
const expectLinkRefused = async (
  response: Response,
  calls: RotationCalls,
  siteId: number,
): Promise<void> => {
  expectErrorFlash(response, LINK_EXPIRED);
  expect(calls.issue.calls.length).toBe(0);
  expect(await storedKey(siteId)).toBe("old-key");
};

/** The one site a route case changes, with its key before the rotation. */
const caseSite = (database: "bunny" | "local"): Promise<{ id: number }> =>
  createTestBuiltSite({
    dbToken: "old-key",
    dbUrl: database === "local" ? LOCAL_DB_URL : BUNNY_DB_URL,
    hostingId: "8400",
    name: "Key Route",
  });

/** The faked answers one route case hands the provider steps and the push. */
const answersOf = (
  invalidateError: string,
  issueError: string,
  pushError: string,
): KeyAnswers => ({
  ...(invalidateError ? { invalidate: errorResult(invalidateError) } : {}),
  ...(issueError ? { issue: errorResult(issueError) } : {}),
  ...(pushError ? { push: errorResult(pushError) } : {}),
});

/** Check the flash the case's answer carries: its error, or the success line. */
const expectCaseFlash = async (
  step: "start" | "finish",
  flash: string,
  siteId: number,
): Promise<void> => {
  const response =
    step === "start"
      ? await postRotation(siteId)
      : await finishRotation(siteId);
  if (flash) {
    expectErrorFlash(response, flash);
    return;
  }
  await expectFlashRedirect(
    `/admin/built-sites/${siteId}/secrets`,
    "Database key rotated.",
  )(response);
};

/** Check the calls one route case made on the provider and the hosting API. */
const expectCaseCalls = (
  database: "bunny" | "local",
  step: "start" | "finish",
  newKeyIssued: boolean,
  calls: RotationCalls,
): void => {
  expect(calls.invalidate.calls.length).toBe(database === "local" ? 0 : 1);
  expect(calls.issue.calls.length).toBe(step === "finish" ? 1 : 0);
  expect(calls.pushes).toEqual(
    newKeyIssued ? [[8400, "DB_TOKEN", "new-key"]] : [],
  );
};

describeWithEnv(
  "built site database key option",
  {
    db: true,
    env: { BUNNY_API_KEY: "host-key", CAN_BUILD_SITES: "true" },
  },
  () => {
    test("offers the rotation for a database the host manages", async () => {
      const site = await keySite("Managed Key");

      const html = await secretsTabHtml(site.id);

      expectIncludesAll(html, [
        "Database key",
        `action="/admin/built-sites/${site.id}/rotate-database-key"`,
        "Rotate database key",
        "Bunny",
      ]);
      // The key itself never reaches the page.
      assert(!html.includes("old-key"));
    });

    test("names the refusal for a local database instead of a button", async () => {
      const site = await createTestBuiltSite({
        dbUrl: LOCAL_DB_URL,
        hostingId: "8301",
        name: "Local Key",
      });

      const html = await secretsTabHtml(site.id);

      expectIncludesAll(html, [LOCAL_DB_MESSAGE]);
      assert(!html.includes("rotate-database-key"));
    });
  },
);

/* jscpd:ignore-start -- a list of strings, not code */
/** Each route case: the site's database, the step it stops in, the errors the
 * two provider steps and the push answer, and the message the operator reads. A
 * blank message means the rotation landed. */
const ROUTE_CASES: [
  name: string,
  database: "bunny" | "local",
  step: "start" | "finish",
  invalidateError: string,
  issueError: string,
  pushError: string,
  flash: string,
][] = [
  [
    "makes, stores and sends the new key when the timer link opens",
    "bunny",
    "finish",
    "",
    "",
    "",
    "",
  ],
  [
    "reports a refused key removal and keeps the stored key",
    "bunny",
    "start",
    "Revoke database tokens failed (500)",
    "",
    "",
    "Revoke database tokens failed (500)",
  ],
  [
    "refuses a database the host does not manage, and stores nothing",
    "local",
    "start",
    "",
    "",
    "",
    "This site's database is a local file, so its key cannot be changed.",
  ],
  [
    "reports a refused new key when the timer link opens",
    "bunny",
    "finish",
    "",
    "Rotate database key failed (500)",
    "",
    "Rotate database key failed (500)",
  ],
  [
    "keeps the new key stored when the push fails, so a retry can finish",
    "bunny",
    "finish",
    "",
    "",
    "Set secret DB_TOKEN failed (500)",
    "The database key changed, but the site did not receive it. Rotate the key again to retry. Set secret DB_TOKEN failed (500)",
  ],
];
/* jscpd:ignore-end */

describeWithEnv(
  "built site database key route",
  {
    db: true,
    env: { BUNNY_API_KEY: "host-key", CAN_BUILD_SITES: "true" },
  },
  () => {
    for (const [
      name,
      database,
      step,
      invalidateError,
      issueError,
      pushError,
      flash,
    ] of ROUTE_CASES) {
      test(name, async () => {
        const site = await caseSite(database);
        const newKeyIssued = step === "finish" && !issueError;

        await withKeyAnswers(
          answersOf(invalidateError, issueError, pushError),
          async (calls) => {
            await expectCaseFlash(step, flash, site.id);
            expectCaseCalls(database, step, newKeyIssued, calls);
          },
        );
        expect(await storedKey(site.id)).toBe(
          newKeyIssued ? "new-key" : "old-key",
        );
        expect(await rotationLogs()).toBe(
          newKeyIssued && !pushError && !flash ? 1 : 0,
        );
      });
    }

    test("answers the timer page with its one-minute reload", async () => {
      const site = await caseSite("bunny");

      await withKeyAnswers({}, async ({ invalidate, issue }) => {
        const response = await postRotation(site.id);

        expect(response.status).toBe(200);
        expectIncludesAll(await response.text(), [
          "Rotating the database key",
          "It needs a short pause before it can make the new key.",
          "This page waits one minute.",
          `content="${DATABASE_KEY_PAUSE_SECONDS};url=/admin/built-sites/${site.id}/rotate-database-key/complete?exp=`,
        ]);
        expect(invalidate.calls.map((call) => call.args[0])).toEqual([
          BUNNY_DB_URL,
        ]);
        // The new key waits for the timer.
        expect(issue.calls.length).toBe(0);
      });
      expect(await storedKey(site.id)).toBe("old-key");
    });

    test("refuses the timer link until the pause has passed", async () => {
      const site = await caseSite("bunny");

      await withKeyAnswers({}, async (calls) => {
        const link = await timerPageLink(site.id);

        await expectLinkRefused(await adminGet(link), calls, site.id);
      });
    });

    test("keeps the timer link served in read-only mode", () => {
      // The operator cannot start a rotation then, and the link that finishes
      // one still opens: a blocked GET would leave the site with no key.
      expect(
        readOnlyBlock(
          "/admin/built-sites/42/rotate-database-key/complete",
          "GET",
          false,
        ),
      ).toBeNull();
    });

    test("keeps the old key when the link has no signature", async () => {
      const { id } = await keySite();

      using _issue = stub(bunnyDbProvider, "issueDatabaseToken", () =>
        Promise.resolve(okResult("new-key")),
      );
      const response = await adminGet(
        `/admin/built-sites/${id}/rotate-database-key/complete`,
      );

      expectErrorFlash(response, LINK_EXPIRED);
      expect(await storedKey(id)).toBe("old-key");
    });

    test("refuses a timer link signed for another site", async () => {
      const first = await keySite("First");
      const second = await keySite("Second");

      await withKeyAnswers({}, async (calls) => {
        const moved = (await timerPageLink(first.id)).replace(
          `/admin/built-sites/${first.id}/`,
          `/admin/built-sites/${second.id}/`,
        );

        await expectLinkRefused(await openLink(moved), calls, second.id);
      });
    });
  },
);
