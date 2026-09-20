/** The edit save path directly: the role rule over submitted aggregates. The
 * route wiring has its own suite; this pins the role decision itself. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { parseAggregatesForRole } from "#routes/admin/listings-edit-save.ts";
import { formDataToParams } from "#routes/csrf.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { AdminSession } from "#types";

const sessionOf = (adminLevel: "owner" | "editor"): AdminSession =>
  ({ adminLevel }) as AdminSession;

/** An edit form's counters: both trigger-maintained fields always submit. */
const formWithAggregates = (
  bookedQuantity: string,
  ticketsCount: string,
): FormParams => {
  const body = new FormData();
  body.set("booked_quantity", bookedQuantity);
  body.set("tickets_count", ticketsCount);
  return formDataToParams(body);
};

describe("edit save path > aggregates by role", () => {
  test("an editor's crafted owner-level figures are ignored, never trusted", () => {
    const result = parseAggregatesForRole(
      sessionOf("editor"),
      formWithAggregates("99", "99"),
    );
    expect(result).toEqual({ input: null, ok: true });
  });

  test("staff submissions parse the editable aggregates", () => {
    const result = parseAggregatesForRole(
      sessionOf("owner"),
      formWithAggregates("12", "13"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({ booked_quantity: 12, tickets_count: 13 });
    }
  });
});
