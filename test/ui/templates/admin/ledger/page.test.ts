/** The ledger page's whole-page equality: the page renders the exact markup
 *  the parent build rendered for the same inputs, including the stats table
 *  and the range controls. */

import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  adminLedgerPage,
  type LedgerPageData,
} from "#templates/admin/ledger.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { assertPageMatchesSnapshot } from "#test-utils/page-snapshot.ts";
import { transfer } from "./helpers.ts";

const POPULATED: LedgerPageData = {
  dates: [
    { label: "Sunday 21 June 2026", selectable: true, value: "2026-06-21" },
  ],
  filters: {
    from: "2026-06-01",
    fromMonth: "2026-06",
    scope: { id: 4, kind: "listing", name: "Concert" },
    to: "2026-06-30",
    toMonth: "2026-06",
    view: "human",
  },
  groups: [{ id: 3, name: "Summer" }],
  listings: [{ id: 4, name: "Concert" }],
  names: {
    attendees: new Map([[1, "Ada"]]),
    listings: new Map(),
    modifiers: new Map(),
  },
  returnUrl: "/admin/ledger",
  stats: [
    { key: "Taken in", value: "€50.00" },
    { key: "Paid out", value: "€12.00" },
  ],
  statsHeading: "June 2026",
  today: "2026-06-21",
  transfers: [transfer()],
  truncated: false,
};

describe("the ledger page shell", () => {
  beforeAll(setupAdminPageTest);

  test("renders the plain ledger page identically to the parent build", () => {
    const html = adminLedgerPage(
      {
        dates: [],
        filters: {
          from: null,
          fromMonth: null,
          scope: { kind: "all" },
          to: null,
          toMonth: null,
          view: "human",
        },
        groups: [],
        listings: [],
        names: {
          attendees: new Map(),
          listings: new Map(),
          modifiers: new Map(),
        },
        returnUrl: "/admin/ledger",
        stats: [],
        statsHeading: null,
        today: "2026-06-21",
        transfers: [transfer()],
        truncated: false,
      },
      OWNER_SESSION,
    );

    assertPageMatchesSnapshot(
      new URL("./ledger.snapshot.html", import.meta.url),
      html,
    );
  });

  test("renders the stats-and-controls ledger identically to the parent", () => {
    const html = adminLedgerPage(POPULATED, OWNER_SESSION);

    assertPageMatchesSnapshot(
      new URL("./ledger-rich.snapshot.html", import.meta.url),
      html,
    );
  });
});
