/** The per-listing package prices and quantities the group edit form writes. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getGroupPackagePrices } from "#db/groups.ts";
import { getGroupDayPrices } from "#db/listing-prices.ts";
import { t } from "#i18n";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import type { TestFormValues } from "#test-utils/form-values.ts";
import { adminFormPost } from "#test-utils/session.ts";
import type { GroupListing, ListingWithCount } from "#types";

describeWithEnv("admin package member overrides", { db: true }, () => {
  /** Post the group edit form as a package save. The success and the refusal
   *  path both answer with a redirect. */
  const postPackage = async (
    group: { id: number; name: string; slug: string },
    memberInputs: TestFormValues,
  ): Promise<Response> => {
    const { response } = await adminFormPost(`/admin/groups/${group.id}/edit`, {
      description: "",
      is_package: "1",
      max_attendees: "0",
      name: group.name,
      slug: group.slug,
      terms_and_conditions: "",
      ...memberInputs,
    });
    return response;
  };

  /** Save the group as a package with the given raw member inputs. */
  const savePackage = async (
    group: { id: number; name: string; slug: string },
    memberInputs: TestFormValues,
  ): Promise<void> => {
    const response = await postPackage(group, memberInputs);
    expect(response.status).toBe(302);
  };

  /** Save a one-member package with the typed price and quantity, and hand
   *  back the member row it stored. The member's cap stays high enough for
   *  every quantity below; the cap rule itself has its own tests. */
  const savedMemberRow = async (
    label: string,
    typed: { price: string; quantity: string },
  ): Promise<GroupListing> => {
    const group = await createTestGroup({ name: `${label} package` });
    const member = await createTestListing({
      groupId: group.id,
      maxQuantity: 5,
      name: `${label} member`,
      unitPrice: 900,
    });
    await savePackage(group, {
      [`package_price_${member.id}`]: typed.price,
      [`package_qty_${member.id}`]: typed.quantity,
    });
    const rows = await getGroupPackagePrices(group.id);
    const row = rows[0];
    if (!row) throw new Error(`${label} member has no membership row`);
    expect(rows).toHaveLength(1);
    expect(row.listing_id).toBe(member.id);
    return row;
  };

  /** A one-member package whose member can be priced per day. */
  const dayPricedPackage = async (
    label: string,
  ): Promise<{
    group: { id: number; name: string; slug: string };
    member: ListingWithCount;
  }> => {
    const group = await createTestGroup({ name: `${label} package` });
    const member = await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 500, 2: 900 },
      durationDays: 2,
      groupId: group.id,
      listingType: "daily",
      maximumDaysAfter: 30,
      minimumDaysBefore: 0,
      name: `${label} member`,
      unitPrice: 500,
    });
    return { group, member };
  };

  test("stores the typed price and quantity for each member", async () => {
    const row = await savedMemberRow("Priced", {
      price: "4.50",
      quantity: "3",
    });
    expect(row.package_price).toBe(450);
    expect(row.quantity).toBe(3);
  });

  test("keeps an explicit free price", async () => {
    const row = await savedMemberRow("Free", { price: "0", quantity: "1" });
    expect(row.package_price).toBe(0);
    expect(row.quantity).toBe(1);
  });

  test("treats a blank price, a blank quantity, and a blank day price as no override", async () => {
    const { group, member } = await dayPricedPackage("Blank");

    await savePackage(group, {
      [`package_day_price_${member.id}_1`]: "",
      [`package_price_${member.id}`]: "",
      [`package_qty_${member.id}`]: "",
    });

    const [row] = await getGroupPackagePrices(group.id);
    expect(row?.package_price).toBeNull();
    expect(row?.quantity).toBe(1);
    expect(await getGroupDayPrices(group.id)).toEqual(new Map());
  });

  test("stores per-day overrides for a customisable member", async () => {
    const { group, member } = await dayPricedPackage("Day");

    await savePackage(group, {
      [`package_day_price_${member.id}_1`]: "5.50",
      [`package_day_price_${member.id}_2`]: "7.00",
      [`package_price_${member.id}`]: "",
      [`package_qty_${member.id}`]: "1",
    });
    expect(await getGroupDayPrices(group.id)).toEqual(
      new Map([
        [
          member.id,
          new Map([
            [1, 550],
            [2, 700],
          ]),
        ],
      ]),
    );
  });

  test("refuses a member quantity above the member's per-order cap", async () => {
    const group = await createTestGroup({ name: "Capped package" });
    const member = await createTestListing({
      groupId: group.id,
      name: "Two cap member",
      unitPrice: 900,
    });

    const { response } = await adminFormPost(`/admin/groups/${group.id}/edit`, {
      description: "",
      is_package: "1",
      max_attendees: "0",
      name: group.name,
      slug: group.slug,
      terms_and_conditions: "",
      [`package_price_${member.id}`]: "9.00",
      [`package_qty_${member.id}`]: "2",
    });

    await expectFlashRedirect(
      `/admin/groups/${group.id}/edit`,
      t("error.package_member_cap", {
        max_quantity: 1,
        name: "Two cap member",
        quantity: 2,
      }),
      false,
    )(response);
    const [row] = await getGroupPackagePrices(group.id);
    expect(row?.quantity).toBe(1);
  });

  /** Save the group as a package with one malformed member input, and expect
   *  the save to come back with the given plain-words refusal and no price
   *  override written. */
  const refuseMemberInput = async (
    group: { id: number; name: string; slug: string },
    memberInputs: TestFormValues,
    message: string,
  ): Promise<void> => {
    const response = await postPackage(group, memberInputs);
    await expectFlashRedirect(
      `/admin/groups/${group.id}/edit`,
      message,
      false,
    )(response);
    // The refused save wrote no override: the membership keeps its defaults.
    const [row] = await getGroupPackagePrices(group.id);
    expect(row?.package_price).toBeNull();
    expect(row?.quantity).toBe(1);
  };

  /** A one-listing package group whose member can be refused. */
  const refusablePackage = async (label: string) => {
    const group = await createTestGroup({ name: `${label} package` });
    const member = await createTestListing({
      groupId: group.id,
      name: `${label} member`,
      unitPrice: 900,
    });
    return { group, member };
  };

  test("refuses a junk price with a plain-words message", async () => {
    const { group, member } = await refusablePackage("Junk price");
    await refuseMemberInput(
      group,
      { [`package_price_${member.id}`]: "12abc" },
      t("error.package_member_price"),
    );
  });

  test("refuses a junk quantity with a plain-words message", async () => {
    const { group, member } = await refusablePackage("Junk qty");
    await refuseMemberInput(
      group,
      {
        [`package_price_${member.id}`]: "9.00",
        [`package_qty_${member.id}`]: "2abc",
      },
      t("error.package_member_quantity"),
    );
  });

  test("refuses a zero quantity with the same message", async () => {
    const { group, member } = await refusablePackage("Zero qty");
    await refuseMemberInput(
      group,
      {
        [`package_price_${member.id}`]: "9.00",
        [`package_qty_${member.id}`]: "0",
      },
      t("error.package_member_quantity"),
    );
  });

  // A whole number is plain digits: 1e1 is a string the rules refuse, not a
  // number the parse converts to 10.
  test("refuses a scientific-notation quantity", async () => {
    const { group, member } = await refusablePackage("Exponent qty");
    await refuseMemberInput(
      group,
      {
        [`package_price_${member.id}`]: "9.00",
        [`package_qty_${member.id}`]: "1e1",
      },
      t("error.package_member_quantity"),
    );
    const [row] = await getGroupPackagePrices(group.id);
    expect(row?.quantity).toBe(1);
  });

  // Turning the package off must always succeed: a malformed leftover member
  // input is about to be discarded, so it cannot block the save.
  test("unpackages a group with a malformed leftover member input", async () => {
    const { group, member } = await refusablePackage("Leftover");
    await savePackage(group, {
      [`package_price_${member.id}`]: "9.00",
      [`package_qty_${member.id}`]: "1",
    });

    const { response } = await adminFormPost(`/admin/groups/${group.id}/edit`, {
      description: "",
      max_attendees: "0",
      name: group.name,
      slug: group.slug,
      terms_and_conditions: "",
      [`package_price_${member.id}`]: "12abc",
    });

    expect([200, 302]).toContain(response.status);
    const rows = await getGroupPackagePrices(group.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.package_price).toBeNull();
  });

  test("refuses a junk day price with a plain-words message", async () => {
    const { group, member } = await dayPricedPackage("Junk day price");
    await refuseMemberInput(
      group,
      {
        [`package_price_${member.id}`]: "9.00",
        [`package_day_price_${member.id}_1`]: "abc",
      },
      t("error.package_member_day_price"),
    );
    // The member keeps its own per-day prices.
    expect(await getGroupDayPrices(group.id)).toEqual(new Map());
  });

  test("refuses a zero or unsafe day count with a plain-words message", async () => {
    const { group, member } = await dayPricedPackage("Zero day count");
    await refuseMemberInput(
      group,
      {
        [`package_price_${member.id}`]: "9.00",
        [`package_day_price_${member.id}_0`]: "5.00",
        [`package_day_price_${member.id}_99999999999999999999`]: "5.00",
      },
      t("error.package_member_day_price"),
    );
    // The member keeps its own per-day prices.
    expect(await getGroupDayPrices(group.id)).toEqual(new Map());
  });
});
