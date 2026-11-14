import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { listingGroups } from "#db/groups/table.ts";
import type { ModifierInput } from "#db/modifiers.ts";
import { modifierRecord } from "#shared/records/modifiers.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  insertModifier,
  linkModifierGroup,
  linkModifierListing,
} from "#test-utils/modifiers.ts";
import { makeParent } from "#test-utils/parents.ts";
import { deleteConfirmLabel } from "#test-utils/record-labels.ts";

const modifierInput = (
  overrides: Partial<ModifierInput> = {},
): ModifierInput => ({
  active: true,
  calcKind: "fixed",
  calcValue: 5,
  direction: "charge",
  minVisits: 0,
  name: "Extra",
  scope: "listings",
  trigger: "automatic",
  ...overrides,
});

const NEEDS_CODE = "A promo-code modifier needs a code";
const NO_VISITS = "Optional add-ons cannot require previous bookings";
const childOnly = (name: string) =>
  `'${name}' is an opt-in add-on reachable only through a required child listing, so no booking page would offer it — scope it to the parent (or another bookable listing), or remove it as a child, before saving.`;

/** The rule's answer for a new modifier: null when it passes. */
const createError = async (overrides: Partial<ModifierInput>) => {
  const ruled = await modifierRecord.rule(modifierInput(overrides), null);
  return ruled.ok ? null : ruled.error;
};

/** A stored modifier linked to the one child listing of a new parent. */
const modifierOnChild = async (scope: "groups" | "listings") => {
  const { child } = await makeParent();
  const modifier = await insertModifier({ name: "Extra" });
  if (scope === "listings") {
    await linkModifierListing(modifier.id, child.id);
    return modifier;
  }
  const group = await createTestGroup({ name: "Child group" });
  await listingGroups.setIds(child.id, [group.id]);
  await linkModifierGroup(modifier.id, group.id);
  return modifier;
};

/** The update answer for a stored modifier: the refusal, or "written". */
const updateAnswer = async (id: number, overrides: Partial<ModifierInput>) => {
  const verdict = await modifierRecord.update(id, modifierInput(overrides));
  return verdict.kind === "refused" ? verdict.message : verdict.kind;
};

describe("the modifier record's declaration", () => {
  test("names a modifier on its pages and its delete page", () => {
    expect(modifierRecord.activityName).toBe("Modifier");
    expect(deleteConfirmLabel(modifierRecord)).toBe("Modifier name");
  });
});

describeWithEnv("the modifier rule", { db: true }, () => {
  test("asks a promo-code modifier for its code", async () => {
    expect([
      await createError({ trigger: "code" }),
      await createError({ code: "SAVE", trigger: "code" }),
    ]).toEqual([NEEDS_CODE, null]);
  });

  test("refuses an opt-in add-on that needs previous bookings", async () => {
    expect([
      await createError({ minVisits: 1, trigger: "optional" }),
      await createError({ minVisits: 0, trigger: "optional" }),
      await createError({ code: "SAVE", minVisits: 1, trigger: "code" }),
    ]).toEqual([NO_VISITS, null, null]);
  });

  test("lets a new opt-in add-on through, since it has no links yet", async () => {
    expect(await createError({ trigger: "optional" })).toBe(null);
  });

  test("refuses an opt-in add-on its stored listing links reach only through a child", async () => {
    const modifier = await modifierOnChild("listings");

    expect(await updateAnswer(modifier.id, { trigger: "optional" })).toBe(
      childOnly("Extra"),
    );
  });

  test("refuses an opt-in add-on its stored group links reach only through a child", async () => {
    const modifier = await modifierOnChild("groups");

    expect(
      await updateAnswer(modifier.id, { scope: "groups", trigger: "optional" }),
    ).toBe(childOnly("Extra"));
  });

  test("skips the reach check for an inactive or automatic modifier", async () => {
    const modifier = await modifierOnChild("listings");

    expect([
      await updateAnswer(modifier.id, { active: false, trigger: "optional" }),
      await updateAnswer(modifier.id, { trigger: "automatic" }),
    ]).toEqual(["written", "written"]);
  });
});

describeWithEnv("the modifier record's commands", { db: true }, () => {
  test("creates a modifier and logs it with the modifier name", async () => {
    expect(
      await modifierRecord.create(modifierInput({ name: "Booking fee" })),
    ).toMatchObject({ kind: "written", row: { name: "Booking fee" } });
    expect(await activityMessages()).toEqual([
      "Modifier 'Booking fee' created",
    ]);
  });
});
