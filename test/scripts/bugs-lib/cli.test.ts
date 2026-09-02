import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type IssueBundle,
  type IssueSummary,
  runBugsCli,
  USAGE,
} from "#scripts/bugs-lib.ts";
import { stubFetchEachTest } from "#test-utils/fetch-stub.ts";
import {
  BASE,
  ENV,
  EVENT,
  EVENT_ID,
  ISSUE,
  ISSUE_ID,
  ioWith,
  json,
  OTHER_ISSUE_ID,
  page,
  route,
  singleProjectRoutes,
} from "./support.ts";

describe("runBugsCli", () => {
  const fetcher = stubFetchEachTest(new Response("{}", { status: 404 }));
  const answerBy = route(fetcher);

  test("prints usage and fails without arguments", async () => {
    const { io, err } = ioWith([]);

    expect(await runBugsCli(io)).toBe(1);
    expect(err[0]).toBe(USAGE);
  });

  test("prints usage and succeeds with --help", async () => {
    const { io, err } = ioWith(["--help"]);

    expect(await runBugsCli(io)).toBe(0);
    expect(err[0]).toBe(USAGE);
  });

  test("prints usage and succeeds with -h", async () => {
    const { io, err } = ioWith(["-h"]);

    expect(await runBugsCli(io)).toBe(0);
    expect(err[0]).toBe(USAGE);
  });

  test("treats --help=false as no help request and fails without arguments", async () => {
    const { io, err } = ioWith(["--help=false"]);

    expect(await runBugsCli(io)).toBe(1);
    expect(err[0]).toBe(USAGE);
  });

  test("refuses an --events value that is not a whole number", async () => {
    const { io, err } = ioWith([ISSUE_ID, "--events", "latest"], ENV);

    expect(await runBugsCli(io)).toBe(1);
    expect(err[0]).toContain("must be a whole number");
    expect(err[1]).toBe(USAGE);
  });

  test("refuses an empty --events value", async () => {
    const { io, err } = ioWith([ISSUE_ID, "--events", ""], ENV);

    expect(await runBugsCli(io)).toBe(1);
    expect(err[0]).toContain("must be a whole number");
  });

  test("prints one bundle for one issue", async () => {
    answerBy((url) => {
      if (url.endsWith(`/issues/${ISSUE_ID}/`)) return json(ISSUE);
      if (url.includes("/events/?issue="))
        return json(page([{ id: EVENT_ID }]));
      return json(EVENT);
    });
    const { io, out, err } = ioWith(
      [`https://bugs.chobble.com/issues/issue/${ISSUE_ID}/`],
      ENV,
    );

    expect(await runBugsCli(io)).toBe(0);

    expect(err[0]).toBe(
      `Fetching https://bugs.chobble.com/issues/issue/${ISSUE_ID}/`,
    );
    expect(out[0]!.startsWith('{\n  "')).toBe(true);
    const bundle = JSON.parse(out[0]!) as IssueBundle;
    expect(bundle.issue_url).toBe(`${BASE}/issues/issue/${ISSUE_ID}/`);
    expect(bundle.events.length).toBe(1);
  });

  test("prints an array for several issues", async () => {
    answerBy((url) => {
      if (url.includes("/issues/TIC-1/")) return json(ISSUE);
      if (url.includes("/issues/TIC-3/")) {
        return json({ ...ISSUE, friendly_id: "TIC-3", id: OTHER_ISSUE_ID });
      }
      if (url.includes("/events/?issue=")) return json(page([]));
      return json({ detail: "not found" }, 404);
    });
    const { io, out } = ioWith(["TIC-1", "TIC-3"], ENV);

    expect(await runBugsCli(io)).toBe(0);

    expect(out[0]!.startsWith("[\n  {")).toBe(true);
    const bundles = JSON.parse(out[0]!) as IssueBundle[];
    expect(bundles.map((bundle) => bundle.issue.friendly_id)).toEqual([
      "TIC-1",
      "TIC-3",
    ]);
  });

  test("prints summaries for list", async () => {
    answerBy(singleProjectRoutes([ISSUE]));
    const { io, out } = ioWith(["list"], ENV);

    expect(await runBugsCli(io)).toBe(0);

    expect(out[0]!.startsWith("[\n  {")).toBe(true);
    const summaries = JSON.parse(out[0]!) as IssueSummary[];
    expect(summaries.map((issue) => issue.friendly_id)).toEqual(["TIC-1"]);
  });

  test("reports a configuration problem and fails", async () => {
    const { io, err } = ioWith(["list"], {});

    expect(await runBugsCli(io)).toBe(1);
    expect(err[0]).toBe(
      "error: Set SENTRY_BASE_URL in .env, for example https://bugs.chobble.com",
    );
  });

  test("refuses issue ids beside the list command", async () => {
    const { io, err } = ioWith(["list", ISSUE_ID], ENV);

    expect(await runBugsCli(io)).toBe(1);
    expect(err[0]).toBe("The list command takes no issue ids.");
  });
});
