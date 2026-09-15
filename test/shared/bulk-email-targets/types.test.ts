/** Direct tests for the shared lockups in the target types module. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  AUDIENCES,
  BULK_COMPOSE_COPY,
  fixedControl,
  fromRawField,
  isBulkEmailTarget,
} from "#shared/bulk-email-targets/types.ts";

describe("the bulk-email target types module", () => {
  test("fixedControl round-trips one pre-chosen field value", () => {
    expect(fixedControl("attendee", "token-1")).toEqual({
      fields: [["attendee", "token-1"]],
      mode: "fixed",
    });
  });

  test("fromRawField skips a blank value and parses a claimed one", () => {
    const fromRaw = fromRawField((raw: string) => ({
      kind: "attendee",
      token: raw,
    }));
    expect(fromRaw("")).toBeUndefined();
    expect(fromRaw(null)).toBeUndefined();
    expect(fromRaw("token-1")).toEqual({
      kind: "attendee",
      token: "token-1",
    });
  });

  test("the bulk compose copy carries a heading and an intro", () => {
    expect(BULK_COMPOSE_COPY.heading).toBe("Send a bulk email");
    expect(BULK_COMPOSE_COPY.intro).toContain("Choose who receives it");
  });

  test("each audience names itself and who it covers", () => {
    expect(AUDIENCES).toEqual([
      {
        description: "Everyone booked onto a listing that is currently active.",
        id: "active",
        label: "Active listing attendees",
      },
      {
        description:
          "Everyone booked onto an active listing that has not happened yet.",
        id: "upcoming",
        label: "Upcoming listing attendees",
      },
      {
        description: "Everyone who has ever registered, across every listing.",
        id: "all",
        label: "All attendees",
      },
    ]);
  });

  test("the target guard names each kind a target can have", () => {
    // A blanked kind literal widens the variant: a target of that kind no
    // longer parses, so a stored draft would read as invalid.
    expect(isBulkEmailTarget({ audience: "active", kind: "audience" })).toBe(
      true,
    );
    expect(isBulkEmailTarget({ kind: "listing", listingId: 1 })).toBe(true);
    expect(
      isBulkEmailTarget({
        day: "2026-01-01",
        kind: "listing-day",
        listingId: 1,
      }),
    ).toBe(true);
    expect(isBulkEmailTarget({ kind: "attendee", token: "token-1" })).toBe(
      true,
    );
    expect(isBulkEmailTarget({ kind: "" })).toBe(false);
  });
});
