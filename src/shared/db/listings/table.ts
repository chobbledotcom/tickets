/** Listing table schema and stored-value transforms. */

import { projectCatalogFields } from "#shared/catalog-fields/definition.ts";
import {
  type ListingInput,
  listingCatalogFields,
} from "#shared/catalog-fields/fields.ts";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import type { BlindIndex, EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import {
  encryptedNameSchema,
  idAndEncryptedSlugSchema,
} from "#shared/db/common-schema.ts";
import { defineIdTable } from "#shared/db/define-id-table.ts";
import { decryptTextOrEmpty } from "#shared/db/encrypted-text.ts";
import { defineTableProjection } from "#shared/db/projection.ts";
import { col } from "#shared/db/table.ts";
import { decryptImageFilenameOrEmpty } from "#shared/images/broken.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { nowIso } from "#shared/now.ts";
import type { Listing } from "#shared/types.ts";

/** Compute the blind index used for listing slug lookups. */
export const computeSlugIndex = (slug: string): Promise<BlindIndex> =>
  hmacHash(slug);

const TZ_SUFFIX_REGEX = /(?:Z|[+-]\d{2}:\d{2})$/i;

const normalizeUtcDatetime = (value: string, label: string): string => {
  if (value === "") return "";
  let normalized = value;
  if (!TZ_SUFFIX_REGEX.test(value)) {
    logError({
      code: ErrorCode.DATA_INVALID,
      detail: `${label} missing timezone offset (${value})`,
    });
    normalized = `${value}Z`;
  }
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} has invalid datetime: ${value}`);
  }
  return date.toISOString();
};

const encryptDatetime = (
  value: string,
  label: string,
): Promise<EnvKeyEncrypted> => encrypt(normalizeUtcDatetime(value, label));

const decryptDatetime = async (value: EnvKeyEncrypted): Promise<string> => {
  const decrypted = await decrypt(value);
  return normalizeUtcDatetime(decrypted, "stored datetime");
};

const writeClosesAt = (value: string | null): Promise<EnvKeyEncrypted> =>
  // defineTable skips write transforms for null values.
  encryptDatetime(value as string, "closes_at");

const readClosesAt = async (value: string | null): Promise<string | null> => {
  // closes_at is NOT NULL and always stores env-key ciphertext.
  const result = await decryptDatetime(value as EnvKeyEncrypted);
  return result === "" ? null : result;
};

const writeListingDate = (value: string): Promise<EnvKeyEncrypted> =>
  encryptDatetime(value, "date");

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
    ...encryptedNameSchema(encrypt, decrypt),
    closes_at: col.transform<string | null>(writeClosesAt, readClosesAt),
    created: col.withDefault(() => nowIso()),
    date: {
      default: () => "",
      ...col.encrypted(writeListingDate, decryptDatetime),
    },
    image_alt_text: col.projected<string>(readProjectedAltText),
    image_thumb_url: col.projected<string>(
      readProjectedImageFilename("thumbnail image"),
    ),
    image_url: col.projected<string>(readProjectedImageFilename("image")),
    ...projectCatalogFields(listingCatalogFields, "columns", {}),
  },
);

export type ListingOption = Pick<Listing, "active" | "id" | "name">;

/** The shared narrow listing shape used by listing and attribute pickers. */
export const listingOptionProjection = defineTableProjection(rawListingsTable, [
  "id",
  "name",
  "active",
]);
