import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { fetchIssueBundle, fetchIssueSummaries } from "#scripts/bugs-lib.ts";
import { stubFetchEachTest, type TestFetch } from "#test-utils/fetch-stub.ts";
import {
  BASE,
  CONFIG,
  callsOf,
  EVENT,
  EVENT_2_ID,
  EVENT_ID,
  eventDetail,
  ISSUE,
  ISSUE_ID,
  json,
  OTHER_ISSUE_ID,
  page,
  route,
  singleProjectRoutes,
} from "./support.ts";

describe("fetchIssueBundle", () => {
  const fetcher = stubFetchEachTest(new Response("{}", { status: 404 }));
  const answerBy = route(fetcher);

  test("fetches the issue and its latest event, and keeps the raw payloads", async () => {
    answerBy((url) => {
      if (url === `${BASE}/api/canonical/0/issues/${ISSUE_ID}/`)
        return json(ISSUE);
      if (
        url === `${BASE}/api/canonical/0/events/?issue=${ISSUE_ID}&order=desc`
      ) {
        return json(page([{ id: EVENT_ID }]));
      }
      if (url === `${BASE}/api/canonical/0/events/${EVENT_ID}/`)
        return json(EVENT);
      return json({ detail: "not found" }, 404);
    });

    const bundle = await fetchIssueBundle(
      CONFIG,
      `https://bugs.chobble.com/issues/issue/${ISSUE_ID}/`,
      1,
    );

    const calls = callsOf(fetcher);
    expect(calls.map((call) => call.url)).toEqual([
      `${BASE}/api/canonical/0/issues/${ISSUE_ID}/`,
      `${BASE}/api/canonical/0/events/?issue=${ISSUE_ID}&order=desc`,
      `${BASE}/api/canonical/0/events/${EVENT_ID}/`,
    ]);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
    expect(headers.Accept).toBe("application/json");
    expect(bundle.issue_url).toBe(`${BASE}/issues/issue/${ISSUE_ID}/`);
    expect(bundle.issue.friendly_id).toBe("TIC-1");
    expect(bundle.issue.bugsink_extra).toBe("kept");
    expect(bundle.events.length).toBe(1);
    expect(bundle.events[0]!.stacktrace_md).toBe(EVENT.stacktrace_md);
    expect(bundle.events[0]!.data).toEqual(EVENT.data);
  });

  test("with an event count of 0, fetches the issue only", async () => {
    answerBy((url) => {
      if (url.endsWith(`/issues/${ISSUE_ID}/`)) return json(ISSUE);
      return json({ detail: "not found" }, 404);
    });

    const bundle = await fetchIssueBundle(CONFIG, ISSUE_ID, 0);

    expect(bundle.events).toEqual([]);
    expect(callsOf(fetcher).length).toBe(1);
  });

  test("follows pagination until it has the wanted number of events", async () => {
    answerBy((url) => {
      if (url.endsWith(`/issues/${ISSUE_ID}/`)) return json(ISSUE);
      if (url.includes("cursor=2")) return json(page([{ id: EVENT_2_ID }]));
      if (url.includes("/events/?issue=")) {
        return json(
          page(
            [{ id: EVENT_ID }],
            `${BASE}/api/canonical/0/events/?issue=${ISSUE_ID}&cursor=2`,
          ),
        );
      }
      return json(eventDetail(url.split("/").slice(-2)[0]!));
    });

    const bundle = await fetchIssueBundle(CONFIG, ISSUE_ID, 2);

    expect(bundle.events.map((event) => event.id)).toEqual([
      EVENT_ID,
      EVENT_2_ID,
    ]);
    expect(
      callsOf(fetcher).filter((call) => call.url.includes("cursor=2")).length,
    ).toBe(1);
  });

  test("stops reading pages once the event limit is reached", async () => {
    answerBy((url) => {
      if (url.endsWith(`/issues/${ISSUE_ID}/`)) return json(ISSUE);
      if (url.includes("cursor=2")) return json(page([]));
      if (url.includes("/events/?issue=")) {
        return json(
          page(
            [{ id: EVENT_ID }, { id: EVENT_2_ID }],
            `${BASE}/api/canonical/0/events/?cursor=2`,
          ),
        );
      }
      return json(eventDetail(url.split("/").slice(-2)[0]!));
    });

    const bundle = await fetchIssueBundle(CONFIG, ISSUE_ID, 1);

    expect(bundle.events.length).toBe(1);
    expect(callsOf(fetcher).some((call) => call.url.includes("cursor=2"))).toBe(
      false,
    );
  });

  test("reports a missing issue with its status and body", async () => {
    answerBy(() => json({ detail: "issue TIC-999 unknown" }, 404));

    await expect(fetchIssueBundle(CONFIG, "TIC-999", 1)).rejects.toThrow(
      "Bugsink returned 404",
    );
    await expect(fetchIssueBundle(CONFIG, "TIC-999", 1)).rejects.toThrow(
      '{"detail":"issue TIC-999 unknown"}',
    );
  });

  test("reports an unexpected payload shape", async () => {
    answerBy(() => json({ id: ISSUE_ID, project: "one" }));

    await expect(fetchIssueBundle(CONFIG, ISSUE_ID, 1)).rejects.toThrow(
      "unexpected shape",
    );
  });

  test("reports a payload that fails at the root", async () => {
    answerBy(() => json("nope"));

    await expect(fetchIssueBundle(CONFIG, ISSUE_ID, 1)).rejects.toThrow(
      "unexpected shape for https://bugs.example.com",
    );
    await expect(fetchIssueBundle(CONFIG, ISSUE_ID, 1)).rejects.toThrow(
      " at root",
    );
  });

  test("reports a non-JSON body", async () => {
    fetcher.reply(new Response("<html>busy</html>", { status: 200 }));

    await expect(fetchIssueBundle(CONFIG, ISSUE_ID, 1)).rejects.toThrow(
      "non-JSON",
    );
  });
});

