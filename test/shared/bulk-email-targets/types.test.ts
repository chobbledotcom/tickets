/** Direct tests for the shared lockups in the target types module. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  BULK_COMPOSE_COPY,
  fixedControl,
  fromRawField,
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
});
