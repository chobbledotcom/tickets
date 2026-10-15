/**
 * Settings key groups behind the prefix declaration in `prefixes.ts`.
 * `settingsForPath` unions a prefix's bundle with INFRA_SETTINGS, so each
 * entry lists only the extra keys its handlers read. The whole set is
 * fetched in one `WHERE key IN (...)` query.
 */

import { CONFIG_KEYS, EMAIL_BODY_KEYS, SNAPSHOT_KEYS } from "#db/settings.ts";

/**
 * Extra keys the full public-page nav reads (theme and header are in infra).
 * Pages built on `publicPage`/`PublicNav` need them: home, listings, terms,
 * contact, order, and the ticket forms. Pages on the bare `Layout` do not.
 */
export const PUBLIC_NAV_SETTINGS: readonly string[] = [
  CONFIG_KEYS.WEBSITE_TITLE,
  CONFIG_KEYS.CONTACT_PAGE_TEXT,
  CONFIG_KEYS.CONTACT_FORM_ENABLED,
  CONFIG_KEYS.BUSINESS_EMAIL,
  CONFIG_KEYS.ORDER_ENABLED,
  CONFIG_KEYS.TERMS_AND_CONDITIONS,
];

/** Keys needed to resolve providers for new checkouts and existing payments. */
export const PAYMENT_SETTINGS: readonly string[] = [
  CONFIG_KEYS.PAYMENT_PROVIDER,
  CONFIG_KEYS.LAST_ACTIVE_PAYMENT_PROVIDER,
  CONFIG_KEYS.COUNTRY,
  CONFIG_KEYS.BOOKING_FEE,
  CONFIG_KEYS.STRIPE_SECRET_KEY,
  CONFIG_KEYS.STRIPE_WEBHOOK_ENDPOINT_ID,
  CONFIG_KEYS.STRIPE_WEBHOOK_SECRET,
  CONFIG_KEYS.SQUARE_ACCESS_TOKEN,
  CONFIG_KEYS.SQUARE_LOCATION_ID,
  CONFIG_KEYS.SQUARE_SANDBOX,
  CONFIG_KEYS.SQUARE_WEBHOOK_SIGNATURE_KEY,
  CONFIG_KEYS.SUMUP_API_KEY,
  CONFIG_KEYS.SUMUP_MERCHANT_CODE,
];

/** Keys the registration/confirmation email pipeline reads. */
export const EMAIL_SETTINGS: readonly string[] = [
  CONFIG_KEYS.BUSINESS_EMAIL,
  CONFIG_KEYS.EMAIL_PROVIDER,
  ...EMAIL_BODY_KEYS,
];

/** Apple Wallet pass generation reads all five cert/identifier keys. */
export const APPLE_WALLET_SETTINGS: readonly string[] = [
  CONFIG_KEYS.APPLE_WALLET_PASS_TYPE_ID,
  CONFIG_KEYS.APPLE_WALLET_TEAM_ID,
  CONFIG_KEYS.APPLE_WALLET_SIGNING_CERT,
  CONFIG_KEYS.APPLE_WALLET_SIGNING_KEY,
  CONFIG_KEYS.APPLE_WALLET_WWDR_CERT,
];

/** Google Wallet pass generation reads all three issuer/service-account keys. */
export const GOOGLE_WALLET_SETTINGS: readonly string[] = [
  CONFIG_KEYS.GOOGLE_WALLET_ISSUER_ID,
  CONFIG_KEYS.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL,
  CONFIG_KEYS.GOOGLE_WALLET_SERVICE_ACCOUNT_KEY,
];

/**
 * Extra keys read when an *owner* session authenticates. The settings-nag
 * banner (`getSettingsNagItemsForOwner`) checks the payment provider, the
 * business email, the superuser choice, and the domain config. `custom_domain`
 * and `bunny_subdomain` are already infra.
 */
export const OWNER_AUTH_SETTINGS: readonly string[] = [
  CONFIG_KEYS.PAYMENT_PROVIDER,
  CONFIG_KEYS.BUSINESS_EMAIL,
  CONFIG_KEYS.SUPERUSER_CHOICE,
];

/** The whole booking flow (form + checkout + confirmation emails). */
export const BOOKING_FLOW_SETTINGS: readonly string[] = [
  ...PUBLIC_NAV_SETTINGS,
  ...PAYMENT_SETTINGS,
  ...EMAIL_SETTINGS,
];

/** Booking flows that run embedded or reprice the cart read the embed
 * allow-list and the address-lookup provider on top of the booking flow. */
export const EMBEDDABLE_BOOKING_FLOW_SETTINGS: readonly string[] = [
  ...BOOKING_FLOW_SETTINGS,
  CONFIG_KEYS.EMBED_HOSTS,
  CONFIG_KEYS.ADDRESS_LOOKUP_PROVIDER,
];

/**
 * The full snapshot, for routes that can touch any setting. The readers are
 * the admin HTML pages and the public booking API. `POST /api/.../book` fans
 * out into the entire payment, email, and country surface. `admin` also reads
 * `db_schema_hash` on the debug page. Migrations write that key. It is not a
 * snapshot field. `settingsForPath` adds infra on top.
 */
export const ALL_SNAPSHOT_SETTINGS: readonly string[] = SNAPSHOT_KEYS;
export const ADMIN_SETTINGS: readonly string[] = [
  ...SNAPSHOT_KEYS,
  "db_schema_hash",
];
