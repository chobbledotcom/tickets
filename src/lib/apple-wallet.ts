/**
 * Apple Wallet (.pkpass) generation
 *
 * Generates signed .pkpass files (ZIP archives) containing:
 * - pass.json: Declarative pass content (event name, date, QR code, etc.)
 * - icon.png / icon@2x.png / icon@3x.png: Pre-rendered pass icons
 * - manifest.json: SHA-1 hashes of all files
 * - signature: PKCS#7 detached signature of manifest.json
 */

import { zipSync } from "fflate";
import forge from "node-forge";
import { getDecimalPlaces } from "#lib/currency.ts";
import { WALLET_ICONS } from "#lib/wallet-icons.ts";

// Force pure-JS mode so node-forge never attempts require("crypto").
// The Bunny Edge runtime sets process.versions.node (via the node:process
// global), which makes node-forge think it's running in Node and try to
// load native crypto — causing "Dynamic require of 'crypto' is not supported".
forge.options.usePureJavaScript = true;

/** Data needed to generate a pass — maps to existing ticket/event data */
export type PassData = {
  /** Unique token identifying this ticket */
  serialNumber: string;
  /** Platform/domain name shown on the pass header */
  organizationName: string;
  /** VoiceOver accessibility description for the pass */
  description: string;
  /** Event name displayed in the primary field */
  eventName: string;
  /** ISO 8601 date used for relevantDate and secondary field */
  eventDate: string;
  /** Venue shown in secondary field */
  eventLocation: string;
  /** Selected date for daily/recurring events (null for one-off events) */
  attendeeDate: string | null;
  /** Ticket quantity and price (in minor units, e.g. pence) */
  quantity: number;
  pricePaid: number;
  currencyCode: string;
  /** Full URL encoded in the QR barcode */
  checkinUrl: string;
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

/** Build the pass.json content from pass data and signing credentials */
export const generatePassJson = (
  data: PassData,
  creds: SigningCredentials,
): Record<string, unknown> => {
  const pass: Record<string, unknown> = {
    formatVersion: 1,
    passTypeIdentifier: creds.passTypeId,
    serialNumber: data.serialNumber,
    teamIdentifier: creds.teamId,
    organizationName: data.organizationName,
    description: data.description,
    foregroundColor: data.foregroundColor ?? "rgb(0, 0, 0)",
    backgroundColor: data.backgroundColor ?? "rgb(255, 255, 255)",
    labelColor: data.labelColor ?? "rgb(100, 100, 100)",
    barcodes: [
      {
        format: "PKBarcodeFormatQR",
        message: data.checkinUrl,
        messageEncoding: "iso-8859-1",
      },
    ],
    eventTicket: buildEventTicketFields(data),
  };

  if (data.eventDate) {
    pass.relevantDate = data.eventDate;
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
    primaryFields: [{ key: "event", label: "EVENT", value: data.eventName }],
    secondaryFields: [],
    auxiliaryFields: [],
    backFields: [],
  };

  if (data.eventDate) {
    fields.secondaryFields.push({
      key: "date",
      label: "DATE",
      value: data.eventDate,
      dateStyle: "PKDateStyleMedium",
      timeStyle: "PKDateStyleShort",
    });
  }

  if (data.eventLocation) {
    fields.secondaryFields.push({
      key: "location",
      label: "LOCATION",
      value: data.eventLocation,
    });
  }

  if (data.attendeeDate) {
    fields.auxiliaryFields.push({
      key: "booking-date",
      label: "BOOKING DATE",
      value: data.attendeeDate,
    });
  }

  if (data.quantity > 1) {
    fields.auxiliaryFields.push({
      key: "qty",
      label: "QTY",
      value: data.quantity,
    });
  }

  if (data.pricePaid > 0) {
    fields.auxiliaryFields.push({
      key: "price",
      label: "PRICE",
      value: data.pricePaid / 10 ** getDecimalPlaces(data.currencyCode),
      currencyCode: data.currencyCode,
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

/** Round a date down to the start of the current hour for cache-stable signatures */
const startOfHour = (date: Date): Date => {
  const d = new Date(date);
  d.setMinutes(0, 0, 0);
  return d;
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
    key,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: startOfHour(new Date()) },
    ],
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
