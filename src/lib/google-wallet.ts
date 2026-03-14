/**
 * Google Wallet event ticket pass generation
 *
 * Generates signed JWTs for "Add to Google Wallet" links.
 * The JWT contains both an EventTicketClass and EventTicketObject inline,
 * so no pre-creation via the REST API is needed.
 *
 * JWT is signed with RS256 using a Google Cloud service account private key.
 * The resulting URL format: https://pay.google.com/gp/v/save/{jwt}
 */

import { getDecimalPlaces } from "#lib/currency.ts";
import { startOfHour } from "#lib/dates.ts";
import type { WalletPassData } from "#routes/token-utils.ts";


/** Google Wallet credentials from service account */
export type GoogleWalletCredentials = {
  /** Issuer ID from the Google Wallet Business Console */
  issuerId: string;
  /** Service account email address */
  serviceAccountEmail: string;
  /** PEM-encoded RSA private key from the service account JSON key file */
  serviceAccountKey: string;
};

/** Base64url-encode a Uint8Array (no padding) */
const base64url = (data: Uint8Array): string =>
  btoa(String.fromCharCode(...data))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** Base64url-encode a UTF-8 string */
const base64urlStr = (str: string): string =>
  base64url(new TextEncoder().encode(str));

/** Strip PEM headers/footers and decode base64 to raw bytes */
const pemToBytes = (pem: string): Uint8Array => {
  const b64 = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s/g, "");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};

/** Import a PEM RSA private key for RS256 signing */
const importPrivateKey = (pem: string): Promise<CryptoKey> => {
  const bytes = pemToBytes(pem);
  return crypto.subtle.importKey(
    "pkcs8",
    bytes.buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
};

/** Validate that a string is a parseable PEM private key (PKCS8 format) */
export const isValidGooglePrivateKey = async (
  pem: string,
): Promise<boolean> => {
  try {
    await importPrivateKey(pem);
    return true;
  } catch {
    return false;
  }
};

/** Build the EventTicketClass for inline JWT creation */
export const buildEventTicketClass = (
  data: WalletPassData,
  creds: GoogleWalletCredentials,
): Record<string, unknown> => ({
  id: `${creds.issuerId}.${data.serialNumber}-class`,
  issuerName: data.organizationName,
  reviewStatus: "UNDER_REVIEW",
  eventName: {
    defaultValue: {
      language: "en-US",
      value: data.eventName,
    },
  },
  ...(data.eventDate
    ? {
        dateTime: {
          start: data.eventDate,
        },
      }
    : {}),
  ...(data.eventLocation
    ? {
        venue: {
          name: {
            defaultValue: {
              language: "en-US",
              value: data.eventLocation,
            },
          },
        },
      }
    : {}),
});

/** Build the EventTicketObject for inline JWT creation */
export const buildEventTicketObject = (
  data: WalletPassData,
  creds: GoogleWalletCredentials,
): Record<string, unknown> => {
  const textModules: Array<Record<string, unknown>> = [];

  if (data.attendeeDate) {
    textModules.push({
      id: "booking-date",
      header: "BOOKING DATE",
      body: data.attendeeDate,
    });
  }

  if (data.quantity > 1) {
    textModules.push({
      id: "qty",
      header: "QTY",
      body: String(data.quantity),
    });
  }

  if (data.pricePaid > 0) {
    const majorUnits =
      data.pricePaid / 10 ** getDecimalPlaces(data.currencyCode);
    textModules.push({
      id: "price",
      header: "PRICE",
      body: `${majorUnits} ${data.currencyCode}`,
    });
  }

  return {
    id: `${creds.issuerId}.${data.serialNumber}`,
    classId: `${creds.issuerId}.${data.serialNumber}-class`,
    state: "ACTIVE",
    barcode: {
      type: "QR_CODE",
      value: data.checkinUrl,
    },
    ...(textModules.length > 0 ? { textModulesData: textModules } : {}),
  };
};

/** Build the full JWT payload for a Google Wallet save link */
export const buildJwtPayload = (
  data: WalletPassData,
  creds: GoogleWalletCredentials,
): Record<string, unknown> => ({
  iss: creds.serviceAccountEmail,
  aud: "google",
  typ: "savetowallet",
  iat: Math.floor(startOfHour(new Date()).getTime() / 1000),
  origins: [],
  payload: {
    eventTicketClasses: [buildEventTicketClass(data, creds)],
    eventTicketObjects: [buildEventTicketObject(data, creds)],
  },
});

/** Sign a JWT payload with RS256 using the service account private key */
export const signJwt = async (
  payload: Record<string, unknown>,
  privateKeyPem: string,
): Promise<string> => {
  const header = { alg: "RS256", typ: "JWT" };
  const headerB64 = base64urlStr(JSON.stringify(header));
  const payloadB64 = base64urlStr(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
};

/** Google Wallet save link base URL */
const SAVE_URL = "https://pay.google.com/gp/v/save/";

/** Generate the full "Add to Google Wallet" save URL */
export const buildGoogleWalletUrl = async (
  data: WalletPassData,
  creds: GoogleWalletCredentials,
): Promise<string> => {
  const payload = buildJwtPayload(data, creds);
  const jwt = await signJwt(payload, creds.serviceAccountKey);
  return `${SAVE_URL}${jwt}`;
};
