import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type {
  ManualOffline,
  Person,
} from "#src/ui/client/admin/manual-search.ts";
import type { Say } from "#src/ui/client/scanner-messages.ts";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import {
  type ManualCheckinPage,
  useManualCheckinPage,
} from "./manual-checkin/fixture.ts";

/** The labels the options show, in order. */
const optionLabels = (page: ManualCheckinPage): (string | null)[] =>
  [...page.listbox.querySelectorAll("[role=option]")].map(
    (option) => option.textContent,
  );

/** An offline side that answers from a fixed saved list and records what
 * the form asks of it. */
const savedListOffline = (active: boolean, saved: boolean) => {
  const searched: string[] = [];
  const picked: string[] = [];
  const ada: Person = {
    checkIn: async (say: Say) => {
      picked.push("Ada");
      say("Queued.", "success");
      return true;
    },
    details: ["Camping · 12 Jun"],
    key: "saved-digest",
    name: "Ada",
    quantity: 2,
  };
  const offline: ManualOffline = {
    active: () => active,
    search: (text: string, say: Say) => {
      searched.push(text);
      if (!saved) say("No saved list.", "error");
      return saved ? [ada] : null;
    },
  };
  return { offline, picked, searched };
};

describe("manual check-in search", () => {
  const { fresh } = useManualCheckinPage();

  test("asks the door's search route and shows what it found", async () => {
    const page = fresh(null);
    using fetchStub = stubFetch(
      Response.json({
        options: [
          {
            attendeeId: 41,
            details: ["Camping", "12 Jun"],
            name: "Ada & Bo",
            quantity: 2,
          },
          { attendeeId: 42, details: [], name: "Ada", quantity: 1 },
        ],
      }),
    );
    page.input.value = " ada b ";

    await page.submit();

    expect(fetchStub.calls.map((call) => String(call.args[0]))).toEqual([
      "/admin/listing/7/scan-search?q=ada%20b",
    ]);
    // A name shows as its own words, and several details join on one line.
    expect(optionLabels(page)).toEqual([
      "Ada & Bo (2 tickets) - Camping, 12 Jun",
      "Ada (1 pass)",
    ]);
    expect(page.listbox.classList.contains("hidden")).toBe(false);
    expect(page.status.classList.contains("hidden")).toBe(true);
    expect(page.buttonLabel()).toBe("Search");

    page.pick("42");
    expect(page.buttonLabel()).toBe("Check In");
    expect(page.input.value).toBe("Ada (1 pass)");
  });

  test("tells the door when the search finds nobody or does not work", async () => {
    const cases: [string, Response, string, string][] = [
      [
        "nobody matches",
        Response.json({ options: [] }),
        "Nobody matches.",
        "warning",
      ],
      [
        "the session expired",
        Response.json({ error: "Not authenticated" }, { status: 401 }),
        "Something went wrong. Reload this page, then try again.",
        "error",
      ],
      [
        "the role no longer reaches the door",
        Response.json({ error: "Forbidden" }, { status: 403 }),
        "Something went wrong. Reload this page, then try again.",
        "error",
      ],
      [
        "the door went away",
        Response.json({ status: "not_found" }, { status: 404 }),
        "Something went wrong. Reload this page, then try again.",
        "error",
      ],
      [
        "the server is in trouble",
        Response.json({}, { status: 500 }),
        "The search failed.",
        "error",
      ],
      [
        "another shape",
        Response.json({ options: [{ attendeeId: "41", name: "Ada" }] }),
        "Something went wrong. Reload this page, then try again.",
        "error",
      ],
    ];
    for (const [what, reply, words, type] of cases) {
      const page = fresh(null);
      using _fetch = stubFetch(reply);
      page.input.value = "Ada";
      await page.submit();
      expect(
        {
          labels: optionLabels(page),
          status: page.status.className,
          words: page.status.textContent,
        },
        what,
      ).toEqual({
        labels: [],
        status: `checkin-status checkin-status-${type}`,
        words,
      });
    }
  });

  test("searches the saved list while offline mode settles the door", async () => {
    const { offline, picked, searched } = savedListOffline(true, true);
    const page = fresh(offline);
    using fetchStub = stubFetch(Response.json({ options: [] }));
    page.input.value = "ad";

    await page.submit();
    expect(searched).toEqual(["ad"]);
    expect(optionLabels(page)).toEqual(["Ada (2 tickets) - Camping · 12 Jun"]);
    // The queue knows a saved person by their ticket digest.
    expect(
      page.listbox.querySelector<HTMLElement>("[role=option]")?.dataset.key,
    ).toBe("saved-digest");

    const option = page.listbox.querySelector<HTMLElement>("[role=option]")!;
    option.click();
    await page.submit();

    expect(picked).toEqual(["Ada"]);
    expect(page.status.textContent).toBe("Queued.");
    expect(page.buttonLabel()).toBe("Search");
    expect(page.input.value).toBe("");
    // Nothing left the page: the saved list answered and the queue took it.
    expect(fetchStub.calls.length).toBe(0);
  });

  test("shows no list when the device has no saved list", async () => {
    const { offline } = savedListOffline(true, false);
    const page = fresh(offline);
    page.input.value = "Ada";

    await page.submit();

    expect(page.status.textContent).toBe("No saved list.");
    expect(optionLabels(page)).toEqual([]);
  });

  test("asks the search route while the offline side is idle", async () => {
    const { offline, searched } = savedListOffline(false, true);
    const page = fresh(offline);
    using fetchStub = stubFetch(Response.json({ options: [] }));
    page.input.value = "Ada";

    await page.submit();

    expect(searched).toEqual([]);
    expect(fetchStub.calls.length).toBe(1);
  });
});
