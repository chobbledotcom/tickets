/**
 * What a listing's attachment does once a storage zone is configured: the
 * record an upload writes, the file it clears away, and how a rejection reads.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { processUploadsAndRedirect } from "#routes/admin/listings-uploads.ts";
import { listingsTable } from "#shared/db/listings/records.ts";
import { MAX_ATTACHMENT_SIZE } from "#shared/limits.ts";
import { ATTACHMENT_ERROR_MESSAGES } from "#shared/storage.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import { expectRedirectWithFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  debugLogged,
  errorLogged,
  useDebugLogSpy,
  useErrorLogSpy,
} from "#test-utils/debug-log.ts";
import {
  withBunnyDeleteCapture,
  withCdnRejecting,
  withStorageMock,
} from "#test-utils/mocks.ts";
import { adminFormPost } from "#test-utils/session.ts";

const RETURN_PATH = "/admin/listing/1";

/** A form carrying one attachment field, whatever the caller wants in it. */
const attachmentForm = (entry: FormDataEntryValue): FormData => {
  const form = new FormData();
  form.set("attachment", entry);
  return form;
};

const leaflet = (bytes = 3): File =>
  new File([new Uint8Array(bytes)], "leaflet.pdf", {
    type: "application/pdf",
  });

const storedAttachment = async (
  id: number,
): Promise<{ name: string; url: string }> => {
  const row = await listingsTable.read
    .pick(["attachment_name", "attachment_url"])
    .one({ id });
  return { name: row!.attachment_name, url: row!.attachment_url };
};

/** Upload `entry` against a fresh listing and hand back both what the operator
 * was told and what the listing now holds. */
const upload = async (
  entry: FormDataEntryValue,
  existingUrl?: string,
): Promise<{
  response: Response;
  stored: { name: string; url: string };
  id: number;
}> => {
  const listing = await createTestListing({ name: "Takes A Leaflet" });
  const response = await processUploadsAndRedirect(
    attachmentForm(entry),
    listing.id,
    RETURN_PATH,
    "Listing updated",
    existingUrl,
  );
  return {
    id: listing.id,
    response,
    stored: await storedAttachment(listing.id),
  };
};

describeWithEnv("uploading a listing's attachment", { db: true }, () => {
  test("keeps both the operator's file name and the stored one", async () => {
    await withStorageMock(async () => {
      const { response, stored } = await upload(leaflet());

      expectRedirectWithFlash(RETURN_PATH, "Listing updated")(response);
      expect(stored.name).toBe("leaflet.pdf");
      expect(stored.url).toMatch(/^[0-9a-f-]{36}-leaflet\.pdf$/);
    });
  });

  test("writes the upload to the activity log", async () => {
    await withStorageMock(async () => {
      await upload(leaflet());

      expect(await activityMessages()).toContain(
        "Attachment uploaded for listing",
      );
    });
  });

  test("deletes the file it replaces", async () => {
    await withBunnyDeleteCapture(async (storageCalls) => {
      await upload(leaflet(), "old-leaflet.pdf");

      expect(storageCalls.some((url) => url.endsWith("/old-leaflet.pdf"))).toBe(
        true,
      );
    });
  });

  test("leaves the listing alone when the field holds no file", async () => {
    await withStorageMock(async () => {
      const { response, stored } = await upload("leaflet.pdf");

      expectRedirectWithFlash(RETURN_PATH, "Listing updated")(response);
      expect(stored.url).toBe("");
    });
  });

  describe("with the debug log captured", () => {
    const debugSpy = useDebugLogSpy();

    test("says in the debug log that the field held no file", async () => {
      await withStorageMock(async () => {
        await upload("leaflet.pdf");

        expect(
          debugLogged(debugSpy, 'Attachment field "attachment" is string'),
        ).toBe(true);
      });
    });
  });

  test("leaves the listing alone when the file is empty", async () => {
    await withStorageMock(async () => {
      const { stored } = await upload(leaflet(0));

      expect(stored.url).toBe("");
    });
  });

  test("refuses a file over the size limit and says so", async () => {
    await withStorageMock(async () => {
      const { response, stored } = await upload(
        leaflet(MAX_ATTACHMENT_SIZE + 1),
      );

      expectRedirectWithFlash(
        RETURN_PATH,
        `Listing updated but: ${ATTACHMENT_ERROR_MESSAGES.too_large}`,
        false,
      )(response);
      expect(stored.url).toBe("");
    });
  });

  describe("with the error log captured", () => {
    const errorSpy = useErrorLogSpy();

    test("writes the failed upload to the error log", async () => {
      await withCdnRejecting(new Error("storage is down"), async () => {
        await upload(leaflet());

        expect(errorLogged(errorSpy, "Attachment upload failed")).toBe(true);
      });
    });
  });

  test("says the upload failed rather than claiming a plain success", async () => {
    await withCdnRejecting(new Error("storage is down"), async () => {
      const { response, stored } = await upload(leaflet());

      const flash = expectRedirectWithFlash(
        RETURN_PATH,
        undefined,
        false,
      )(response);
      expect(flash.headers.get("set-cookie")).toContain(
        "Attachment%20upload%20failed",
      );
      expect(stored.url).toBe("");
    });
  });

  test("keeps the caveats apart when a save carries two of them", async () => {
    await withCdnRejecting(new Error("storage is down"), async () => {
      const listing = await createTestListing({ name: "Two Caveats" });
      const response = await processUploadsAndRedirect(
        attachmentForm(leaflet()),
        listing.id,
        RETURN_PATH,
        "Listing duplicated",
        undefined,
        "its required child was left off",
      );

      const flash = expectRedirectWithFlash(
        RETURN_PATH,
        undefined,
        false,
      )(response);
      expect(decodeURIComponent(flash.headers.get("set-cookie")!)).toContain(
        "its required child was left off; Attachment upload failed",
      );
    });
  });
});

describeWithEnv("removing a listing's attachment", { db: true }, () => {
  test("clears the record and logs it once the file is gone", async () => {
    await withBunnyDeleteCapture(async (storageCalls) => {
      const listing = await createTestListing({ name: "Had A Leaflet" });
      await listingsTable.update(listing.id, {
        attachmentName: "leaflet.pdf",
        attachmentUrl: "stored-leaflet.pdf",
      });

      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/attachment/delete`,
        {},
      );

      expectRedirectWithFlash(
        `/admin/listing/${listing.id}`,
        "Attachment removed",
      )(response);
      expect(
        storageCalls.some((url) => url.endsWith("/stored-leaflet.pdf")),
      ).toBe(true);
      expect(await storedAttachment(listing.id)).toEqual({ name: "", url: "" });
      expect(await activityMessages()).toContain(
        "Attachment removed for 'Had A Leaflet'",
      );
    });
  });
});
