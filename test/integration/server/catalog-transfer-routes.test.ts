import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import { listingGroups } from "#db/groups/table.ts";
import { getAllListings } from "#db/listings/records.ts";
import { sql } from "#db/sql.ts";
import { handleRequest } from "#routes";
import { signCsrfToken } from "#shared/csrf.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import {
  expectFlashRedirect,
  expectIncludesAll,
  expectStatus,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { expectDownloadHeaders } from "#test-utils/download.ts";
import { mockMultipartRequest } from "#test-utils/mocks.ts";
import { adminGet, getTestSession } from "#test-utils/session.ts";

/** POST a file to the import endpoint as an uploaded attachment, or with no
 *  file at all when `file` is omitted. */
const importFile = async (file?: {
  data: string;
  name: string;
}): Promise<Response> => {
  const { cookie } = await getTestSession();
  const csrfToken = await signCsrfToken();
  return handleRequest(
    mockMultipartRequest(
      "/admin/catalog/import",
      { csrf_token: csrfToken },
      cookie,
      file === undefined
        ? undefined
        : {
            contentType: "application/json",
            data: new TextEncoder().encode(file.data),
            fieldName: "catalog_file",
            name: file.name,
          },
    ),
  );
};

/** POST a JSON blob to the import endpoint as `catalog.json`. */
const importUpload = (blob: unknown): Promise<Response> =>
  importFile({ data: JSON.stringify(blob), name: "catalog.json" });

/** Assert the activity log carries a line naming `text`. */
const expectLogged = async (text: string): Promise<void> => {
  const log = await getAllActivityLog();
  expect(log.some((entry) => entry.message.includes(text))).toBe(true);
};

