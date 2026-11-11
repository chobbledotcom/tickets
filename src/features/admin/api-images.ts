/**
 * Admin JSON API routes for the image library. The dashboard's image pages
 * admit every content admin (owner, manager, editor), so the JSON API matches
 * (CONTENT_API).
 *
 * The create carries the picture itself as base64 text, because the admin API
 * has one body mode. The upload runs the form's own validation, transcode, and
 * record write through the shared helpers.
 */

import { type TxScope, withTransaction } from "#db/client.ts";
import {
  deleteImageRecord,
  getAllImages,
  getImageById,
  getImageUsesForImage,
  getImageUsesForImageOnPrimary,
  getImageUsesForImages,
  type ImageUseTarget,
  imageUseTargets,
  missingImageUseTargets,
  setItemsForImage,
  updateImageRecord,
} from "#db/images.ts";
import { refuseTheWriteOn } from "#db/transaction.ts";
import { t } from "#i18n";
import { verifyIdentifierOrJsonError } from "#routes/admin/confirmation.ts";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { CONTENT_API, withAuth } from "#routes/auth.ts";
import { jsonResponse } from "#routes/response.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import {
  CreateImageBodySchema,
  UpdateImageBodySchema,
} from "#shared/admin-api-images.ts";
import {
  ADMIN_API_RESOURCES,
  adminApiIdParam,
} from "#shared/admin-api-resources.ts";
import { getImageProxyUrl } from "#shared/image-proxy-url.ts";
import { logImageAction } from "#shared/images/activity.ts";
import {
  byNameThenUpload,
  isSiteContentImageType,
  siteContentBlocksManager,
} from "#shared/images/library.ts";
import { sortByName } from "#shared/name-order.ts";
import {
  apiEntityGate,
  type EntityHandler,
  parseApiBody,
  withApiEntity,
} from "#shared/rest/crud-parsers.ts";
import { transactionValidationMessageOrRethrow } from "#shared/rest/write-error.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import { isStorageEnabled } from "#shared/storage.ts";
import { deleteImageStorageFilesStrict } from "#shared/storage-cleanup.ts";
import {
  type AdminLevel,
  type Image,
  type ImageUse,
  type ImageUseItemType,
  isSiteRole,
} from "#types";
import {
  type ImageFile,
  type ImageMetadata,
  imageMetadata,
  storeImage,
} from "./image-upload.ts";

const ENTRY = ADMIN_API_RESOURCES.images;
const RESPONSE_KEY = "image";
const ROOT = `/api/admin/${ENTRY.path}`;
const BY_ID = `${ROOT}/:${adminApiIdParam(ENTRY.label)}`;

/** One link as an update body spells it, after the schema proves its shape. */
type SubmittedLink = {
  item_id: number;
  item_type: ImageUseItemType;
};

/** One image as every image endpoint answers with it. */
const toImageRow = (
  image: Image,
  uses: readonly ImageUse[],
): Record<string, unknown> => ({
  alt_text: image.alt_text,
  id: image.id,
  items: uses.map((use) => ({
    item_id: use.item_id,
    item_type: use.item_type,
  })),
  name: image.name,
  thumb_url: getImageProxyUrl(image.filename_thumb),
  url: getImageProxyUrl(image.filename),
});

// ─── Body parsing ───────────────────────────────────────────────

/** The bytes a base64 body names. A value that is not base64 text is a bad
 *  request, so the decoder's throw becomes a refusal here. */
const base64Bytes = (text: string): Result<Uint8Array> => {
  try {
    return okResult(Uint8Array.fromBase64(text));
  } catch {
    return errorResult("file must be base64 text");
  }
};

/** The metadata and file one create body names. */
const createImageInput = (
  body: Record<string, unknown>,
): Result<{ file: ImageFile; metadata: ImageMetadata }> => {
  const parsed = parseApiBody(CreateImageBodySchema, body);
  if (!parsed.ok) return parsed;
  const metadata = imageMetadata(
    parsed.value.name,
    parsed.value.alt_text ?? "",
  );
  if (!metadata.ok) return metadata;
  const bytes = base64Bytes(parsed.value.file);
  if (!bytes.ok) return bytes;
  return okResult({
    file: { bytes: bytes.value, contentType: parsed.value.content_type },
    metadata: metadata.value,
  });
};

/** The links one update body names. A manager never links an image to a news
 *  post or a page, because those surfaces belong to the Site roles. That
 *  refusal answers a forbidden one. */
const submittedLinks = (
  items: readonly SubmittedLink[],
  adminLevel: AdminLevel,
): { links: ImageUseTarget[] } | { refusal: Response } => {
  const links: ImageUseTarget[] = [];
  for (const { item_id: itemId, item_type: itemType } of items) {
    if (!isSiteRole(adminLevel) && isSiteContentImageType(itemType)) {
      return {
        refusal: apiErrorResponse(t("images.news_target_gated"), 403),
      };
    }
    links.push(imageUseTargets.of(itemType)(itemId));
  }
  return { links };
};

/** The fields one update body writes: its metadata and the links that replace
 *  the stored ones (null leaves them alone). */
type ImageUpdate = {
  items: ImageUseTarget[] | null;
  metadata: ImageMetadata;
};

/** What one update's body parsing answers: the fields to write, or the
 *  response that refuses the body. */
type UpdateParse = { refusal: Response } | { update: ImageUpdate };

/** One update's metadata and links. An absent field keeps the stored value,
 *  and an absent `items` leaves the stored links alone. */
