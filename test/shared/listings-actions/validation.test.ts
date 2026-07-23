import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import type { BlindIndex } from "#shared/crypto/sealed.ts";
import { formatCurrency } from "#shared/currency.ts";
import { listingChildren } from "#shared/db/listing-parents.ts";
import { validateListingInput } from "#shared/listings-actions.ts";
import {
  inputFor,
  storedInputFor,
} from "#test/shared/listings-actions/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv("validateListingInput boundaries", { db: true }, () => {
  test("accepts a maximum price at least one currency unit above the ticket price", async () => {
    await expect(
      validateListingInput(
        inputFor({
          canPayMore: true,
          maxPrice: 1100,
          name: "Pay More OK",
          unitPrice: 1000,
        }),
      ),
    ).resolves.toBeNull();
  });

  test("states the exact minimum when a pay-more maximum is too low", async () => {
    await expect(
      validateListingInput(
        inputFor({
          canPayMore: true,
          maxPrice: 1099,
          name: "Pay More Low",
          unitPrice: 1000,
        }),
      ),
    ).resolves.toBe(
      `Maximum price must be at least ${formatCurrency(100)} more than the ticket price`,
    );
  });

  test("uses zero as the ticket price when an optional unit price is absent", async () => {
    const input = inputFor({
      canPayMore: true,
      maxPrice: 100,
      name: "No Base Price",
    });
    delete input.unitPrice;

    await expect(validateListingInput(input)).resolves.toBeNull();
  });

  test("rejects a group id that does not exist", async () => {
    await expect(
      validateListingInput(
        inputFor({ groupIds: [999_999], name: "Missing Group" }),
      ),
    ).resolves.toBe("Selected group does not exist");
  });

  test("checks every existing group member when creating a listing", async () => {
    const group = await createTestGroup({ name: "Daily Group" });
    await createTestListing({
      groupId: group.id,
      listingType: "daily",
      name: "Daily Member",
    });

    const error = await validateListingInput(
      inputFor({ groupIds: [group.id], name: "Standard Candidate" }),
    );
    expect(error).toContain("same type");
  });

  test("defaults an omitted customisable-days flag to false for group checks", async () => {
    const group = await createTestGroup({ name: "Standard Group" });
    await createTestListing({ groupId: group.id, name: "Standard Member" });
    const input = inputFor({
      groupIds: [group.id],
      name: "Default Standard Candidate",
    });
    delete input.customisableDays;

    await expect(validateListingInput(input)).resolves.toBeNull();
  });

  test("rejects an update that takes another listing's slug", async () => {
    const owner = await createTestListing({ name: "Slug Owner" });
    const editor = await createTestListing({ name: "Slug Editor" });
    const input = await storedInputFor(editor.id, {
      slug: owner.slug,
      slugIndex: "other-index" as BlindIndex,
    });

    await expect(validateListingInput(input, editor.id)).resolves.toBe(
      t("error.slug_in_use"),
    );
  });

  test("a create leaves slug collision handling to unique slug generation", async () => {
    const owner = await createTestListing({ name: "Create Slug Owner" });
    const input = inputFor({ name: "Create Slug Candidate" });

    await expect(
      validateListingInput({
        ...input,
        slug: owner.slug,
        slugIndex: "candidate-index" as BlindIndex,
      }),
    ).resolves.toBeNull();
  });
});

describeWithEnv("validateListingInput package edges", { db: true }, () => {
  test("allows a visible package member that gates its own children", async () => {
    const member = await createTestListing({ name: "Visible Member" });
    const child = await createTestListing({ name: "Visible Child" });
    await listingChildren.setIds(member.id, [child.id]);
    const group = await createTestGroup({
      isPackage: true,
      name: "Visible Package",
    });

    await expect(
      validateListingInput(
        inputFor({ groupIds: [group.id], name: member.name }),
        member.id,
      ),
    ).resolves.toBeNull();
  });

  test("rejects months per unit when No Check-In is set without Hidden", async () => {
    await expect(
      validateListingInput(
        inputFor({
          hidden: false,
          monthsPerUnit: 1,
          name: "Renewal Mixed",
          purchaseOnly: true,
        }),
      ),
    ).resolves.toBe(
      "Months per unit requires No Check-In and Hidden to be enabled",
    );
  });
});