describe("fetchIssueSummaries", () => {
  const fetcher: TestFetch = stubFetchEachTest(
    new Response("{}", { status: 404 }),
  );
  const answerBy = route(fetcher);

  const RESOLVED = {
    ...ISSUE,
    calculated_value: "old boom",
    friendly_id: "TIC-2",
    id: OTHER_ISSUE_ID,
    is_resolved: true,
    last_seen: "2026-09-01T10:00:00Z",
  };

  const OTHER_UNRESOLVED = {
    ...ISSUE,
    calculated_value: "other boom",
    friendly_id: "TIC-3",
    id: OTHER_ISSUE_ID,
    last_seen: "2026-09-01T12:00:00Z",
  };

  test("lists unresolved issues of every project, newest first", async () => {
    answerBy((url) => {
      if (url.endsWith("/api/canonical/0/projects/")) {
        return json(
          page([
            { id: 1, name: "Tickets", slug: "tickets" },
            { id: 2, name: "Website", slug: "website" },
          ]),
        );
      }
      if (url.includes("project=1")) return json(page([ISSUE]));
      if (url.includes("project=2")) {
        return json(page([RESOLVED, OTHER_UNRESOLVED]));
      }
      return json({ detail: "not found" }, 404);
    });

    const summaries = await fetchIssueSummaries(CONFIG, false);

    expect(summaries.map((issue) => issue.friendly_id)).toEqual([
      "TIC-1",
      "TIC-3",
    ]);
    expect(summaries[0]).toEqual({
      events: 3,
      first_seen: "2026-09-01T10:00:00Z",
      friendly_id: "TIC-1",
      id: ISSUE_ID,
      issue_url: `${BASE}/issues/issue/${ISSUE_ID}/`,
      last_seen: "2026-09-02T11:00:00Z",
      muted: false,
      project: "Tickets",
      project_id: 1,
      stored_events: 3,
      type: "Error",
      value: "boom",
    });
  });

  test("with the flag, resolved issues are listed too", async () => {
    answerBy(singleProjectRoutes([RESOLVED]));

    const summaries = await fetchIssueSummaries(CONFIG, true);

    expect(summaries.map((issue) => issue.friendly_id)).toEqual(["TIC-2"]);
  });
});
