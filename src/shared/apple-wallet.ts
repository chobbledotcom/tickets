/**
 * Apple Wallet (.pkpass) generation
 *
 * Generates signed .pkpass files (ZIP archives) containing:
 * - pass.json: Declarative pass content (listing name, date, QR code, etc.)
 * - icon.png / icon@2x.png / icon@3x.png: Pre-rendered pass icons
 * - manifest.json: SHA-1 hashes of all files
 * - signature: CMS/PKCS #7 detached signature of manifest.json
 */

import { zipSync } from "fflate";
import { t } from "#i18n";
import { signManifest } from "#shared/apple-wallet/cms.ts";
import { getDecimalPlaces } from "#shared/currency.ts";
import { WALLET_ICONS } from "#shared/wallet-icons.ts";

/** Shared wallet pass data common to both Apple and Google Wallet */
export type WalletPassData = {
  serialNumber: string;
  organizationName: string;
  listingName: string;
  listingDate: string;
  listingLocation: string;
  attendeeDate: string | null;
  quantity: number;
  pricePaid: number;
  currencyCode: string;
  checkinUrl: string;
};

/** Data needed to generate a pass — maps to existing ticket/listing data */
export type PassData = WalletPassData & {
  /** VoiceOver accessibility description for the pass */
  description: string;
  /** Base URL for Apple Wallet web service (e.g. https://example.com) */
  webServiceURL: string;
  /** Optional pass colors (CSS rgb() format) */
  foregroundColor?: string;
  backgroundColor?: string;
  labelColor?: string;
};

/** Apple Wallet signing credentials */
export type SigningCredentials = {
  passTypeId: string;
  teamId: string;
  signingCert: string;
  signingKey: string;
  wwdrCert: string;
};

/** Apple requires authenticationToken to be at least 16 characters */
const MIN_AUTH_TOKEN_LENGTH = 16;

/**
 * Pad a serial number to meet Apple's minimum authenticationToken length.
 * Uses "-" (not in uppercase hex charset) so padding is cleanly reversible.
 */
export const padAuthToken = (serial: string): string =>
  serial.padEnd(MIN_AUTH_TOKEN_LENGTH, "-");

/** Strip padding added by padAuthToken to recover the original serial number */
export const trimAuthToken = (authToken: string): string =>
  authToken.replace(/-+$/, "");

/** Build the pass.json content from pass data and signing credentials */
export const generatePassJson = (
  data: PassData,
  creds: SigningCredentials,
): Record<string, unknown> => {
  const pass: Record<string, unknown> = {
    authenticationToken: padAuthToken(data.serialNumber),
    backgroundColor: data.backgroundColor || "rgb(255, 255, 255)",
    barcodes: [
      {
        format: "PKBarcodeFormatQR",
        message: data.checkinUrl,
        messageEncoding: "iso-8859-1",
      },
    ],
    description: data.description,
    eventTicket: buildEventTicketFields(data),
    foregroundColor: data.foregroundColor || "rgb(0, 0, 0)",
    formatVersion: 1,
    labelColor: data.labelColor || "rgb(100, 100, 100)",
    organizationName: data.organizationName,
    passTypeIdentifier: creds.passTypeId,
    serialNumber: data.serialNumber,
    teamIdentifier: creds.teamId,
    webServiceURL: data.webServiceURL,
  };

  if (data.listingDate) {
    pass.relevantDate = data.listingDate;
  }

  return pass;
};

/** Pass field entry */
type PassField = {
  key: string;
  label: string;
  value: string | number;
  dateStyle?: string;
  timeStyle?: string;
  currencyCode?: string;
};

/** eventTicket field groups with typed arrays */
type EventTicketFields = {
  primaryFields: PassField[];
  secondaryFields: PassField[];
  auxiliaryFields: PassField[];
  backFields: PassField[];
};

/** Build the eventTicket field groups */
const buildEventTicketFields = (data: PassData): EventTicketFields => {
  const fields: EventTicketFields = {
    auxiliaryFields: [],
    backFields: [],
    primaryFields: [
      { key: "listing", label: "LISTING", value: data.listingName },
    ],
    secondaryFields: [],
  };

  if (data.listingDate) {
    fields.secondaryFields.push({
      dateStyle: "PKDateStyleMedium",
      key: "date",
      label: t("fields.wallet.apple.date_label"),
      timeStyle: "PKDateStyleShort",
      value: data.listingDate,
    });
  }

  if (data.listingLocation) {
    fields.secondaryFields.push({
      key: "location",
      label: t("fields.wallet.apple.location_label"),
      value: data.listingLocation,
    });
  }

  if (data.attendeeDate) {
    fields.auxiliaryFields.push({
      key: "booking-date",
      label: t("fields.wallet.apple.booking_date_label"),
      value: data.attendeeDate,
    });
  }

  if (data.quantity > 1) {
    fields.auxiliaryFields.push({
      key: "qty",
      label: t("fields.wallet.apple.qty_label"),
      value: data.quantity,
    });
  }

  if (data.pricePaid > 0) {
    fields.auxiliaryFields.push({
      currencyCode: data.currencyCode,
      key: "price",
      label: t("fields.wallet.apple.price_label"),
      value: data.pricePaid / 10 ** getDecimalPlaces(data.currencyCode),
    });
  }

  return fields;
};

/** Apple requires SHA-1 for manifest entries; CMS signs the manifest with SHA-256. */
export const sha1Hex = async (data: Uint8Array): Promise<string> =>
  new Uint8Array(
    await crypto.subtle.digest("SHA-1", data as BufferSource),
  ).toHex();

/** Create manifest.json mapping filenames to SHA-1 hashes */
export const createManifest = async (
  files: Record<string, Uint8Array>,
): Promise<string> =>
  JSON.stringify(
    Object.fromEntries(
      await Promise.all(
        Object.entries(files).map(async ([name, data]) => [
          name,
          await sha1Hex(data),
        ]),
      ),
    ),
  );

/** Build a complete .pkpass file as a Uint8Array (ZIP archive) */
export const buildPkpass = async (
  data: PassData,
  creds: SigningCredentials,
): Promise<Uint8Array> => {
  const passJson = generatePassJson(data, creds);
  const passJsonBytes = new TextEncoder().encode(JSON.stringify(passJson));

  const files: Record<string, Uint8Array> = {
    "pass.json": passJsonBytes,
    ...WALLET_ICONS,
  };

  const manifestJson = await createManifest(files);
  const manifestBytes = new TextEncoder().encode(manifestJson);

  // Sign the exact JSON string stored as manifest.json. Reserializing the
  // object after signing would change its bytes and invalidate the signature.
  const signature = await signManifest(
    manifestJson,
    creds.signingCert,
    creds.signingKey,
    creds.wwdrCert,
  );

  return zipSync({
    ...files,
    "manifest.json": manifestBytes,
    signature: signature,
  });
};
