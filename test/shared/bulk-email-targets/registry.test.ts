/** Direct tests for choosing a bulk-email target from a query or a form. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  targetAllowsEmpty,
  targetFromForm,
  targetFromQuery,
  targetIsSingleRecipient,
  targetLogListingId,
  targetQuery,
} from "#shared/bulk-email-targets/registry.ts";
import { FormParams } from "#shared/form-data.ts";

describe("the bulk-email target registry", () => {
  test("an empty query falls through to the default audience target", async () => {
    const target = await targetFromQuery(new URLSearchParams());
    expect(target).toEqual({ audience: "active", kind: "audience" });
  });

  test("an unknown audience value defaults rather than refusing", async () => {
    const query = new URLSearchParams([["audience", "not-an-audience"]]);
    const target = await targetFromQuery(query);
    expect(target).toEqual({ audience: "active", kind: "audience" });
  });

  test("an attendee token in the query claims the attendee target first", async () => {
    const query = new URLSearchParams([
      ["attendee", "ticket-token"],
      ["audience", "everyone"],
    ]);
    const target = await targetFromQuery(query);
    expect(target).toEqual({ kind: "attendee", token: "ticket-token" });
  });

  test("the same attendee claim comes from a posted form", async () => {
    const form = new FormParams();
    form.set("attendee", "ticket-token");
    const target = await targetFromForm(form);
    expect(target).toEqual({ kind: "attendee", token: "ticket-token" });
  });

  test("a blank attendee field falls through to the audience target", async () => {
    // fromRawField treats an empty string as "not this spec's params".
    const query = new URLSearchParams([["attendee", ""]]);
    const target = await targetFromQuery(query);
    expect(target?.kind).toBe("audience");
  });

  test("serialises and answers the flags through each spec", () => {
    const attendee = { kind: "attendee", token: "ticket-token" } as const;
    expect(targetQuery(attendee)).toBe("?attendee=ticket-token");
    expect(targetIsSingleRecipient(attendee)).toBe(true);
    expect(targetAllowsEmpty(attendee)).toBe(false);
    expect(targetLogListingId(attendee)).toBeNull();

    const audience = { audience: "active", kind: "audience" } as const;
    expect(targetQuery(audience)).toBe("?audience=active");
    expect(targetIsSingleRecipient(audience)).toBe(false);
    expect(targetAllowsEmpty(audience)).toBe(true);
  });
});
