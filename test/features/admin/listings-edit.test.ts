/**
 * Creating, duplicating and editing a listing: where each one leaves the
 * operator, and what a rejected save keeps. The form parsing itself lives in
 * listings-form.ts with its own suite.
 */

import { assert, assertArrayIncludes, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getImagesForItem } from "#db/images.ts";
import { listingChildren } from "#db/listing-parents.ts";
import { getAllListings, getListingWithCount } from "#db/listings/records.ts";
import { readOneRow } from "#db/read.ts";
import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import { t } from "#i18n";
import { adminLandingPath } from "#shared/admin-pages.ts";
import {
  expectIncludesAll,
  expectRedirect,
  parseFlashCookie,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import {
  createHiddenPackageGroup,
  createTestGroup,
} from "#test-utils/db-helpers/groups.ts";
import {
  buildCreateListingForm,
  buildUpdateListingForm,
} from "#test-utils/db-helpers/listing-forms.ts";
import {
  bookableStartDates,
  createTestListing,
  dailySwitchForm,
} from "#test-utils/db-helpers/listings.ts";
import { baseListingForm, testListingInput } from "#test-utils/factories.ts";
import { groupRescuedChildAddOn } from "#test-utils/listing-parents/helpers.ts";
import { mockMultipartRequest } from "#test-utils/mocks.ts";
import {
  adminFormPost,
  adminGet,
  adminMultipartPost,
  createTestEditorSession,
  editorGetStatus,
  testCsrfToken,
} from "#test-utils/session.ts";
import {
  featureSetting,
  setupStripe,
  withSetting,
} from "#test-utils/settings.ts";
import type { AdminLevel } from "#types";
import {
  carriedTemplate,
  pageAt,
  rejectedCreate,
  storedImage,
} from "./listings-edit/fixtures.ts";

const listingForm = (name: string, adminLevel: AdminLevel = "owner") =>
  buildCreateListingForm(
    testListingInput({ listingType: "standard", name }),
    adminLevel,
  );

describeWithEnv("creating a listing", { db: true }, () => {
  test("sends staff to their own landing page", async () => {
    // Staff land on the dashboard, which renders the flash the create sets.
    const { response } = await adminMultipartPost(
      "/admin/listing",
      listingForm("Made By Staff"),
    );

    // The flash marker rides on the query string; the page is the assertion.
    expect(expectRedirect(response).split("?")[0]).toBe(
      adminLandingPath("owner"),
    );
    assertArrayIncludes(
      (await getAllListings()).map((one) => one.name),
      ["Made By Staff"],
    );
  });

  test("sends an editor to the new listing's own page", async () => {
    // An editor cannot open the dashboard, so a successful create must not
    // land them on it.
    const { cookie } = await createTestEditorSession();
    const { handleRequest } = await import("#routes");

    const response = await handleRequest(
      mockMultipartRequest(
        "/admin/listing",
        {
          ...listingForm("Made By Editor", "editor"),
          csrfToken: await testCsrfToken(),
        },
        cookie,
      ),
    );

    const location = expectRedirect(response);
    expect(location).toMatch(/^\/admin\/listing\/\d+/);
  });
});

describeWithEnv("editing a listing", { db: true }, () => {
  test("saves the change and returns to the listing's own page", async () => {
    const listing = await createTestListing({ name: "Before" });

    const { response } = await adminMultipartPost(
      `/admin/listing/${listing.id}/edit`,
      buildUpdateListingForm({ name: "After" }, listing),
    );

    assertStringIncludes(
      expectRedirect(response),
      `/admin/listing/${listing.id}`,
    );
    expect(
      await readOneRow(
        from(tables.listings).where({ id: listing.id }).pick("name"),
      ),
    ).toEqual({ name: "After" });
  });

  test("keeps what was typed when the save is rejected", async () => {
    const listing = await createTestListing({ name: "Keep Me" });

    const { response } = await adminMultipartPost(
      `/admin/listing/${listing.id}/edit`,
      { ...buildUpdateListingForm({}, listing), name: "" },
    );

    expect(response.status).toBe(400);
  });

  test("answers 404 editing a listing that is not there", async () => {
    const listing = await createTestListing({ name: "Elsewhere" });

    const { response } = await adminMultipartPost(
      "/admin/listing/99999/edit",
      buildUpdateListingForm({}, listing),
    );

    expect(response.status).toBe(404);
  });
});

describeWithEnv("duplicating a listing", { db: true }, () => {
  test("opens a confirmation naming the listing to copy", async () => {
    const listing = await createTestListing({ name: "Copy Me" });

    const response = await adminGet(`/admin/listing/${listing.id}/duplicate`);

    expect(response.status).toBe(200);
    assertStringIncludes(await response.text(), "Copy Me");
  });

  test("answers 404 duplicating a listing that is not there", async () => {
    expect((await adminGet("/admin/listing/99999/duplicate")).status).toBe(404);
  });
});

describeWithEnv("the new listing form", { db: true }, () => {
  test("opens for an editor, who may create listings", async () => {
    expect(await editorGetStatus("/admin/listing/new")).toBe(200);
  });
});

const PICKER_HEADING = "Choose a listing type";
const FORM_HEADING = "<h1>Add Listing</h1>";

describeWithEnv("which new listing page opens", { db: true }, () => {
  test("offers the type picker until a template is named", async () => {
    const picker = await pageAt("/admin/listing/new");
    const custom = await pageAt("/admin/listing/new?template=custom");

    assertStringIncludes(picker, PICKER_HEADING);
    assert(!picker.includes(FORM_HEADING));
    assertStringIncludes(custom, FORM_HEADING);
    assert(!custom.includes(PICKER_HEADING));
    expect(carriedTemplate(custom)).toBe("custom");
  });
});

describeWithEnv("a rejected create's template", { db: true }, () => {
  const dated = { date: "2026-09-01T10:00", listingType: "standard" } as const;
  const standard = { listingType: "standard" } as const;

  for (const [label, shape, extra, expected] of [
    [
      "is the one submitted",
      dated,
      { templateId: "weekly-event" },
      "weekly-event",
    ],
    ["is worked out from a dated shape", dated, {}, "one-off-event"],
    [
      "is worked out from a daily shape",
      { listingType: "daily" },
      {},
      "weekly-event",
    ],
    [
      "is worked out from a no-check-in shape",
      { ...standard, purchaseOnly: true },
      {},
      "online-digital",
    ],
    ["is none for a plain standard shape", standard, {}, null],
  ] as const) {
    test(label, async () => {
      const html = await rejectedCreate(shape, extra);

      expect(carriedTemplate(html)).toBe(expected);
    });
  }

  test("is the hireable item when the shape uses logistics", () =>
    withSetting(featureSetting("logistics"), async () => {
      const html = await rejectedCreate({
        ...standard,
        purchaseOnly: true,
        usesLogistics: true,
      });

      expect(carriedTemplate(html)).toBe("hireable-item");
    }));

  test("is the subscription when the shape has a recurring price", async () => {
    await setupStripe();
    await withSetting(featureSetting("subscriptions"), async () => {
      const html = await rejectedCreate(standard, {
        recurringInterval: "month",
        recurringPrice: "5.00",
      });

      expect(carriedTemplate(html)).toBe("subscription");
    });
  });

  test("keeps the Customise box and the chosen groups", async () => {
    const group = await createTestGroup({ name: "Picked" });

    const html = await rejectedCreate(standard, {
      customise: "1",
      groupIds: String(group.id),
      templateId: "weekly-event",
    });

    expectIncludesAll(html, [
      '<input checked id="customise-listing" name="customise"',
      `checked name="groupIds" type="checkbox" value="${group.id}"`,
    ]);
  });
});

/** Checks that the create failed with the message and wrote no listing. */
const expectRefused = async (response: Response, message: string) => {
  expect(response.status).toBe(400);
  assertStringIncludes(await response.text(), message);
  expect(await getAllListings()).toEqual([]);
};

describeWithEnv("a one-off event create", { db: true }, () => {
  const createOneOff = (name: string, date: string) =>
    adminMultipartPost("/admin/listing", {
      ...buildCreateListingForm(
        testListingInput({ date, listingType: "standard", name }),
      ),
      templateId: "one-off-event",
    });

  test("refuses a blank date and says why", async () => {
    const { response } = await createOneOff("Undated", "");

    await expectRefused(response, "A date is required for one-off events");
  });

  test("accepts the same form once the date is filled in", async () => {
    const { response } = await createOneOff("Dated", "2026-09-01T10:00");

    expectRedirect(response);
    expect((await getAllListings()).map((one) => one.name)).toEqual(["Dated"]);
  });
});

describeWithEnv("a create's pictures", { db: true, storage: "cdn" }, () => {
  const createWith = (name: string, ids: number[], templateId: string) =>
    adminMultipartPost("/admin/listing", {
      ...buildCreateListingForm(testListingInput({ name })),
      imageIds: ids.map(String),
      templateId,
    });

  /** Stores one image for each name, then posts a create that lists the
   * images last first. The ids come back in the order that the form sent. */
  const createWithStored = async (
    name: string,
    templateId: string,
    imageNames: string[],
  ) => {
    const ids: number[] = [];
    for (const imageName of imageNames) {
      ids.unshift((await storedImage(imageName)).id);
    }
    const { response } = await createWith(name, ids, templateId);
    return { ids, response };
  };

  test("attaches the chosen pictures in order", async () => {
    const { ids, response } = await createWithStored(
      "Shipped",
      "physical-product",
      ["First", "Second"],
    );

    expectRedirect(response);
    const [listing] = await getAllListings();
    const attached = await getImagesForItem("listing", listing!.id);
    expect(attached.map((image) => image.id)).toEqual(ids);
  });

  test("refuses a single id that the library does not hold", async () => {
    const { response } = await createWith("Lost", [999_999], "custom");

    await expectRefused(
      response,
      "One of the chosen pictures is no longer available. Please choose again.",
    );
  });

  test("refuses a single picture id from a form without the field", async () => {
    const { response } = await createWithStored("Digital", "online-digital", [
      "Unshown",
    ]);

    await expectRefused(
      response,
      "This form sent a field it does not show. Reload the page and try again.",
    );
  });

  test("re-renders the chosen pictures in order when the create fails", async () => {
    const { ids, response } = await createWithStored("", "custom", [
      "First Preview",
      "Second Preview",
    ]);

    expect(response.status).toBe(400);
    const sent = [
      ...(await response.text()).matchAll(
        /name="imageIds" type="hidden" value="(\d+)"/g,
      ),
    ].map((match) => match[1]);
    expect(sent).toEqual(ids.map(String));
  });
});

describeWithEnv("duplicating required children", { db: true }, () => {
  const parentGating = async (name: string, childNames: string[]) => {
    const parent = await createTestListing({ maxAttendees: 10, name });
    const children = [];
    for (const childName of childNames) {
      children.push(await createTestListing({ name: childName }));
    }
    await listingChildren.setIds(
      parent.id,
      children.map((child) => child.id),
    );
    return { children, parent };
  };

  const copyOf = async (sourceId: number, name: string, groupId?: number) => {
    const { response } = await adminMultipartPost("/admin/listing", {
      ...baseListingForm,
      duplicatedFrom: String(sourceId),
      ...(groupId === undefined ? {} : { groupIds: String(groupId) }),
      name,
    });
    const copy = (await getAllListings()).find((one) => one.name === name)!;
    const flash = parseFlashCookie(response);
    return {
      childIds: await listingChildren.getIds(copy.id),
      message: flash.success ?? flash.error,
    };
  };

  /** The notice for a copy whose gate was left behind. */
  const dropped = (reason: string) =>
    `Listing created but: ${t("listings_table.duplicate_children_dropped", { reason })}`;

  test("gives the copy the one child and says nothing extra", async () => {
    const { children, parent } = await parentGating("Gate", ["Gate child"]);

    const { childIds, message } = await copyOf(parent.id, "Gate copy");

    expect(childIds).toEqual([children[0]!.id]);
    expect(message).toBe("Listing created");
  });

  test("drops the gate into a hidden package and names the reason", async () => {
    const { parent } = await parentGating("Packaged", ["Packaged child"]);
    const hidden = await createHiddenPackageGroup("Hidden");

    const { childIds, message } = await copyOf(
      parent.id,
      "Packaged copy",
      hidden.id,
    );

    expect(childIds).toEqual([]);
    expect(message).toBe(
      dropped(
        "a package member cannot require children while its package hides listing names",
      ),
    );
  });

  test("names the reason when the copied gate fails its checks", async () => {
    const { children, parent } = await parentGating("Nested", ["Middle"]);
    const leaf = await createTestListing({ name: "Leaf" });
    await listingChildren.setIds(children[0]!.id, [leaf.id]);

    const { childIds, message } = await copyOf(parent.id, "Nested copy");

    expect(childIds).toEqual([]);
    expect(message).toBe(
      dropped(
        t("listings_table.children_err_child_is_parent", { name: "Middle" }),
      ),
    );
  });
});

const postIncome = (id: number, income: string) =>
  adminFormPost(`/admin/listing/${id}/income`, { income });

describeWithEnv("saving an edit that cannot complete", { db: true }, () => {
  test("serves the assign page at 400 when a confirmed switch is refused", async () => {
    const { rescuer } = await groupRescuedChildAddOn();
    await bookAttendee(rescuer, { quantity: 1 });
    const [day] = await bookableStartDates(rescuer.id);

    // Clearing the rescuing page's last group is refused in the write.
    const { response } = await adminMultipartPost(
      `/admin/listing/${rescuer.id}/edit`,
      {
        ...dailySwitchForm(rescuer, {
          assignUndatedTo: day!,
          durationDays: "2",
        }),
        groupIds: "",
      },
    );

    expect(response.status).toBe(400);
    assertStringIncludes(
      await response.text(),
      t("modifiers.err_child_only_addon", { name: "Group extra" }),
    );
  });

  test("reads the corrected income from the income box", async () => {
    const listing = await createTestListing({ name: "Wrong Income" });

    const { response } = await postIncome(listing.id, "25.00");

    expectRedirect(response);
    expect((await getListingWithCount(listing.id))!.income).toBe(2500);
  });
});
