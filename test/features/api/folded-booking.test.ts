import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  applyChildSelectionsToForm,
  parseApiChildSelections,
} from "#routes/api/folded-booking.ts";
import {
  type ApiChildSelection,
  PackageChildrenSchema,
} from "#routes/api/request-schemas.ts";
import type { TicketCtx } from "#routes/public/types.ts";
import type { TicketListing } from "#shared/booking/model.ts";
import { FormParams } from "#shared/form-data.ts";
import { resolved } from "#test/test-utils/booking-model-fixtures.ts";

/** Direct, pure tests of the folded-booking API's child-selection layer —
 * `parseApiChildSelections` (parse the `children` body) and
 * `applyChildSelectionsToForm` (translate resolved selections onto the fold's
 * `child_qty_*` / `child_price_*` form fields, rejecting stranger slugs and
 * conflicting per-child prices). These reach the functions directly with a
 * hand-built ctx, so no database is needed and the suite runs fast. The DB
 * parent-flow tests live in `folded-booking/parent-booking.test.ts`. */

const PARENT_ID = 1;

/** A child {@link TicketListing} fixture carrying the given id and slug, built
 * from the shared `resolved()` factory so the shape stays the one the fold
 * tests already use. `applyChildSelectionsToForm` reads only
 * `ctx.childrenByParentId`, so a ctx carrying just that map is an honest
 * fixture for it. */
const childFixture = (id: number, slug: string): TicketListing =>
  resolved({ id, slug });

/** Build the minimal ctx `applyChildSelectionsToForm` reads: one parent's
 * resolved children. The rest of {@link TicketCtx} is unused by that function,
 * so the cast keeps the fixture to exactly the field under test. */
const ctxWithChildren = (children: TicketListing[]): TicketCtx =>
  ({
    childrenByParentId: new Map([[PARENT_ID, children]]),
  }) as unknown as TicketCtx;

/** Read a `Response | null` from {@link applyChildSelectionsToForm} as a 400
 * JSON error body, asserting it is a Response first so a `null` (success)
 * surfaces as a type failure rather than a silent pass. */
const errorBody = async (
  result: Response | null,
): Promise<{ error: string }> => {
  expect(result).toBeInstanceOf(Response);
  return (await (result as Response).json()) as { error: string };
};

/** Run {@link applyChildSelectionsToForm} against one child (id 10,
 *  slug "child-a") under the parent, returning the form alongside the result
 *  so a test asserts both the written fields and the success/error outcome. */
const applySelections = (
  selections: ApiChildSelection[],
): { form: FormParams; result: Response | null } => {
  const form = new FormParams();
  const result = applyChildSelectionsToForm(
    form,
    ctxWithChildren([childFixture(10, "child-a")]),
    PARENT_ID,
    selections,
  );
  return { form, result };
};

describe("parseApiChildSelections", () => {
  test("returns the parsed children for a valid body", () => {
    const selections = parseApiChildSelections({
      children: [{ quantity: 2, slug: "gig" }],
    });
    expect(selections).toEqual([{ quantity: 2, slug: "gig" }]);
  });

  test("round-trips a customPrice and an optional parent", () => {
    const selections = parseApiChildSelections({
      children: [{ customPrice: 12.5, parent: "pkg", quantity: 1, slug: "g" }],
    });
    expect(selections).toEqual([
      { customPrice: 12.5, parent: "pkg", quantity: 1, slug: "g" },
    ]);
  });

  test("defaults an absent children field to an empty array", () => {
    expect(parseApiChildSelections({})).toEqual([]);
    expect(parseApiChildSelections({ children: undefined })).toEqual([]);
    expect(parseApiChildSelections({ children: null })).toEqual([]);
  });

  test("returns null when children is malformed", () => {
    expect(parseApiChildSelections({ children: "nope" })).toBe(null);
    expect(
      parseApiChildSelections({ children: [{ quantity: 0, slug: "g" }] }),
    ).toBe(null);
    expect(parseApiChildSelections({ children: [{ quantity: 1 }] })).toBe(null);
  });

  test("validates against the package schema, which requires a parent on each entry", () => {
    expect(
      parseApiChildSelections(
        { children: [{ parent: "pkg", quantity: 1, slug: "g" }] },
        PackageChildrenSchema,
      ),
    ).toEqual([{ parent: "pkg", quantity: 1, slug: "g" }]);
    expect(
      parseApiChildSelections(
        { children: [{ quantity: 1, slug: "g" }] },
        PackageChildrenSchema,
      ),
    ).toBe(null);
  });
});

describe("applyChildSelectionsToForm", () => {
  test("writes a per-child quantity field and returns null", () => {
    const { form, result } = applySelections([
      { quantity: 2, slug: "child-a" },
    ]);
    expect(result).toBe(null);
    expect(form.get("child_qty_1_10")).toBe("2");
  });

  test("sums repeated slug entries into one child quantity", () => {
    const { form, result } = applySelections([
      { quantity: 1, slug: "child-a" },
      { quantity: 2, slug: "child-a" },
    ]);
    expect(result).toBe(null);
    expect(form.get("child_qty_1_10")).toBe("3");
  });

  test("writes a per-child price field when a customPrice is given", () => {
    const { form, result } = applySelections([
      { customPrice: 30, quantity: 1, slug: "child-a" },
    ]);
    expect(result).toBe(null);
    expect(form.get("child_price_1_10")).toBe("30");
  });

  test("omits the price field when no customPrice is given", () => {
    const { form, result } = applySelections([
      { quantity: 1, slug: "child-a" },
    ]);
    expect(result).toBe(null);
    expect(form.has("child_price_1_10")).toBe(false);
  });

  test("rejects a slug that is not a child of this parent with a 400", async () => {
    const { result } = applySelections([{ quantity: 1, slug: "stranger" }]);
    expect((result as Response).status).toBe(400);
    expect((await errorBody(result)).error).toMatch(/is not a child/i);
  });

  test("rejects duplicate entries for one child with conflicting prices", async () => {
    const { result } = applySelections([
      { customPrice: 30, quantity: 1, slug: "child-a" },
      { customPrice: 20, quantity: 1, slug: "child-a" },
    ]);
    expect((result as Response).status).toBe(400);
    expect((await errorBody(result)).error).toMatch(/conflicting prices/i);
  });

  test("accepts repeated entries that agree on the price", () => {
    const { form, result } = applySelections([
      { customPrice: 30, quantity: 1, slug: "child-a" },
      { customPrice: 30, quantity: 1, slug: "child-a" },
    ]);
    expect(result).toBe(null);
    expect(form.get("child_qty_1_10")).toBe("2");
    expect(form.get("child_price_1_10")).toBe("30");
  });
});
