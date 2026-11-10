/** The database key option on a built site's Secrets tab: which sites can
 *  change their key, and what the two rotation steps answer. */

import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import { findBuiltSiteByIdPrimary, updateBuiltSite } from "#db/built-sites.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import { bunnyDbProvider } from "#shared/bunny-db.ts";
import { DATABASE_KEY_PAUSE_SECONDS } from "#shared/database-key-rotation.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import {
  expectErrorFlash,
  expectFlashRedirect,
} from "#test-utils/assertions/redirect.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestBuiltSite } from "#test-utils/db-helpers/built-sites.ts";
import { withEnv } from "#test-utils/env.ts";
import { withMocks } from "#test-utils/mocks.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

const BUNNY_DB_URL = "libsql://managed-key.lite.bunnydb.net";

const LOCAL_DB_URL = "file:local.db";

const ROTATION_STARTED = "Rotated database";

const ROTATED = "Database key rotated.";

const LINK_EXPIRED =
  "This rotation link is no longer valid. Start the rotation again.";

const NO_ROTATION_WAITS =
  "No rotation waits for this database. Start the rotation again.";

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
const keySite = (
  name = "Key Route",
  dbUrl = BUNNY_DB_URL,
): Promise<{ id: number }> =>
  createTestBuiltSite({
    dbToken: "old-key",
    dbUrl,
    hostingId: "8400",
    name,
  });

/** The timer page one site's path serves. */
const timerPagePath = (siteId: number): string =>
  `/admin/built-sites/${siteId}/rotate-database-key`;

/** Step one of a rotation for one site: its answer. */
const postRotation = async (siteId: number): Promise<Response> =>
  (await adminFormPost(timerPagePath(siteId))).response;

/** The timer page a started rotation redirects to. */
const timerPageOf = async (siteId: number): Promise<Response> => {
  const post = await postRotation(siteId);
  expect(post.status).toBe(302);
  expect(post.headers.get("location")).toBe(timerPagePath(siteId));
  return await adminGet(timerPagePath(siteId));
};

/** The signed step-two link the timer page carries. */
const timerPageLink = async (siteId: number): Promise<string> =>
  finishUrlOf(await (await timerPageOf(siteId)).text());

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

/** Run one route test for a site whose key the host manages, with its provider
 * calls and secret push faked. */
const withKeySite = (
  answers: KeyAnswers,
  run: (site: { id: number }, calls: RotationCalls) => Promise<void>,
): Promise<void> =>
  withKeyAnswers(answers, async (calls) => {
    await run(await caseSite("bunny"), calls);
  });

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
  keySite("Key Route", database === "local" ? LOCAL_DB_URL : BUNNY_DB_URL);

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
    ROTATED,
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

    test("answers the POST with a redirect to the timer page", async () => {
      await withKeySite({}, async (site, { invalidate, issue }) => {
        const response = await postRotation(site.id);

        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe(timerPagePath(site.id));
        expect(invalidate.calls.map((call) => call.args[0])).toEqual([
          BUNNY_DB_URL,
        ]);
        // The new key waits for the timer.
        expect(issue.calls.length).toBe(0);
        expect(await storedKey(site.id)).toBe("old-key");
      });
    });

    test("serves the timer page with its one-minute reload", async () => {
      await withKeySite({}, async (site) => {
        const response = await timerPageOf(site.id);

        expect(response.status).toBe(200);
        expectIncludesAll(await response.text(), [
          "Rotating the database key",
          "It needs a short pause before it can make the new key.",
          "This page waits one minute.",
          `content="${DATABASE_KEY_PAUSE_SECONDS};url=/admin/built-sites/${site.id}/rotate-database-key/complete?`,
        ]);
      });
    });

    test("keeps the same link when the timer page reloads", async () => {
      await withKeySite({}, async (site) => {
        const first = await timerPageLink(site.id);
        const second = finishUrlOf(
          await (await adminGet(timerPagePath(site.id))).text(),
        );

        expect(second).toBe(first);
      });
    });

    test("opens a timer link once, after its pause, and never for an older start", async () => {
      await withKeySite({}, async (site, calls) => {
        using time = new FakeTime(Date.now());
        const first = await timerPageLink(site.id);

        // The pause is not over yet.
        await expectLinkRefused(await adminGet(first), calls, site.id);

        // A second start replaces the first, whose pause is still running when
        // it opens. It must not make a key during the newer start's pause.
        time.tick(30_000);
        const second = await timerPageLink(site.id);
        time.tick(30_000);
        await expectLinkRefused(await adminGet(first), calls, site.id);

        // The newer start's own pause ends, and its link makes one key.
        time.tick(30_000);
        await expectFlashRedirect(
          `/admin/built-sites/${site.id}/secrets`,
          ROTATED,
        )(await adminGet(second));
        expectErrorFlash(await adminGet(second), LINK_EXPIRED);
        expect(calls.issue.calls.length).toBe(1);
      });
    });

    for (const [state, error] of [
      [0, NO_ROTATION_WAITS],
      [
        -1,
        "A database key change is already running. Wait for it to finish before you try again.",
      ],
    ] as const) {
      test(`refuses the timer page for rotation state ${state}`, async () => {
        const site = await caseSite("bunny");
        await updateBuiltSite(site.id, () => ({
          databaseKeyRotationStarted: state,
        }));
        expectErrorFlash(await adminGet(timerPagePath(site.id)), error);
      });
    }

    for (const updating of [false, true]) {
      test(`only update mode blocks completion: ${updating}`, async () => {
        await withKeySite({}, async (site, calls) => {
          const link = await timerPageLink(site.id);
          using _mode = withEnv({
            READ_ONLY_FROM: "2020-01-01T00:00:00Z",
            UPDATE_IN_PROGRESS: updating ? "review" : undefined,
          });
          const response = await openLink(link);
          expect(calls.issue.calls.length).toBe(updating ? 0 : 1);
          if (updating)
            expect(response.headers.get("location")).toBe("/read-only");
          else
            await expectFlashRedirect(
              `/admin/built-sites/${site.id}/secrets`,
              ROTATED,
            )(response);
        });
      });
    }

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
