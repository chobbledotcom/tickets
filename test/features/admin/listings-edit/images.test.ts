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
import { listingWithImages } from "#test-utils/admin-images.ts";
import {
  expectRedirect,
  expectRedirectWithFlash,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildCreateListingForm } from "#test-utils/db-helpers/listing-forms.ts";
import { testListingInput } from "#test-utils/factories.ts";
import { withStorageDisabled } from "#test-utils/mocks.ts";
import {
  adminFormPost,
  adminGet,
  adminMultipartPost,
} from "#test-utils/session.ts";

const emptyListing = async (name: string) =>
  (await getAllListings()).find((listing) => listing.name === name);

const storedImage = (name: string) =>
  insertImageRecord({
    filename: nonEmptyString(`${name}.webp`, "test filename"),
    filenameThumb: nonEmptyString(`${name}-thumb.webp`, "test thumbnail"),
    name,
  });

/** A listing with two linked pictures, in the order given. */
const listingWithTwoPictures = async (
  listingName: string,
  firstPicture: string,
  secondPicture: string,
) => {
  const { images, listing } = await listingWithImages(listingName, [
    firstPicture,
    secondPicture,
  ]);
  return {
    first: requireValue(images[0], "the first picture"),
    listing,
    second: requireValue(images[1], "the second picture"),
  };
};

const createWithImages = (
  name: string,
  imageIds: readonly number[],
  templateId = "physical-product",
) => ({
  ...buildCreateListingForm(testListingInput({ name })),
  imageIds: imageIds.map(String),
  templateId,
});

/** Assert the create was refused for a field its form did not show, and that
 *  no listing was written. */
const expectRefusedCreate = async (response: Response): Promise<void> => {
  expect(response.status).toBe(400);
  assertStringIncludes(
    await response.text(),
    "This form sent a field it does not show",
  );
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

    test("leaves out an id the library does not hold", async () => {
      const image = await storedImage("Kept");

      const { response } = await adminMultipartPost(
        "/admin/listing",
        createWithImages("Partly Shipped", [image.id, 999_999]),
      );

      expectRedirect(response);
      const listing = await emptyListing("Partly Shipped");
      const attached = await getImagesForItem("listing", listing!.id);
      expect(attached.map((picture) => picture.id)).toEqual([image.id]);
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
      const image = await storedImage("Preview");

      const { response } = await adminMultipartPost("/admin/listing", {
        ...createWithImages("", [image.id, 999_999]),
      });

      expect(response.status).toBe(400);
      const html = await response.text();
      assertStringIncludes(html, `value="${image.id}"`);
      assertStringIncludes(html, 'data-image-name="Preview"');
      assertStringIncludes(html, "data-image-thumb");
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
  "the Images tab on a saved listing",
  { db: true, storage: "cdn" },
  () => {
    test("renders the saved pictures in the shared picker field", async () => {
      const {
        listing,
        first: second,
        second: first,
      } = await listingWithTwoPictures("Pictured", "Second", "First");

      const html = await (
        await adminGet(`/admin/listing/${listing.id}/images`)
      ).text();

      assertStringIncludes(html, "data-listing-images");
      assertStringIncludes(html, "Add images");
      assertStringIncludes(html, "Save Changes");
      assertStringIncludes(
        html,
        `action="/admin/listing/${listing.id}/images"`,
      );
      assertStringIncludes(html, `data-image-thumb="/image/second-thumb.webp"`);
      const secondPosition = html.indexOf(`value="${second.id}"`);
      const firstPosition = html.indexOf(`value="${first.id}"`);
      expect(secondPosition).toBeGreaterThan(-1);
      expect(firstPosition).toBeGreaterThan(secondPosition);
      assert(!html.includes('name="imageIds" type="checkbox"'));
      assert(!html.includes(`/admin/listing/${listing.id}/images/upload`));
    });

    test("writes the order the picker posts", async () => {
      const { listing, first, second } = await listingWithTwoPictures(
        "Reordered",
        "Order first",
        "Order second",
      );

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/images`,
        { imageIds: [String(second.id), String(first.id)] },
      );

      expectRedirectWithFlash(
        `/admin/listing/${listing.id}/images`,
        "Images updated",
      )(response);
      expect(
        (await getImagesForItem("listing", listing.id)).map(
          (image) => image.id,
        ),
      ).toEqual([second.id, first.id]);
    });

    test("clears every link when the picker sends no pictures", async () => {
      const { listing } = await listingWithImages("Cleared", ["Remove me"]);

      await adminFormPost(`/admin/listing/${listing.id}/images`, {});

      expect(await getImagesForItem("listing", listing.id)).toEqual([]);
    });
  },
);

describeWithEnv(
  "the Images field on the new listing page",
  { db: true, storage: "cdn" },
  () => {
    const pageAt = async (path: string): Promise<string> =>
      await (await adminGet(path)).text();

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
