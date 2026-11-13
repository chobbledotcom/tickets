/**
 * Admin JSON API routes for the image library. The audience and the write
 * path come from the image record. This module translates the wire body: a
 * base64 create and an item-link update. It also preserves the manager
 * refusals that depend on the actor.
 *
 * The create carries the picture itself as base64 text, because the admin API
 * has one body mode. The record's upload boundary stores the files and writes
 * the row.
 */

import {
  getImageUsesForImageOnPrimary,
  getImageUsesForImages,
  type ImageUseTarget,
  imageUseTargets,
} from "#db/images.ts";
import { t } from "#i18n";
import { verifyIdentifierOrJsonError } from "#routes/admin/confirmation.ts";
import { apiErrorResponse } from "#routes/api/cors.ts";
import type { AuthPolicy } from "#routes/auth.ts";
import { jsonResponse } from "#routes/response.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import { UpdateImageBodySchema } from "#shared/admin-api-images.ts";
import {
  ADMIN_API_RESOURCES,
  adminApiIdParam,
} from "#shared/admin-api-resources.ts";
import { getImageProxyUrl } from "#shared/image-proxy-url.ts";
import {
  isSiteContentImageType,
  siteContentBlocksManager,
} from "#shared/images/library.ts";
import {
  type ImageMetadata,
  type ImageWriteInput,
  imageMetadata,
  imageRecord,
  uploadImageFiles,
} from "#shared/records/images.ts";
import type {
  HydratedRows,
  WriteBody,
  WriteMapper,
} from "#shared/rest/crud-api-types.ts";
import { parseApiBody, withApiEntity } from "#shared/rest/crud-parsers.ts";
import {
  recordApi,
  recordJsonDeletePolicy,
  recordJsonPolicy,
} from "#shared/rest/record-api.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import { isStorageEnabled } from "#shared/storage.ts";
import { deleteImageStorageFilesStrict } from "#shared/storage-cleanup.ts";
import {
  type AdminLevel,
  type AdminSession,
  type Image,
  type ImageUse,
  type ImageUseItemType,
  isSiteRole,
} from "#types";

const ENTRY = ADMIN_API_RESOURCES.images;
const ID_PARAM = adminApiIdParam(ENTRY.label);

type ImageEntry = typeof ADMIN_API_RESOURCES.images;

/** One image as every image endpoint answers with it. */
const toImageRow = (
  image: Image,
  uses: readonly ImageUse[],
): Record<string, unknown> => ({
  alt_text: image.alt_text,
  id: image.id,
  items: uses.map(({ item_id: itemId, item_type: itemType }) => ({
    item_id: itemId,
    item_type: itemType,
  })),
  name: image.name,
  thumb_url: getImageProxyUrl(image.filename_thumb),
  url: getImageProxyUrl(image.filename),
});

/** The row's hydrated fields: the links and the two proxy URLs. */
const imageExtras = (
  image: Image,
  uses: readonly ImageUse[],
): Record<string, unknown> => ({
  items: uses.map(({ item_id: itemId, item_type: itemType }) => ({
    item_id: itemId,
    item_type: itemType,
  })),
  thumb_url: getImageProxyUrl(image.filename_thumb),
  url: getImageProxyUrl(image.filename),
});

const hydrateImages = async (rows: Image[]): Promise<HydratedRows> => {
  const usesById = await getImageUsesForImages(rows.map(({ id }) => id));
  return new Map(
    rows.map((row) => [row.id, imageExtras(row, usesById.get(row.id) ?? [])]),
  );
};

const hydrateImageAfterWrite = async (rows: Image[]): Promise<HydratedRows> => {
  const [row] = rows;
  return row === undefined
    ? new Map()
    : new Map([
        [row.id, imageExtras(row, await getImageUsesForImageOnPrimary(row.id))],
      ]);
};

// ─── Body mapping ──────────────────────────────────────────────

/** The bytes a base64 body names. A value that is not base64 text is a bad
 *  request, so the decoder's throw becomes a refusal here. */
const base64Bytes = (text: string): Result<Uint8Array> => {
  try {
    return okResult(Uint8Array.fromBase64(text));
  } catch {
    return errorResult("file must be base64 text");
  }
};

/** The upload and the record one create body names. The files go up at the
 *  door because the wire carries bytes, not a form. The record then inserts
 *  the row and logs it. */
const toCreateInput: WriteMapper<
  ImageWriteInput,
  WriteBody<ImageEntry["createBodySchema"]>,
  null
> = async (body) => {
  const metadata = imageMetadata(body.name, body.alt_text ?? "");
  if (!metadata.ok) return errorResult(metadata.error);
  const bytes = base64Bytes(body.file);
  if (!bytes.ok) return bytes;
  const filenames = await uploadImageFiles({
    bytes: bytes.value,
    contentType: body.content_type,
  });
  if (!filenames.ok) return filenames;
  return okResult({ ...metadata.value, ...filenames.value });
};

/** One update's metadata and links. An absent field keeps the stored value,
 *  and an absent `items` leaves the stored links alone (null). */
const toUpdateInput: WriteMapper<
  ImageWriteInput,
  WriteBody<ImageEntry["updateBodySchema"]>,
  Image
> = (body, existing) => {
  const metadata = imageMetadata(
    body.name ?? existing.name,
    body.alt_text ?? existing.alt_text,
  );
  if (!metadata.ok) return errorResult(metadata.error);
  return okResult({
    ...metadata.value,
    filename: existing.filename,
    filenameThumb: existing.filename_thumb,
    items:
      body.items === undefined
        ? null
        : body.items.map(({ item_id: itemId, item_type: itemType }) =>
            imageUseTargets.of(itemType)(itemId),
          ),
  });
};

