/**
 * The admin group routes: the pages staff open, the checks that stop a bad
 * save, and the per-listing package overrides the edit form writes.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { handleRequest } from "#routes";
import {
  deleteGroup,
  soldHiddenPackageError,
  validateGroupWithPackage,
} from "#routes/admin/groups.ts";
import type { GroupInput } from "#shared/catalog-fields/fields.ts";
import { execute, queryAll } from "#shared/db/client.ts";
import {
  getGroupPackagePrices,
  getListingsByGroupId,
  groups,
  listingGroups,
} from "#shared/db/groups.ts";
import { listingChildren } from "#shared/db/listing-parents.ts";
import { getGroupDayPrices } from "#shared/db/listing-prices.ts";
import type { Group } from "#shared/types.ts";
import {
  imageNamesForItem,
  makeImage,
  postImageUpload,
} from "#test-utils/admin-images.ts";
import { expectFlash, parseFlashCookie } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import {
  createHiddenPackageGroup,
  createTestGroup,
} from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import type { TestFormValues } from "#test-utils/form-values.ts";
import { mockFormRequest, withStorageMock } from "#test-utils/mocks.ts";
import { adminGet, getTestSession } from "#test-utils/session.ts";

/** Post a signed-in admin form and hand back the raw response, so a rejected
 * save can be read from its flash message instead of throwing. */
const adminPost = async (
  path: string,
  values: TestFormValues,
): Promise<Response> => {
  const session = await getTestSession();
  return handleRequest(
    mockFormRequest(
      path,
      { ...values, csrf_token: session.csrfToken },
      session.cookie,
    ),
  );
};

/** The group input the validators read, with only the fields a test varies. */
const groupInput = (overrides: Partial<GroupInput> = {}): GroupInput => ({
  description: "",
  hidden: false,
  isPackage: false,
  maxAttendees: 0,
  name: "Fresh name",
  slug: "fresh-name",
  slugIndex: "",
  termsAndConditions: "",
  ...overrides,
});

/** A package with one member and one sold ticket stamped with it. */
const soldPackage = async (name: string, hidden: boolean): Promise<Group> => {
  const group = hidden
    ? await createHiddenPackageGroup(name)
    : await createTestGroup({ isPackage: true, name });
  const member = await createTestListing({
    groupId: group.id,
    maxAttendees: 10,
    name: `${name} member`,
  });
  const { attendee } = await createTestAttendeeDirect(
    member.id,
    `${name} buyer`,
    `${name.toLowerCase().replaceAll(" ", "-")}@example.com`,
  );
  await execute(
    "UPDATE listing_attendees SET package_group_id = ? WHERE attendee_id = ?",
    [group.id, attendee.id],
  );
  return group;
};

describeWithEnv("admin group validation", { db: true }, () => {
  test("rejects a name another group already uses", async () => {
    const existing = await createTestGroup({ name: "Taken name" });

    expect(
      await validateGroupWithPackage(groupInput({ name: existing.name })),
    ).toBe(t("error.name_in_use"));
  });

  test("rejects a slug another group already uses", async () => {
    const existing = await createTestGroup({ name: "Slug owner" });

    expect(
      await validateGroupWithPackage(groupInput({ slug: existing.slug })),
    ).toBe(t("error.slug_in_use_group"));
  });

  test("accepts a group whose name and slug are free", async () => {
    expect(await validateGroupWithPackage(groupInput())).toBeNull();
  });

  test("accepts the group's own name and slug when editing it", async () => {
    const group = await createTestGroup({ name: "Self edit" });

    expect(
      await validateGroupWithPackage(
        groupInput({ name: group.name, slug: group.slug }),
        group.id,
      ),
    ).toBeNull();
  });

  test("rejects making a group a package when a member cannot be one", async () => {
    const group = await createTestGroup({ name: "Would be package" });
    const parent = await createTestListing({ name: "Package parent" });
    const child = await createTestListing({
      groupId: group.id,
      name: "Package child",
    });
    await listingChildren.setIds(parent.id, [child.id]);

    const error = await validateGroupWithPackage(
      groupInput({ isPackage: true, name: group.name, slug: group.slug }),
      group.id,
    );
    expect(error).toContain("Package child");
  });

  test("a visible package with no bookings can be un-packaged", async () => {
    const group = await createTestGroup({ isPackage: true, name: "Visible" });

    expect(await soldHiddenPackageError(group.id)).toBeNull();
  });

  test("a hidden package with no bookings can be un-packaged", async () => {
    const group = await createHiddenPackageGroup("Hidden unsold");

    expect(await soldHiddenPackageError(group.id)).toBeNull();
  });

  test("a plain group is never blocked by the hidden-package check", async () => {
    const group = await createTestGroup({ name: "Plain" });

    expect(await soldHiddenPackageError(group.id)).toBeNull();
  });

  test("a hidden package with sold tickets cannot be un-packaged", async () => {
    const group = await soldPackage("Hidden sold", true);

    expect(await soldHiddenPackageError(group.id)).toBe(
      t("error.sold_hidden_package"),
    );
  });

  test("a visible package with sold tickets can be un-packaged", async () => {
    const group = await soldPackage("Visible sold", false);

    expect(await soldHiddenPackageError(group.id)).toBeNull();
  });

  test("a sold hidden package may stay a package", async () => {
    const group = await soldPackage("Hidden staying", true);

    expect(
      await validateGroupWithPackage(
        groupInput({ isPackage: true, name: group.name, slug: group.slug }),
        group.id,
      ),
    ).toBeNull();
  });
});

