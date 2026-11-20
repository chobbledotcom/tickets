/**
 * The Images field on a new physical-product listing: which form shows it,
 * and how the chosen pictures attach to the listing the create writes.
 */

import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getImagesForItem, insertImageRecord } from "#db/images.ts";
import { getAllListings } from "#db/listings/records.ts";
import { requireValue } from "#shared/required-value.ts";
import { nonEmptyString } from "#shared/validation/string.ts";
import { expectRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildCreateListingForm } from "#test-utils/db-helpers/listing-forms.ts";
import { testListingInput } from "#test-utils/factories.ts";
import { withStorageDisabled } from "#test-utils/mocks.ts";
import { adminGet, adminMultipartPost } from "#test-utils/session.ts";

const emptyListing = async (name: string) =>
  (await getAllListings()).find((listing) => listing.name === name);

const storedImage = (name: string) =>
  insertImageRecord({
    filename: nonEmptyString(`${name}.webp`, "test filename"),
    filenameThumb: nonEmptyString(`${name}-thumb.webp`, "test thumbnail"),
    name,
  });

const createWithImages = (
  name: string,
  imageIds: readonly number[],
  templateId = "physical-product",
) => ({
  ...buildCreateListingForm(testListingInput({ name })),
  imageIds: imageIds.map(String),
  templateId,
});

/** Assert the create was refused with the named message, and that no listing
 *  was written. */
const expectRefusedCreate = async (
  response: Response,
  message = "This form sent a field it does not show",
): Promise<void> => {
  expect(response.status).toBe(400);
  assertStringIncludes(await response.text(), message);
  expect((await getAllListings()).map((one) => one.name)).toEqual([]);
};

describeWithEnv(
  "a physical product create's pictures",
  { db: true, storage: "cdn" },
  () => {
    test("attaches the chosen pictures in order on both forms", async () => {
      for (const templateId of ["physical-product", "custom"] as const) {
        const first = await storedImage(`First ${templateId}`);
        const second = await storedImage(`Second ${templateId}`);
        const name = `Shipped ${templateId}`;

        const { response } = await adminMultipartPost(
          "/admin/listing",
          createWithImages(name, [second.id, first.id], templateId),
        );

        expectRedirect(response);
        const listing = requireValue(
          await emptyListing(name),
          "The created listing is missing",
        );
        const attached = await getImagesForItem("listing", listing.id);
        expect(attached.map((image) => image.id)).toEqual([
          second.id,
          first.id,
        ]);
      }
    });

    test("refuses an id the library does not hold", async () => {
      const image = await storedImage("Kept");

      const { response } = await adminMultipartPost(
        "/admin/listing",
        createWithImages("Partly Shipped", [image.id, 999_999]),
      );

      await expectRefusedCreate(
        response,
        "One of the chosen pictures is no longer available. Please choose again.",
      );
    });

    test("refuses picture ids from a form that does not show the field", async () => {
      const image = await storedImage("Refused");

      const { response } = await adminMultipartPost("/admin/listing", {
        ...buildCreateListingForm(testListingInput({ name: "Digital" })),
        imageIds: [String(image.id)],
        templateId: "online-digital",
      });

      await expectRefusedCreate(response);
    });

    test("refuses picture ids while image storage is off", async () => {
      const image = await storedImage("No Storage");

      await withStorageDisabled(async () => {
        const { response } = await adminMultipartPost(
          "/admin/listing",
          createWithImages("No Storage Listing", [image.id]),
        );
        await expectRefusedCreate(response);
      });
    });

    test("re-renders the chosen pictures when the create is refused", async () => {
      const first = await storedImage("First Preview");
      const second = await storedImage("Second Preview");

      const { response } = await adminMultipartPost("/admin/listing", {
        ...createWithImages("", [second.id, first.id]),
      });

      expect(response.status).toBe(400);
      const html = await response.text();
      const ids = [
        ...html.matchAll(/name="imageIds" type="hidden" value="(\d+)"/g),
      ].map((match) => match[1]);
      expect(ids).toEqual([String(second.id), String(first.id)]);
      expect(html.match(/class="listing-images-item"/g)?.length).toBe(2);
      assertStringIncludes(html, 'data-image-name="First Preview"');
      assertStringIncludes(
        html,
        'data-image-thumb="/image/First Preview-thumb.webp"',
      );
    });

    test("re-renders an empty picture selection when none was chosen", async () => {
      const { response } = await adminMultipartPost(
        "/admin/listing",
        createWithImages("", []),
      );

      expect(response.status).toBe(400);
      const html = await response.text();
      assert(html.includes("data-listing-images"));
      assert(!html.includes('name="imageIds"'));
    });
  },
);

describeWithEnv(
  "the Images field on the new listing page",
  { db: true, storage: "cdn" },
  () => {
    const pageAt = async (path: string): Promise<string> => {
      const response = await adminGet(path);
      expect(response.status).toBe(200);
      return await response.text();
    };

    test("shows for the physical product and custom templates", async () => {
      for (const template of ["physical-product", "custom"]) {
        const html = await pageAt(`/admin/listing/new?template=${template}`);
        assertStringIncludes(html, "data-listing-images");
      }

      const digital = await pageAt(
        "/admin/listing/new?template=online-digital",
      );
      assert(!digital.includes("data-listing-images"));
    });

    test("is absent while image storage is off", async () => {
      await withStorageDisabled(async () => {
        for (const template of ["physical-product", "custom"]) {
          const html = await pageAt(`/admin/listing/new?template=${template}`);
          assert(!html.includes("data-listing-images"));
        }
      });
    });
  },
);