const updateImageInput = (
  image: Image,
  body: Record<string, unknown>,
  adminLevel: AdminLevel,
): UpdateParse => {
  const parsed = parseApiBody(UpdateImageBodySchema, body);
  if (!parsed.ok) return { refusal: apiErrorResponse(parsed.error) };
  const { alt_text: altText, items, name } = parsed.value;
  const metadata = imageMetadata(name ?? image.name, altText ?? image.alt_text);
  if (!metadata.ok) return { refusal: apiErrorResponse(metadata.error) };
  if (items === undefined) {
    return { update: { items: null, metadata: metadata.value } };
  }
  const links = submittedLinks(items, adminLevel);
  return "refusal" in links
    ? links
    : { update: { items: links.links, metadata: metadata.value } };
};

// ─── Handlers ──────────────────────────────────────────────────

/** A manager cannot change or remove an image that a news post or a page
 *  shows. Its name, its alt text, and its presence all render there. */
const siteContentRefusal = async (
  adminLevel: AdminLevel,
  imageId: number,
): Promise<Response | null> =>
  (await siteContentBlocksManager(adminLevel, imageId))
    ? apiErrorResponse(t("images.news_gated"), 403)
    : null;

const handleList: RouteHandlerFn = (request) =>
  withAuth(request, CONTENT_API, async () => {
    const images = sortByName(await getAllImages(), byNameThenUpload);
    const usesById = await getImageUsesForImages(images.map(({ id }) => id));
    return jsonResponse({
      [ENTRY.path]: images.map((image) =>
        toImageRow(image, usesById.get(image.id) ?? []),
      ),
    });
  });

const imageGate = apiEntityGate(getImageById, ENTRY.label, CONTENT_API);

const handleGet: RouteHandlerFn = (request, params) =>
  imageGate(request, params.imageId as number, async (image) =>
    jsonResponse({
      [RESPONSE_KEY]: toImageRow(image, await getImageUsesForImage(image.id)),
    }),
  );

const handleCreate: RouteHandlerFn = (request) =>
  withAuth(request, CONTENT_API, async (_session, body) => {
    const input = createImageInput(body);
    if (!input.ok) return apiErrorResponse(input.error);
    const stored = await storeImage(input.value.metadata, input.value.file);
    if (!stored.ok) return apiErrorResponse(stored.error);
    await logImageAction("uploaded", stored.value.name);
    return jsonResponse({ [RESPONSE_KEY]: toImageRow(stored.value, []) }, 201);
  });

/** What one update's transaction answers: the row it wrote, a row deleted
 *  before the commit, or the link refusal. */
type UpdateTxOutcome =
  | { conflict: string }
  | { notFound: true }
  | { row: Image };

/** The row write and its links commit together. A link that names no stored
 *  record refuses the whole write, so the image keeps the fields and links it
 *  had. */
const updateInTransaction = async (
  tx: TxScope,
  image: Image,
  input: ImageUpdate,
): Promise<UpdateTxOutcome> => {
  const missing = await missingImageUseTargets(tx, input.items ?? []);
  refuseTheWriteOn(
    missing.length === 0
      ? null
      : `items must name existing records: ${missing
          .map(imageUseTargets.key)
          .join(", ")}`,
  );
  const row = await updateImageRecord(
    image.id,
    { altText: input.metadata.altText, name: input.metadata.name },
    tx,
  );
  if (row === null) return { notFound: true };
  if (input.items !== null) await setItemsForImage(image.id, input.items, tx);
  return { row };
};

/** What one update answers: the row it wrote, or the response that refuses
 *  it. */
type UpdateOutcome = { refusal: Response } | { row: Image };

export const writeImageUpdate = async (
  image: Image,
  input: ImageUpdate,
): Promise<UpdateOutcome> => {
  const outcome = await withTransaction((tx) =>
    updateInTransaction(tx, image, input),
  ).catch((error) => ({
    conflict: transactionValidationMessageOrRethrow(error),
  }));
  if ("conflict" in outcome) {
    return { refusal: apiErrorResponse(outcome.conflict) };
  }
  if ("notFound" in outcome) {
    return { refusal: apiErrorResponse(`${ENTRY.label} not found`, 404) };
  }
  return { row: outcome.row };
};

/** One id-addressed write: load the image, then refuse it to a manager when a
 *  news post or a page shows it. */
const withWritableImage =
  (handler: EntityHandler<Image>): RouteHandlerFn =>
  (request, params) =>
    withApiEntity(
      request,
      getImageById,
      params.imageId as number,
      ENTRY.label,
      async (image, session, body) => {
        const blocked = await siteContentRefusal(session.adminLevel, image.id);
        return blocked ?? handler(image, session, body);
      },
      CONTENT_API,
    );

const handleUpdate: RouteHandlerFn = withWritableImage(
  async (image, session, body) => {
    const input = updateImageInput(image, body, session.adminLevel);
    if ("refusal" in input) return input.refusal;
    const outcome = await writeImageUpdate(image, input.update);
    if ("refusal" in outcome) return outcome.refusal;
    await logImageAction("updated", outcome.row.name);
    return jsonResponse({
      [RESPONSE_KEY]: toImageRow(
        outcome.row,
        await getImageUsesForImageOnPrimary(outcome.row.id),
      ),
    });
  },
);

const handleDelete: RouteHandlerFn = withWritableImage(
  async (image, _s, body) => {
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
    await deleteImageRecord(image.id);
    await logImageAction("deleted", image.name);
    return jsonResponse({ status: "ok" });
  },
);

export const imageApiRoutes: Record<string, RouteHandlerFn> = {
  [`DELETE ${BY_ID}`]: handleDelete,
  [`GET ${ROOT}`]: handleList,
  [`GET ${BY_ID}`]: handleGet,
  [`POST ${ROOT}`]: handleCreate,
  [`PUT ${BY_ID}`]: handleUpdate,
};
