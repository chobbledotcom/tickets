import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { signCsrfToken } from "#shared/csrf.ts";
import { getGroupIdsByListingId } from "#shared/db/groups.ts";
import { getAllListings } from "#shared/db/listings.ts";
import {
  adminGet,
  createTestGroup,
  createTestListing,
  describeWithEnv,
  expectFlashRedirect,
  getAllActivityLog,
  getTestSession,
  mockMultipartRequest,
  testRequiresAuth,
} from "#test-utils";

/** POST a JSON blob to the import endpoint as an uploaded file. */
const importUpload = async (blob: unknown): Promise<Response> => {
  const { cookie } = await getTestSession();
  const csrfToken = await signCsrfToken();
  return handleRequest(
    mockMultipartRequest(
      "/admin/catalog/import",
      { csrf_token: csrfToken },
      cookie,
      {
        contentType: "application/json",
        data: new TextEncoder().encode(JSON.stringify(blob)),
        fieldName: "catalog_file",
        name: "catalog.json",
      },
    ),
  );
};

describeWithEnv("server (catalog transfer)", { db: true }, () => {
  describe("GET export", () => {
    testRequiresAuth("/admin/listing/1/export.json");

    test("downloads a listing as a JSON attachment", async () => {
      const listing = await createTestListing({ name: "Exportable" });
      const response = await adminGet(
        `/admin/listing/${listing.id}/export.json`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      expect(response.headers.get("content-disposition")).toContain(
        'attachment; filename="listing-exportable.json"',
      );
      const blob = await response.json();
      expect(blob.kind).toBe("listing");
      expect(blob.listing.name).toBe("Exportable");
    });

    test("downloads a group as a JSON attachment", async () => {
      const group = await createTestGroup({ name: "Group X" });
      const response = await adminGet(`/admin/groups/${group.id}/export.json`);
      expect(response.status).toBe(200);
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
      expect(response.headers.get("content-disposition")).toContain(
        'filename="listing-listing.json"',
      );
    });

    test("returns 404 for a missing listing", async () => {
      const response = await adminGet("/admin/listing/9999/export.json");
      expect(response.status).toBe(404);
    });
  });

  describe("import page", () => {
    testRequiresAuth("/admin/catalog/import");

    test("renders the upload form", async () => {
      const response = await adminGet("/admin/catalog/import");
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Import a listing or group");
      expect(html).toContain('name="catalog_file"');
    });
  });

  describe("POST import", () => {
    testRequiresAuth("/admin/catalog/import", {
      body: {},
      method: "POST",
    });

    test("is disabled in demo mode", async () => {
      const { setDemoModeForTest } = await import("#shared/demo.ts");
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
      expect(await getGroupIdsByListingId(created.id)).toEqual([group.id]);
      // The import is recorded in the activity log.
      const log = await getAllActivityLog();
      expect(log.some((e) => e.message.includes("Imported One"))).toBe(true);
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
      const log = await getAllActivityLog();
      expect(log.some((e) => e.message.includes("Imported Group"))).toBe(true);
    });

    test("rejects an invalid JSON file", async () => {
      const { cookie } = await getTestSession();
      const csrfToken = await signCsrfToken();
      const response = await handleRequest(
        mockMultipartRequest(
          "/admin/catalog/import",
          { csrf_token: csrfToken },
          cookie,
          {
            contentType: "application/json",
            data: new TextEncoder().encode("{ not json"),
            fieldName: "catalog_file",
            name: "bad.json",
          },
        ),
      );
      await expectFlashRedirect(
        "/admin/catalog/import",
        "The file is not valid JSON.",
        false,
      )(response);
    });

    test("rejects a missing file", async () => {
      const { cookie } = await getTestSession();
      const csrfToken = await signCsrfToken();
      const response = await handleRequest(
        mockMultipartRequest(
          "/admin/catalog/import",
          { csrf_token: csrfToken },
          cookie,
        ),
      );
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
      expect(location).toContain("/admin/catalog/import");
      expect(location).toContain("flash=");
    });
  });
});