describeWithEnv("admin group pages", { db: true }, () => {
  test("lists every group", async () => {
    const group = await createTestGroup({ name: "Listed group" });

    const response = await adminGet("/admin/groups");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(group.name);
  });

  test("offers a form for a new group", async () => {
    const response = await adminGet("/admin/groups/new");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('name="name"');
  });

  test("opens a group's own page", async () => {
    const group = await createTestGroup({ name: "Opened group" });

    const response = await adminGet(`/admin/groups/${group.id}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(group.name);
  });

  test("sends the operator to the new group's page after creating it", async () => {
    const response = await adminPost("/admin/groups", {
      description: "",
      max_attendees: "0",
      name: "Created group",
      terms_and_conditions: "",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toMatch(/^\/admin\/groups\/\d+/);
    expect(parseFlashCookie(response).success).toContain("Group");
  });

  test("sends the operator back to the group list after deleting one", async () => {
    const group = await createTestGroup({ name: "Deleted group" });

    const response = await adminPost(`/admin/groups/${group.id}/delete`, {
      confirm_identifier: group.name,
    });
    expect(response.headers.get("location")).toMatch(/^\/admin\/groups(\?|$)/);
    expect(parseFlashCookie(response).success).toContain("Group");
  });

  test("adds an uploaded image to the group", async () => {
    const group = await createTestGroup({ name: "Illustrated group" });
    const session = await getTestSession();

    await withStorageMock(async () => {
      const response = await postImageUpload(
        `/admin/groups/${group.id}/images/upload`,
        session.cookie,
        session.csrfToken,
        "Group photo",
      );
      expect(response.status).toBe(302);
    });
    expect(await imageNamesForItem("group", group.id)).toEqual(["Group photo"]);
  });

  test("links a library image to the group", async () => {
    const group = await createTestGroup({ name: "Linked group" });
    const image = await makeImage("Library shot");

    await withStorageMock(async () => {
      const response = await adminPost(`/admin/groups/${group.id}/images`, {
        image_ids: [String(image.id)],
      });
      expect(response.status).toBe(302);
    });
    expect(await imageNamesForItem("group", group.id)).toEqual([
      "Library shot",
    ]);
  });

  test("deletes a group and frees its listings", async () => {
    const group = await createTestGroup({ name: "Doomed group" });
    const listing = await createTestListing({
      groupId: group.id,
      name: "Freed listing",
    });

    await deleteGroup(group.id);
    groups.cache.invalidate();
    expect(
      await queryAll("SELECT id FROM groups WHERE id = ?", [group.id]),
    ).toEqual([]);
    expect(await listingGroups.getIds(listing.id)).toEqual([]);
  });
});

describeWithEnv("admin group listing assignment", { db: true }, () => {
  test("adds the chosen listings to the group", async () => {
    const group = await createTestGroup({ name: "Growing group" });
    const first = await createTestListing({ name: "First joiner" });
    const second = await createTestListing({ name: "Second joiner" });

    const response = await adminPost(`/admin/groups/${group.id}/add-listings`, {
      listing_ids: [String(first.id), String(second.id)],
    });
    expectFlash(response, t("success.listings_added_to_group"));
    expect(
      (await getListingsByGroupId(group.id)).map((l) => l.id).toSorted(),
    ).toEqual([first.id, second.id].toSorted());
  });

  test("refuses a listing whose type differs from the group's", async () => {
    const group = await createTestGroup({ name: "Standard group" });
    await createTestListing({ groupId: group.id, name: "Standard member" });
    const daily = await createTestListing({
      listingType: "daily",
      maximumDaysAfter: 30,
      minimumDaysBefore: 0,
      name: "Daily outsider",
    });

    const response = await adminPost(`/admin/groups/${group.id}/add-listings`, {
      listing_ids: [String(daily.id)],
    });
    expectFlash(
      response,
      t("error.group_listing_type_mismatch", { type: "standard" }),
      false,
    );
    expect(await getListingsByGroupId(group.id)).toHaveLength(1);
  });

  test("adds nothing when no listing was chosen", async () => {
    const group = await createTestGroup({ name: "Untouched group" });

    const response = await adminPost(`/admin/groups/${group.id}/add-listings`, {
      listing_ids: [],
    });
    expectFlash(response, t("success.listings_added_to_group"));
    expect(await getListingsByGroupId(group.id)).toEqual([]);
  });

  test("ignores a listing id that names nothing", async () => {
    const group = await createTestGroup({ name: "Ghost group" });

    await adminPost(`/admin/groups/${group.id}/add-listings`, {
      listing_ids: ["0", "999999"],
    });
    expect(await getListingsByGroupId(group.id)).toEqual([]);
  });
});

describeWithEnv("admin package member overrides", { db: true }, () => {
  /** Save the group as a package with the given raw member inputs. */
  const savePackage = async (
    group: { id: number; name: string; slug: string },
    memberInputs: TestFormValues,
  ): Promise<void> => {
    const response = await adminPost(`/admin/groups/${group.id}/edit`, {
      description: "",
      is_package: "1",
      max_attendees: "0",
      name: group.name,
      slug: group.slug,
      terms_and_conditions: "",
      ...memberInputs,
    });
    expect(response.status).toBe(302);
  };

  test("stores the typed price and quantity for each member", async () => {
    const group = await createTestGroup({ name: "Priced package" });
    const member = await createTestListing({
      groupId: group.id,
      name: "Priced member",
      unitPrice: 900,
    });

    await savePackage(group, {
      [`package_price_${member.id}`]: "4.50",
      [`package_qty_${member.id}`]: "3",
    });
    expect(await getGroupPackagePrices(group.id)).toEqual([
      {
        group_id: group.id,
        listing_id: member.id,
        package_price: 450,
        quantity: 3,
      },
    ]);
  });

  test("falls back to no override and one unit for unusable inputs", async () => {
    const group = await createTestGroup({ name: "Sloppy package" });
    const member = await createTestListing({
      groupId: group.id,
      name: "Sloppy member",
      unitPrice: 900,
    });

    await savePackage(group, {
      [`package_price_${member.id}`]: "12abc",
      [`package_qty_${member.id}`]: "2abc",
    });
    expect(await getGroupPackagePrices(group.id)).toEqual([
      {
        group_id: group.id,
        listing_id: member.id,
        package_price: null,
        quantity: 1,
      },
    ]);
  });

  test("keeps an explicit free price and lifts a zero quantity to one", async () => {
    const group = await createTestGroup({ name: "Free package" });
    const member = await createTestListing({
      groupId: group.id,
      name: "Free member",
      unitPrice: 900,
    });

    await savePackage(group, {
      [`package_price_${member.id}`]: "0",
      [`package_qty_${member.id}`]: "0",
    });
    expect(await getGroupPackagePrices(group.id)).toEqual([
      {
        group_id: group.id,
        listing_id: member.id,
        package_price: 0,
        quantity: 1,
      },
    ]);
  });

  test("stores a per-day override for a customisable member", async () => {
    const group = await createTestGroup({ name: "Day package" });
    const member = await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 500, 2: 900 },
      durationDays: 2,
      groupId: group.id,
      listingType: "daily",
      maximumDaysAfter: 30,
      minimumDaysBefore: 0,
      name: "Day member",
      unitPrice: 500,
    });

    await savePackage(group, {
      [`package_day_price_${member.id}_2`]: "7.00",
      [`package_price_${member.id}`]: "",
      [`package_qty_${member.id}`]: "1",
    });
    expect(await getGroupDayPrices(group.id)).toEqual(
      new Map([[member.id, new Map([[2, 700]])]]),
    );
  });

  test("drops a day-price input that is not a number", async () => {
    const group = await createTestGroup({ name: "Bad day package" });
    const member = await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 500, 2: 900 },
      durationDays: 2,
      groupId: group.id,
      listingType: "daily",
      maximumDaysAfter: 30,
      minimumDaysBefore: 0,
      name: "Bad day member",
      unitPrice: 500,
    });

    await savePackage(group, {
      [`package_day_price_${member.id}_2`]: "nonsense",
      [`package_price_${member.id}`]: "",
      [`package_qty_${member.id}`]: "1",
    });
    expect(await getGroupDayPrices(group.id)).toEqual(new Map());
  });
});
