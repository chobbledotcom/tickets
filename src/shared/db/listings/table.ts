/** Listing table schema and stored-value transforms. */

import { decrypt, encrypt } from "#crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import { idAndEncryptedSlugSchema } from "#db/common-schema.ts";
import { defineIdTable } from "#db/define-id-table.ts";
import { decryptTextOrEmpty } from "#db/encrypted-text.ts";
import { fieldColumns } from "#db/field-columns.ts";
import { col } from "#db/table.ts";
import { decryptImageFilenameOrEmpty } from "#shared/images/broken.ts";
import { nowIso } from "#shared/now.ts";
import {
  LISTING_FIELDS,
  type ListingInput,
} from "#shared/records/listing-fields.ts";
import type { Listing } from "#types";

// The `as` cast is the sanctioned read boundary for a projected encrypted
// column — the raw SELECT value re-enters the typed world here.
const readProjectedAltText = (value: unknown): string | Promise<string> =>
  decryptTextOrEmpty(value as EnvKeyEncrypted | "" | undefined);

/** Read one of the projected first-image filename columns. A filename that
 * will not read back becomes the broken-image marker (reported, not thrown)
 * so a listing page still renders — see #shared/images/broken.ts. */
const readProjectedImageFilename =
  (label: string) =>
  (value: unknown, rowId?: unknown): string | Promise<string> =>
    decryptImageFilenameOrEmpty(
      value as string | undefined,
      `listing ${String(rowId)} ${label}`,
    );

/** Raw listings table. Records adds cache-aware CRUD and price syncing. */
export const rawListingsTable = defineIdTable<Listing, ListingInput>(
  "listings",
  {
    ...idAndEncryptedSlugSchema(encrypt, decrypt),
    attachment_name: col.encryptedText(encrypt, decrypt),
    attachment_url: col.encryptedText(encrypt, decrypt),
    created: col.withDefault(() => nowIso()),
    image_alt_text: col.projected<string>(readProjectedAltText),
    image_thumb_url: col.projected<string>(
      readProjectedImageFilename("thumbnail image"),
    ),
    image_url: col.projected<string>(readProjectedImageFilename("image")),
    ...fieldColumns("listings", LISTING_FIELDS)(encrypt, decrypt),
  },
);

export type ListingOption = Pick<Listing, "active" | "id" | "name">;

/** The shared narrow listing shape used by listing and attribute pickers. */
export const listingOptionColumns = rawListingsTable.read.pick([
  "id",
  "name",
  "active",
]);
