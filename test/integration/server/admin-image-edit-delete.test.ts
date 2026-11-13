import { assertArrayIncludes, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  getImageById,
  getImageUsesForImage,
  setImagesForItem,
} from "#db/images.ts";
import { handleRequest } from "#routes";
import { imageRecord } from "#shared/records/images.ts";
import type { DeleteVerdict, WriteVerdict } from "#shared/rest/record.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import {
  adminGet,
  expectImageName,
  formRequest,
  imageNamesForItem,
  imageOnListingAndGroup,
  makeImage,
} from "#test-utils/admin-images.ts";
import {
  expectFlashRedirect,
  expectHtmlResponse,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import {
  mockFormRequest,
  withCdnRejecting,
  withStorageDisabled,
  withStorageMock,
} from "#test-utils/mocks.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";
import type { Image } from "#types";

describeWithEnv(
  "admin image edit and delete routes",
  { db: true, storage: "cdn" },
  () => {
    /** POST one image's edit form as the owner: the route's answer and the
     *  session cookie it used. The fields default to the image's own values. */
    const postImageEdit = async (
      image: { alt_text: string; id: number; name: string },
      fields: [string, string][] = [
        ["name", image.name],
        ["alt_text", image.alt_text],
      ],
    ): Promise<{ cookie: string; response: Response }> => {
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();
      const response = await handleRequest(
        formRequest(
          `/admin/images/${image.id}/edit`,
          [["csrf_token", csrfToken], ...fields],
          cookie,
        ),
      );
      return { cookie, response };
    };

    /** The delete confirmation one image's page POST sends, and its cookie. */
    const deleteRequest = async (
      image: { id: number; name: string },
      confirmIdentifier: string = image.name,
    ): Promise<{ cookie: string; request: Request }> => {
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();
      return {
        cookie,
        request: mockFormRequest(
          `/admin/images/${image.id}/delete`,
          { confirm_identifier: confirmIdentifier, csrf_token: csrfToken },
          cookie,
        ),
      };
    };

    /** Run one image delete POST with storage mocked, answering its cookie and
     *  the route's answer. */
    const answerImageDelete = async (
      image: Image,
    ): Promise<{ cookie: string; response: Response }> => {
      const { cookie, request } = await deleteRequest(image);
      let response: Response | undefined;
      await withStorageMock(async () => {
        response = await handleRequest(request);
      });
      return { cookie, response: response! };
    };

    /** Assert one page write's answer: its status, or its refusal flash. */
    const expectWriteAnswer = async (
      path: string,
      cookie: string,
      response: Response,
      expected: { status: number } | { flash: string },
    ): Promise<void> => {
      if ("status" in expected) {
        expect(response.status).toBe(expected.status);
        return;
      }
      await expectFlashRedirect(path, expected.flash, false, cookie)(response);
    };

    /** Assert one image page write's answer when the record's command answers
     *  `verdict`: its 404, or its refusal flash. */
    const expectImageWriteAnswer = async (
      imageName: string,
      write: "remove" | "update",
      verdict: DeleteVerdict | WriteVerdict<Image>,
      expected: { status: number } | { flash: string },
    ): Promise<void> => {
      const image = await makeImage(imageName);
      using _write = stub(imageRecord, write, () =>
        Promise.resolve(verdict as never),
      );
      const path = `/admin/images/${image.id}/${write === "update" ? "edit" : "delete"}`;
      const answer =
        write === "update"
          ? await postImageEdit(image)
          : await answerImageDelete(image);
      await expectWriteAnswer(path, answer.cookie, answer.response, expected);
      await expectImageName(image.id, imageName);
    };

    test("answers the record's vanished or refused image writes", async () => {
      const cases = [
        {
          expected: { status: 404 },
          name: "Vanished",
          verdict: { kind: "not-found" as const },
        },
        {
          expected: { flash: "The image refused the change" },
          name: "Refused",
          verdict: {
            kind: "refused" as const,
            message: "The image refused the change",
          },
        },
      ];

      for (const { expected, name, verdict } of cases) {
        for (const write of ["update", "remove"] as const) {
          await expectImageWriteAnswer(name, write, verdict, expected);
        }
      }
    });

    describe("GET /admin/images/:id/edit", () => {
      test("renders selected listing and group links", async () => {
        const { group, image, listing } = await imageOnListingAndGroup(
          "Shared",
          "Image listing",
          "Image group",
        );

        await expectHtmlResponse(
          await adminGet(`/admin/images/${image.id}/edit`),
          200,
          "Edit Shared",
          "<strong>Linked items (2):</strong>",
          '<li class="checkboxes"><strong>Listings:</strong>',
          '<li class="checkboxes"><strong>Groups:</strong>',
          `checked name="image_items" type="checkbox" value="listing:${listing.id}"`,
          // Groups have no deactivated state, so a group is never muted.
          `<label><input checked name="image_items" type="checkbox" value="group:${group.id}"`,
        );
      });

      test("lists a deactivated listing muted at the end of its row", async () => {
        const image = await makeImage("Fading");
        const retired = await createTestListing({ name: "Retired listing" });
        const live = await createTestListing({ name: "Live listing" });
        await deactivateTestListing(retired.id);

        const response = await adminGet(`/admin/images/${image.id}/edit`);
        expect(response.status).toBe(200);
        const html = await response.text();
        assertStringIncludes(html, "<strong>Linked listings (0):</strong>");
        const liveIndex = html.indexOf(`value="listing:${live.id}"`);
        const retiredIndex = html.indexOf(
          `<label class="muted"><input name="image_items" type="checkbox" value="listing:${retired.id}"`,
        );
        expect(liveIndex).toBeGreaterThan(-1);
        expect(retiredIndex).toBeGreaterThan(liveIndex);
      });

      test("redirects away from edit when storage is disabled", async () => {
        const image = await makeImage("Disabled edit");

        await withStorageDisabled(async () => {
          const response = await adminGet(`/admin/images/${image.id}/edit`);
          await expectFlashRedirect(
            "/admin/images",
            "File storage is not configured.",
            false,
          )(response);
        });
      });
    });

    describe("POST /admin/images/:id/edit", () => {
      test("rejects empty image names", async () => {
        const image = await makeImage("Named");
        const { cookie, response } = await postImageEdit(image, [
          ["name", ""],
          ["alt_text", "Still invalid"],
        ]);

        await expectFlashRedirect(
          `/admin/images/${image.id}/edit`,
          "Image name is required",
          false,
          cookie,
        )(response);
        await expectImageName(image.id, "Named");
      });

      test("updates image metadata and linked items", async () => {
        const image = await makeImage("Original");
        const listing = await createTestListing({ name: "Editable listing" });
        const group = await createTestGroup({ name: "Editable group" });
        const { cookie, response } = await postImageEdit(image, [
          ["name", "Updated"],
          ["alt_text", "Updated alt"],
          ["image_items", `listing:${listing.id}`],
          ["image_items", `group:${group.id}`],
          ["image_items", "not-an-item"],
          ["image_items", "bogus:12"],
          ["image_items", "listing:0"],
        ]);

        await expectFlashRedirect(
          `/admin/images/${image.id}/edit`,
          "Image updated",
          true,
          cookie,
        )(response);
        expect(await getImageById(image.id)).toMatchObject({
          alt_text: "Updated alt",
          name: "Updated",
        });
        expect(await imageNamesForItem("listing", listing.id)).toEqual([
          "Updated",
        ]);
        expect(await imageNamesForItem("group", group.id)).toEqual(["Updated"]);
        // The malformed entries (unknown type, bad id) must not create links.
        const uses = await getImageUsesForImage(image.id);
        expect(uses.length).toBe(2);
        const messages = (await getAllActivityLog()).map(
          (entry) => entry.message,
        );
        assertArrayIncludes(messages, ["Image 'Updated' updated"]);
      });

      test("keeps an existing item image order during metadata-only saves", async () => {
        const listing = await createTestListing({
          name: "Stable edit listing",
        });
        const image = await makeImage("Original first");
        const trailing = await makeImage("Original trailing");
        await setImagesForItem("listing", listing.id, [image.id, trailing.id]);
        const { cookie, response } = await postImageEdit(image, [
          ["name", "Renamed first"],
          ["alt_text", "Updated alt"],
          ["image_items", `listing:${listing.id}`],
        ]);

        await expectFlashRedirect(
          `/admin/images/${image.id}/edit`,
          "Image updated",
          true,
          cookie,
        )(response);
        expect(await imageNamesForItem("listing", listing.id)).toEqual([
          "Renamed first",
          "Original trailing",
        ]);
      });

      test("rejects direct metadata saves when storage is disabled", async () => {
        const image = await makeImage("Storage-off edit");

        await withStorageDisabled(async () => {
          const { cookie, response } = await postImageEdit(image, [
            ["name", "Should not save"],
            ["alt_text", "Should not save"],
          ]);
          await expectFlashRedirect(
            "/admin/images",
            "File storage is not configured.",
            false,
            cookie,
          )(response);
        });
        await expectImageName(image.id, "Storage-off edit");
      });
    });

    describe("POST /admin/images/:id/delete", () => {
      test("redirects away from delete confirmation when storage is disabled", async () => {
        const image = await makeImage("Disabled delete");

        await withStorageDisabled(async () => {
          const response = await adminGet(`/admin/images/${image.id}/delete`);
          await expectFlashRedirect(
            "/admin/images",
            "File storage is not configured.",
            false,
          )(response);
        });
      });

      test("rejects direct deletes when storage is disabled", async () => {
        const image = await makeImage("Storage-off delete");
        const { cookie, request } = await deleteRequest(image);

        await withStorageDisabled(async () => {
          const response = await handleRequest(request);
          await expectFlashRedirect(
            "/admin/images",
            "File storage is not configured.",
            false,
            cookie,
          )(response);
        });
        await expectImageName(image.id, "Storage-off delete");
      });

      test("requires the image name, then deletes storage files and image rows", async () => {
        const image = await makeImage("Discard");
        const mismatchRequest = await deleteRequest(image, "wrong");

        const mismatch = await handleRequest(mismatchRequest.request);
        await expectFlashRedirect(
          `/admin/images/${image.id}/delete`,
          "Confirmation did not match the image name",
          false,
          mismatchRequest.cookie,
        )(mismatch);
        await expectImageName(image.id, "Discard");

        const { request } = await deleteRequest(image);
        await withStorageMock(async (fetchCalls) => {
          const deleted = await handleRequest(request);
          await expectFlashRedirect(
            "/admin/images",
            "Image deleted",
            true,
          )(deleted);
          expect(fetchCalls.some((url) => url.includes("discard.webp"))).toBe(
            true,
          );
          expect(
            fetchCalls.some((url) => url.includes("discard-thumb.webp")),
          ).toBe(true);
        });
        expect(await getImageById(image.id)).toBeNull();
        const messages = (await getAllActivityLog()).map(
          (entry) => entry.message,
        );
        assertArrayIncludes(messages, ["Image 'Discard' deleted"]);
      });

      test("keeps the image row when storage cleanup fails", async () => {
        const image = await makeImage("Storage failure");
        const { cookie, request } = await deleteRequest(image);

        await withCdnRejecting(new Error("delete down"), async () => {
          const response = await handleRequest(request);
          await expectFlashRedirect(
            `/admin/images/${image.id}/delete`,
            "Could not delete the image files from storage. The image was kept so you can try again.",
            false,
            cookie,
          )(response);
        });
        // The record survives so the admin can retry rather than orphaning the
        // stored files under a deleted library entry.
        await expectImageName(image.id, "Storage failure");
      });
    });
  },
);