describeWithEnv("server (catalog transfer)", { db: true }, () => {
  describe("GET export", () => {
    testRequiresAuth("/admin/listing/1/export.json");

    test("downloads a listing as a JSON attachment", async () => {
      const listing = await createTestListing({ name: "Exportable" });
      const response = await adminGet(
        `/admin/listing/${listing.id}/export.json`,
      );
      expectStatus(200)(response);
      expectDownloadHeaders(
        response,
        "application/json",
        'attachment; filename="listing-exportable.json"',
      );
      const blob = await response.json();
      expect(blob.kind).toBe("listing");
      expect(blob.listing.name).toBe("Exportable");
    });

    test("downloads a group as a JSON attachment", async () => {
      const group = await createTestGroup({ name: "Group X" });
      const response = await adminGet(`/admin/groups/${group.id}/export.json`);
      expectStatus(200)(response);
      const blob = await response.json();
      expect(blob.kind).toBe("group");
      expect(blob.group.name).toBe("Group X");
    });

    test("falls back to the kind when a name has no slug characters", async () => {
      // A name of only punctuation slugifies to empty, so the filename uses the
      // entity kind rather than producing a dangling "listing-.json".
      const listing = await createTestListing({ name: "★☆★" });
      const response = await adminGet(
        `/admin/listing/${listing.id}/export.json`,
      );
      assertStringIncludes(
        response.headers.get("content-disposition") ?? "",
        'filename="listing-listing.json"',
      );
    });

    test("returns 404 for a missing listing", async () => {
      expectStatus(404)(await adminGet("/admin/listing/9999/export.json"));
    });

    test("returns 422 (not 500) when a row holds an unexportable value", async () => {
      // The JSON API accepts bookable_days without validating the names, so a
      // stored row can hold a value the transfer schema rejects. Exporting it
      // must surface an operator-facing error, never a raw 500.
      const listing = await createTestListing({ name: "Bad Days" });
      await execute(
        sql`UPDATE listings SET bookable_days = ${JSON.stringify([
          "Funday",
        ])} WHERE id = ${listing.id}`,
      );
      const response = await adminGet(
        `/admin/listing/${listing.id}/export.json`,
      );
      expectStatus(422)(response);
      assertStringIncludes(await response.text(), "can't be exported");
    });

    test("returns 422 when a group row holds an unexportable value", async () => {
      const group = await createTestGroup({ name: "Bad Group" });
      // A negative capacity can't be represented by the transfer schema.
      await execute(
        sql`UPDATE groups SET max_attendees = ${-1} WHERE id = ${group.id}`,
      );
      const response = await adminGet(`/admin/groups/${group.id}/export.json`);
      expectStatus(422)(response);
      assertStringIncludes(await response.text(), "can't be exported");
    });
  });

  describe("import page", () => {
    testRequiresAuth("/admin/catalog/import");

    test("renders the upload form", async () => {
      const response = await adminGet("/admin/catalog/import");
      expectStatus(200)(response);
      const html = await response.text();
      expectIncludesAll(html, ["Import a catalog file", 'name="catalog_file"']);
    });
  });

  describe("POST import", () => {
    testRequiresAuth("/admin/catalog/import", {
      body: {},
      method: "POST",
    });

    test("is disabled in demo mode", async () => {
      const { setDemoModeForTest } = await import("#shared/demo/mode.ts");
      setDemoModeForTest(true);
      try {
        const response = await importUpload({
          group: { name: "Demo Group" },
          kind: "group",
          members: [],
          version: 1,
        });
        await expectFlashRedirect(
          "/admin/catalog/import",
          "Catalog import is disabled in demo mode.",
          false,
        )(response);
        // Nothing was imported.
        expect(
          (await getAllListings()).some((l) => l.name === "Demo Group"),
        ).toBe(false);
      } finally {
        setDemoModeForTest(false);
      }
    });

    test("creates a listing from an uploaded blob and redirects", async () => {
      const group = await createTestGroup({ name: "Host Group" });
      const response = await importUpload({
        groups: [{ group: "Host Group" }],
        kind: "listing",
        listing: { maxAttendees: 25, name: "Imported One", unitPrice: 900 },
        version: 1,
      });
      await expectFlashRedirect(
        "/admin/listings",
        "Imported listing Imported One",
      )(response);

      const created = (await getAllListings()).find(
        (l) => l.name === "Imported One",
      )!;
      expect(created.unit_price).toBe(900);
      expect(await listingGroups.getIds(created.id)).toEqual([group.id]);
      // The import is recorded in the activity log.
      await expectLogged("Imported One");
    });

    test("creates a group from an uploaded blob", async () => {
      const response = await importUpload({
        group: { name: "Imported Group" },
        kind: "group",
        members: [],
        version: 1,
      });
      await expectFlashRedirect(
        "/admin/groups",
        "Imported group Imported Group",
      )(response);
      await expectLogged("Imported Group");
    });

    test("rejects an invalid JSON file", async () => {
      const response = await importFile({
        data: "{ not json",
        name: "bad.json",
      });
      await expectFlashRedirect(
        "/admin/catalog/import",
        "The file is not valid JSON.",
        false,
      )(response);
    });

    test("rejects a missing file", async () => {
      const response = await importFile();
      await expectFlashRedirect(
        "/admin/catalog/import",
        "Please select a JSON file to import.",
        false,
      )(response);
    });

    test("surfaces a validation error (duplicate name) as a flash", async () => {
      await createTestListing({ name: "Clash" });
      const response = await importUpload({
        kind: "listing",
        listing: { maxAttendees: 1, name: "Clash" },
        version: 1,
      });
      const location = response.headers.get("location") ?? "";
      expectIncludesAll(location, ["/admin/catalog/import", "flash="]);
    });

    test("imports a bundle and flashes the created counts", async () => {
      const response = await importUpload({
        groups: [{ group: { name: "Bundle Day" }, members: [] }],
        kind: "bundle",
        listings: [
          {
            groups: [{ group: "Bundle Day" }],
            listing: { maxAttendees: 10, name: "Bundle Act 1", unitPrice: 500 },
            parents: [],
          },
          {
            groups: [],
            listing: { maxAttendees: 10, name: "Bundle Act 2", unitPrice: 700 },
            parents: [],
          },
        ],
        version: 1,
      });
      await expectFlashRedirect(
        "/admin/listings",
        "2 listings and 1 group imported.",
      )(response);
      // The activity log carries one line for the whole import.
      await expectLogged("Bundle import: 2 listings and 1 groups created");
    });

    test("surfaces a bundle failure as a flash and creates nothing", async () => {
      await createTestListing({ name: "Bundle Clash" });
      const response = await importUpload({
        groups: [],
        kind: "bundle",
        listings: [
          {
            groups: [],
            listing: { maxAttendees: 5, name: "Bundle Clash" },
            parents: [],
          },
        ],
        version: 1,
      });
      await expectFlashRedirect(
        "/admin/catalog/import",
        'No records were created. Please fix these problems and upload the file again: "Bundle Clash": A listing or group named "Bundle Clash" already exists — rename or remove it before importing.',
        false,
      )(response);
      // The pre-existing row is untouched; the import created nothing.
      expect(
        (await getAllListings()).filter((l) => l.name === "Bundle Clash"),
      ).toHaveLength(1);
    });
  });
});
