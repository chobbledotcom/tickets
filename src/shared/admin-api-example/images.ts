/**
 * The images resource's doc entries. The paths come from the resource table,
 * so the docs cannot disagree with the server about them. A create body
 * carries the file as base64 text. An update body carries the records that
 * show the image.
 */

import type * as v from "valibot";
import type {
  CreateImageBodySchema,
  ImageRowSchema,
  UpdateImageBodySchema,
} from "#shared/admin-api-images.ts";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import type { DeleteBody } from "#shared/rest/crud-parsers.ts";
import { crudDocs, type EndpointDoc } from "./endpoint-doc.ts";

/** A real 1×1 PNG as base64 text: the smallest honest example of the file a
 *  create carries. */
const EXAMPLE_FILE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

/** One image as the library answers with it: the stored name and alt text,
 *  and the URL of each stored file. It also carries the records that show
 *  it. */
const ADMIN_API_EXAMPLE_IMAGE = {
  alt_text: "A watercolour of the village hall",
  id: 12,
  items: [{ item_id: 4, item_type: "listing" }],
  name: "Summer workshop poster",
  thumb_url: "/image/0b6f3c1e-9a2d-4c8f-b5e7-3d1a8c2f4e60.webp",
  url: "/image/7c4e2a90-5b1d-4f3a-8e6c-9a2b7d5f1c38.webp",
} satisfies v.InferOutput<typeof ImageRowSchema>;

const ADMIN_API_IMAGE_CREATE_BODY = {
  alt_text: "A watercolour of the village hall",
  content_type: "image/png",
  file: EXAMPLE_FILE_BASE64,
  name: "Summer workshop poster",
} satisfies v.InferOutput<typeof CreateImageBodySchema>;

/** The answer to that create: the record as just stored, with no records
 *  showing it yet and the two files the upload wrote. The body's file text is
 *  never echoed, because the server stores the files, not the request. */
const ADMIN_API_EXAMPLE_CREATED_IMAGE = {
  ...ADMIN_API_EXAMPLE_IMAGE,
  alt_text: ADMIN_API_IMAGE_CREATE_BODY.alt_text,
  id: 13,
  items: [],
  name: ADMIN_API_IMAGE_CREATE_BODY.name,
  thumb_url: "/image/4f1c8b6d-2e3a-4d5b-9f7e-1c8a6b3d2e94.webp",
  url: "/image/9a3d5f2b-7c1e-4b6d-8f4a-2e9c7b1d5a63.webp",
} satisfies v.InferOutput<typeof ImageRowSchema>;

const ADMIN_API_IMAGE_UPDATE_BODY = {
  items: [
    { item_id: 4, item_type: "listing" },
    { item_id: 7, item_type: "group" },
  ],
  name: "Summer workshop poster (2026)",
} satisfies v.InferOutput<typeof UpdateImageBodySchema>;

const ADMIN_API_IMAGE_DELETE_BODY = {
  confirm_identifier: "Summer workshop poster",
} satisfies DeleteBody;

export const IMAGE_ENDPOINTS: EndpointDoc[] = crudDocs({
  createBody: ADMIN_API_IMAGE_CREATE_BODY,
  // The upload answers the stored record, not the request.
  createResponse: ADMIN_API_EXAMPLE_CREATED_IMAGE,
  deleteBody: ADMIN_API_IMAGE_DELETE_BODY,
  desc: [
    "List every image in the library, each with the records that show it. The list is in the library's own order: image name A to Z, with the older upload first when two images share a name.",
    "Get one image by ID, with its two URLs and the records that show it.",
    "Upload an image (all content admins). The body carries the file's bytes as base64 text and the type the caller declares for them, and the server checks that type against the file's own bytes. The image shows nowhere until a record is linked to it.",
    "Update an image's name, alt text, or the records that show it (all fields optional). The records in items replace the stored links. An image on a news post or a page belongs to the site editors, so a manager cannot change it.",
    "Delete an image and its stored files (requires the image name as confirmation)",
  ],
  entry: ADMIN_API_RESOURCES.images,
  example: ADMIN_API_EXAMPLE_IMAGE,
  listResponse: { images: [ADMIN_API_EXAMPLE_IMAGE] },
  singular: "image",
  updateBody: ADMIN_API_IMAGE_UPDATE_BODY,
});
