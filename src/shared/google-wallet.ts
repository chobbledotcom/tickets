/**
 * Google Wallet listing ticket pass generation
 *
 * Generates signed JWTs for "Add to Google Wallet" links.
 * The JWT contains both an ListingTicketClass and ListingTicketObject inline,
 * so no pre-creation via the REST API is needed.
 *
 * JWT is signed with RS256 using a Google Cloud service account private key.
 * The resulting URL format: https://pay.google.com/gp/v/save/{jwt}
 */

import { t } from "#i18n";
import type { WalletPassData } from "#routes/tickets/token-utils.ts";
import { rsaPrivateKeyBytes } from "#shared/crypto/rsa-private-key.ts";
import { getDecimalPlaces } from "#shared/currency.ts";
import { startOfHour } from "#shared/dates.ts";

/** Google Wallet credentials from service account */
export type GoogleWalletCredentials = {
  /** Issuer ID from the Google Wallet Business Console */
  issuerId: string;
  /** Service account email address */
  serviceAccountEmail: string;
  /** PEM-encoded RSA private key from the service account JSON key file */
  serviceAccountKey: string;
};

/** Builds one part of the wallet pass (a class, object, or JWT payload) from the
 *  pass data and the issuer's service-account credentials. */
type WalletPartBuilder = (
  data: WalletPassData,
  creds: GoogleWalletCredentials,
) => Record<string, unknown>;

/** Base64url-encode a Uint8Array (no padding) */
const base64url = (data: Uint8Array): string =>
  data.toBase64({ alphabet: "base64url", omitPadding: true });

/** Base64url-encode a UTF-8 string */
const base64urlStr = (str: string): string =>
  base64url(new TextEncoder().encode(str));

/** Import a PEM RSA private key for RS256 signing */
const importPrivateKey = (pem: string): Promise<CryptoKey> => {
  const bytes = rsaPrivateKeyBytes(pem);
  return crypto.subtle.importKey(
    "pkcs8",
    bytes.buffer as ArrayBuffer,
    { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
    false,
    ["sign"],
  );
};

/** Validate an unencrypted PKCS#1 or PKCS#8 RSA key via Web Crypto import. */
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

/** A Google Wallet localized string holding a single en-US value. */
const localizedString = (
  value: string,
): { defaultValue: { language: string; value: string } } => ({
  defaultValue: { language: "en-US", value },
});

/** Build the ListingTicketClass for inline JWT creation */
export const buildListingTicketClass: WalletPartBuilder = (data, creds) => ({
  id: `${creds.issuerId}.${data.serialNumber}-class`,
  issuerName: data.organizationName,
  listingName: localizedString(data.listingName),
  reviewStatus: "UNDER_REVIEW",
  ...(data.listingDate
    ? {
        dateTime: {
          start: data.listingDate,
        },
      }
    : {}),
  ...(data.listingLocation
    ? {
        venue: {
          address: localizedString(data.listingLocation),
          name: localizedString(data.listingLocation),
        },
      }
    : {}),
});

/** Build the ListingTicketObject for inline JWT creation */
export const buildListingTicketObject: WalletPartBuilder = (data, creds) => {
  const textModules: Record<string, unknown>[] = [];

  if (data.attendeeDate) {
    textModules.push({
      body: data.attendeeDate,
      header: t("fields.wallet.google.booking_date_label"),
      id: "booking-date",
    });
  }

  if (data.quantity > 1) {
    textModules.push({
      body: String(data.quantity),
      header: t("fields.wallet.google.qty_label"),
      id: "qty",
    });
  }

  if (data.pricePaid > 0) {
    const majorUnits =
      data.pricePaid / 10 ** getDecimalPlaces(data.currencyCode);
    textModules.push({
      body: `${majorUnits} ${data.currencyCode}`,
      header: t("fields.wallet.google.price_label"),
      id: "price",
    });
  }

  return {
    barcode: {
      type: "QR_CODE",
      value: data.checkinUrl,
    },
    classId: `${creds.issuerId}.${data.serialNumber}-class`,
    id: `${creds.issuerId}.${data.serialNumber}`,
    state: "ACTIVE",
    ...(textModules.length > 0 ? { textModulesData: textModules } : {}),
  };
};

/** Build the full JWT payload for a Google Wallet save link */
export const buildJwtPayload: WalletPartBuilder = (data, creds) => ({
  aud: "google",
  iat: Math.floor(startOfHour(new Date()).getTime() / 1000),
  iss: creds.serviceAccountEmail,
  origins: [],
  payload: {
    listingTicketClasses: [buildListingTicketClass(data, creds)],
    listingTicketObjects: [buildListingTicketObject(data, creds)],
  },
  typ: "savetowallet",
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