// ─── Manager refusals ──────────────────────────────────────────

/** A manager cannot change or remove an image that a news post or a page
 *  shows. Its name, its alt text, and its presence all render there. */
const siteContentRefusal = async (
  adminLevel: AdminLevel,
  imageId: number,
): Promise<Response | null> =>
  (await siteContentBlocksManager(adminLevel, imageId))
    ? apiErrorResponse(t("images.news_gated"), 403)
    : null;

/** A manager never links an image to a news post or a page, because those
 *  surfaces belong to the Site roles. */
const submittedLinkRefusal = (
  items: readonly { item_type: ImageUseItemType }[] | undefined,
  adminLevel: AdminLevel,
): Response | null =>
  items !== undefined &&
  !isSiteRole(adminLevel) &&
  items.some(({ item_type: itemType }) => isSiteContentImageType(itemType))
    ? apiErrorResponse(t("images.news_target_gated"), 403)
    : null;

// ─── Handlers ──────────────────────────────────────────────────

/** The update page's audience, and the roles its JSON route admits. */
const updatePolicy = recordJsonPolicy(imageRecord);

/** The delete page's destination gives the delete route its audience. */
const deletePolicy = recordJsonDeletePolicy(imageRecord);

/** The shared gate for one image write: load the row, then refuse a Site
 *  content image to a role that cannot edit the Site surfaces. */
const withImageWrite =
  (
    handler: (
      image: Image,
      session: AdminSession,
      body: Record<string, unknown>,
    ) => Promise<Response>,
    policy: AuthPolicy<"json">,
  ): RouteHandlerFn =>
  (request, params) =>
    withApiEntity(
      request,
      (id, session) => imageRecord.load(id, { session }),
      params[ID_PARAM] as number,
      ENTRY.label,
      async (image, session, body) => {
        const blocked = await siteContentRefusal(session.adminLevel, image.id);
        return blocked ?? handler(image, session, body);
      },
      policy,
    );

/** The answer a refused or vanished image write gives. */
const imageFailure = (verdict: {
  kind: "refused" | "not-found";
  message?: string;
}): Response =>
  verdict.kind === "refused"
    ? apiErrorResponse(verdict.message ?? "")
    : apiErrorResponse(`${ENTRY.label} not found`, 404);

const handleUpdate: RouteHandlerFn = withImageWrite(
  async (existing, session, body) => {
    const parsed = parseApiBody(UpdateImageBodySchema, body);
    if (!parsed.ok) return apiErrorResponse(parsed.error);
    const input = await toUpdateInput(parsed.value, existing);
    if (!input.ok) return apiErrorResponse(input.error);
    const linkRefusal = submittedLinkRefusal(
      parsed.value.items,
      session.adminLevel,
    );
    if (linkRefusal !== null) return linkRefusal;
    const verdict = await imageRecord.update(existing.id, input.value);
    if (verdict.kind !== "written") return imageFailure(verdict);
    return jsonResponse({
      image: toImageRow(
        verdict.row,
        await getImageUsesForImageOnPrimary(verdict.row.id),
      ),
    });
  },
  updatePolicy,
);

const handleDelete: RouteHandlerFn = withImageWrite(
  async (image, _session, body) => {
    const mismatch = verifyIdentifierOrJsonError(
      image.name,
      body.confirm_identifier,
      `${ENTRY.label} name`,
    );
    if (mismatch) return apiErrorResponse(mismatch);
    if (!isStorageEnabled()) {
      return apiErrorResponse(t("images.storage_off"));
    }
    // The files go first. A failed storage delete keeps the record, so the
    // caller can retry instead of leaving files no library entry names.
    try {
      await deleteImageStorageFilesStrict(image);
    } catch {
      return apiErrorResponse(t("images.delete.storage_failed"), 500);
    }
    const verdict = await imageRecord.remove(image.id);
    return verdict.kind === "deleted"
      ? jsonResponse({ status: "ok" })
      : imageFailure(verdict);
  },
  deletePolicy,
);

/** What the update transaction module answers the page's direct callers:
 *  the row it wrote, or the response that refuses it. */
type ImageUpdate = {
  items: ImageUseTarget[] | null;
  metadata: ImageMetadata;
};

type UpdateOutcome = { refusal: Response } | { row: Image };

export const writeImageUpdate = async (
  image: Image,
  input: ImageUpdate,
): Promise<UpdateOutcome> => {
  const verdict = await imageRecord.update(image.id, {
    ...input.metadata,
    filename: image.filename,
    filenameThumb: image.filename_thumb,
    items: input.items,
  });
  if (verdict.kind === "refused") {
    return { refusal: apiErrorResponse(verdict.message) };
  }
  if (verdict.kind === "not-found") {
    return { refusal: apiErrorResponse(`${ENTRY.label} not found`, 404) };
  }
  return { row: verdict.row };
};

export const imageApiRoutes: Record<string, RouteHandlerFn> = recordApi<
  typeof ADMIN_API_RESOURCES.images,
  Image,
  ImageWriteInput
>(imageRecord, {
  hydrate: hydrateImages,
  hydrateAfterWrite: hydrateImageAfterWrite,
  overrides: { delete: handleDelete, update: handleUpdate },
  stripKeys: ["filename", "filename_thumb"],
  toCreateInput,
  toUpdateInput,
});
