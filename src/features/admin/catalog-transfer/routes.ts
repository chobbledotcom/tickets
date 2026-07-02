/**
 * Admin routes for catalog import/export.
 *
 * Export: download one listing or group as a JSON blob (see schema.ts).
 * Import: upload such a blob to create a new listing or group. All routes are
 * content-gated (owner/manager/editor — the same roles that create listings and
 * groups).
 */

import { t } from "#i18n";
import { CONTENT_MULTIPART, requireContentOr, withAuth } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import {
  encodeBody,
  errorRedirect,
  htmlResponse,
  notFoundResponse,
  redirect,
} from "#routes/response.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { adminCatalogImportPage } from "#templates/admin/catalog-transfer.tsx";
import { exportGroup, exportListing } from "./export.ts";
import { importCatalog } from "./import.ts";

const IMPORT_PATH = "/admin/catalog/import";

/** Build a JSON file download response. */
const jsonDownload = (data: unknown, filename: string): Response =>
  new Response(encodeBody(JSON.stringify(data, null, 2)), {
    headers: {
      "content-disposition": `attachment; filename="${filename}"`,
      "content-type": "application/json; charset=utf-8",
    },
  });

/** A safe, human-readable download filename from an entity name. */
const catalogFilename = (kind: string, name: string): string => {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${kind}-${slug || kind}.json`;
};

/** Content-gated export download: load the blob by id (404 when absent) and
 * stream it as a named JSON attachment. Shared by both entity kinds. */
const downloadExport = <T>(
  request: Request,
  id: number,
  load: (id: number) => Promise<T | null>,
  kind: string,
  nameOf: (blob: T) => string,
): Promise<Response> =>
  requireContentOr(request, async () => {
    const blob = await load(id);
    return blob
      ? jsonDownload(blob, catalogFilename(kind, nameOf(blob)))
      : notFoundResponse();
  });

/** GET /admin/listing/:id/export.json — download a listing's export blob. */
const handleListingExport: TypedRouteHandler<
  "GET /admin/listing/:id/export.json"
> = (request, { id }) =>
  downloadExport(request, id, exportListing, "listing", (b) => b.listing.name);

/** GET /admin/groups/:id/export.json — download a group's export blob. */
const handleGroupExport: TypedRouteHandler<
  "GET /admin/groups/:id/export.json"
> = (request, { id }) =>
  downloadExport(request, id, exportGroup, "group", (b) => b.group.name);

/** GET /admin/catalog/import — the import upload form. */
const handleImportGet: TypedRouteHandler<"GET /admin/catalog/import"> = (
  request,
) =>
  requireContentOr(request, (session) => {
    const flash = applyFlash(request);
    return htmlResponse(
      adminCatalogImportPage(session, flash.error, flash.success),
    );
  });

/** POST /admin/catalog/import — validate and apply an uploaded blob. */
const handleImportPost: TypedRouteHandler<"POST /admin/catalog/import"> = (
  request,
) =>
  withAuth(request, CONTENT_MULTIPART, async (session, formData) => {
    const file = formData.get("catalog_file");
    if (!(file instanceof File) || file.size === 0) {
      return errorRedirect(IMPORT_PATH, t("catalog_transfer.no_file"));
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      return errorRedirect(IMPORT_PATH, t("catalog_transfer.invalid_json"));
    }

    const result = await importCatalog(parsed, session.adminLevel);
    if (!result.ok) return errorRedirect(IMPORT_PATH, result.error);

    if (result.kind === "listing") {
      await logActivity(`Listing '${result.name}' imported`, result.id);
      return redirect(
        "/admin/listings",
        t("catalog_transfer.imported_listing", { name: result.name }),
        true,
      );
    }
    await logActivity(`Group '${result.name}' imported`);
    return redirect(
      "/admin/groups",
      t("catalog_transfer.imported_group", { name: result.name }),
      true,
    );
  });

/** Catalog import/export routes. */
export const catalogTransferRoutes = defineRoutes({
  "GET /admin/catalog/import": handleImportGet,
  "GET /admin/groups/:id/export.json": handleGroupExport,
  "GET /admin/listing/:id/export.json": handleListingExport,
  "POST /admin/catalog/import": handleImportPost,
});
