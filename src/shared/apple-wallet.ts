/**
 * Apple Wallet (.pkpass) generation
 *
 * Generates signed .pkpass files (ZIP archives) containing:
 * - pass.json: Declarative pass content (listing name, date, QR code, etc.)
 * - icon.png / icon@2x.png / icon@3x.png: Pre-rendered pass icons
 * - manifest.json: SHA-1 hashes of all files
 * - signature: PKCS#7 detached signature of manifest.json
 */

import { zipSync } from "fflate";
import forge from "node-forge";
import { t } from "#i18n";
import { getDecimalPlaces } from "#shared/currency.ts";
import { startOfHour } from "#shared/dates.ts";
import { WALLET_ICONS } from "#shared/wallet-icons.ts";

// Force pure-JS mode so node-forge never attempts require("crypto").
// The Bunny Edge runtime sets process.versions.node (via the node:process
// global), which makes node-forge think it's running in Node and try to
// load native crypto — causing "Dynamic require of 'crypto' is not supported".
forge.options.usePureJavaScript = true;

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
    backgroundColor: data.backgroundColor ?? "rgb(255, 255, 255)",
    barcodes: [
      {
        format: "PKBarcodeFormatQR",
        message: data.checkinUrl,
        messageEncoding: "iso-8859-1",
      },
    ],
    description: data.description,
    foregroundColor: data.foregroundColor ?? "rgb(0, 0, 0)",
    formatVersion: 1,
    labelColor: data.labelColor ?? "rgb(100, 100, 100)",
    listingTicket: buildListingTicketFields(data),
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

/** listingTicket field groups with typed arrays */
type ListingTicketFields = {
  primaryFields: PassField[];
  secondaryFields: PassField[];
  auxiliaryFields: PassField[];
  backFields: PassField[];
};

/** Build the listingTicket field groups */
const buildListingTicketFields = (data: PassData): ListingTicketFields => {
  const fields: ListingTicketFields = {
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

/** Validate that a string is a parseable PEM certificate */
export const isValidPemCertificate = (pem: string): boolean => {
  try {
    forge.pki.certificateFromPem(pem);
    return true;
  } catch {
    return false;
  }
};

/** Validate that a string is a parseable PEM private key */
export const isValidPemPrivateKey = (pem: string): boolean => {
  try {
    forge.pki.privateKeyFromPem(pem);
    return true;
  } catch {
    return false;
  }
};

/** Compute SHA-1 hex digest of a Uint8Array */
export const sha1Hex = (data: Uint8Array): string => {
  const md = forge.md.sha1.create();
  md.update(forge.util.binary.raw.encode(data));
  return md.digest().toHex();
};

/** Create manifest.json mapping filenames to SHA-1 hashes */
export const createManifest = (files: Record<string, Uint8Array>): string => {
  const manifest: Record<string, string> = {};
  for (const [name, data] of Object.entries(files)) {
    manifest[name] = sha1Hex(data);
  }
  return JSON.stringify(manifest);
};

/** Sign the manifest with PKCS#7 detached signature */
export const signManifest = (
  manifestData: string,
  signingCertPem: string,
  signingKeyPem: string,
  wwdrCertPem: string,
): Uint8Array => {
  const cert = forge.pki.certificateFromPem(signingCertPem);
  const key = forge.pki.privateKeyFromPem(signingKeyPem);
  const wwdr = forge.pki.certificateFromPem(wwdrCertPem);

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(manifestData, "utf8");
  p7.addCertificate(cert);
  p7.addCertificate(wwdr);
  p7.addSigner({
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: startOfHour(new Date()) },
    ],
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    key,
  });
  p7.sign({ detached: true });

  const asn1 = p7.toAsn1();
  const der = forge.asn1.toDer(asn1);
  return new Uint8Array(forge.util.binary.raw.decode(der.getBytes()));
};

/** Build a complete .pkpass file as a Uint8Array (ZIP archive) */
export const buildPkpass = (
  data: PassData,
  creds: SigningCredentials,
): Uint8Array => {
  const passJson = generatePassJson(data, creds);
  const passJsonBytes = new TextEncoder().encode(JSON.stringify(passJson));

  const files: Record<string, Uint8Array> = {
    "pass.json": passJsonBytes,
    ...WALLET_ICONS,
  };

  const manifestJson = createManifest(files);
  const manifestBytes = new TextEncoder().encode(manifestJson);

  const signature = signManifest(
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
