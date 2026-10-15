/**
 * The paired fold test for the prefix declaration (issue #2268), part 1:
 * settings bundles, message groups, and gates.
 *
 * Every fact below is frozen from the four pre-fold tables as they stood at
 * main 1a46674ff (PREFIX_LOADERS, PREFIX_MESSAGE_GROUPS, PREFIX_GATES in
 * src/features/app/routes.ts and PREFIX_SETTINGS in
 * src/features/settings-bundles.ts). The test checks the folded declaration
 * against them for all 34 prefixes, so the fold moves nothing. The loader
 * facts live in prefix-fold-loaders.test.ts.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { CONFIG_KEYS, EMAIL_BODY_KEYS, SNAPSHOT_KEYS } from "#db/settings.ts";
import {
  ADMIN_SHELL_MESSAGE_GROUPS,
  JOIN_MESSAGE_GROUPS,
  publicMessageGroups,
} from "#locales/groups.ts";
import { PREFIX_ROUTES, type PrefixSpec } from "#routes/app/prefixes.ts";
import { prefixHandlers } from "#routes/app/routes.ts";
import { settingsForPath } from "#routes/settings-bundles.ts";

/** Keys every request needs, frozen from the pre-fold INFRA_SETTINGS. */
const INFRA = [
  CONFIG_KEYS.LISTING_DEFAULTS,
  CONFIG_KEYS.ENABLED_FEATURES,
  CONFIG_KEYS.CUSTOM_CSS_BUNNY_FONTS,
  CONFIG_KEYS.CUSTOM_DOMAIN,
  CONFIG_KEYS.CUSTOM_DOMAIN_LAST_VALIDATED,
  CONFIG_KEYS.BUNNY_SUBDOMAIN,
  CONFIG_KEYS.SETUP_COMPLETE,
  CONFIG_KEYS.SHOW_PUBLIC_API,
  CONFIG_KEYS.THEME,
  CONFIG_KEYS.UNDERLINE_LINKS,
  CONFIG_KEYS.HEADER_IMAGE_URL,
  CONFIG_KEYS.SITE_FOOTER,
  CONFIG_KEYS.PAYMENT_PROVIDER,
  CONFIG_KEYS.SQUARE_SANDBOX,
  CONFIG_KEYS.AUTO_PURGE_ORPHANS,
  CONFIG_KEYS.ORPHAN_PURGE_RETENTION,
  CONFIG_KEYS.PUBLIC_KEY,
  CONFIG_KEYS.WRAPPED_PRIVATE_KEY,
];

// Settings key groups, frozen flat from the pre-fold settings-bundles.ts.
const PUBLIC_NAV = [
  CONFIG_KEYS.WEBSITE_TITLE,
  CONFIG_KEYS.CONTACT_PAGE_TEXT,
  CONFIG_KEYS.CONTACT_FORM_ENABLED,
  CONFIG_KEYS.BUSINESS_EMAIL,
  CONFIG_KEYS.ORDER_ENABLED,
  CONFIG_KEYS.TERMS_AND_CONDITIONS,
];
const PAYMENT = [
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
const EMAIL = [
  CONFIG_KEYS.BUSINESS_EMAIL,
  CONFIG_KEYS.EMAIL_PROVIDER,
  ...EMAIL_BODY_KEYS,
];
const APPLE_WALLET = [
  CONFIG_KEYS.APPLE_WALLET_PASS_TYPE_ID,
  CONFIG_KEYS.APPLE_WALLET_TEAM_ID,
  CONFIG_KEYS.APPLE_WALLET_SIGNING_CERT,
  CONFIG_KEYS.APPLE_WALLET_SIGNING_KEY,
  CONFIG_KEYS.APPLE_WALLET_WWDR_CERT,
];
const GOOGLE_WALLET = [
  CONFIG_KEYS.GOOGLE_WALLET_ISSUER_ID,
  CONFIG_KEYS.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL,
  CONFIG_KEYS.GOOGLE_WALLET_SERVICE_ACCOUNT_KEY,
];
const OWNER_AUTH = [
  CONFIG_KEYS.PAYMENT_PROVIDER,
  CONFIG_KEYS.BUSINESS_EMAIL,
  CONFIG_KEYS.SUPERUSER_CHOICE,
];
const BOOKING_FLOW = [...PUBLIC_NAV, ...PAYMENT, ...EMAIL];

type FrozenGate =
  | { kind: "exact-path"; path: string }
  | { kind: "public-site-off" };

type FrozenSpec = {
  gate?: FrozenGate;
  groups: readonly string[];
  served?: boolean;
  settings: readonly string[];
};

const FROZEN: Record<string, FrozenSpec> = {
  "": {
    gate: { kind: "exact-path", path: "/" },
    groups: publicMessageGroups("public-site"),
    settings: [...PUBLIC_NAV, CONFIG_KEYS.HOMEPAGE_TEXT, CONFIG_KEYS.COUNTRY],
  },
  "address-lookup": {
    groups: ["address-lookup"],
    settings: [
      CONFIG_KEYS.ADDRESS_LOOKUP_PROVIDER,
      CONFIG_KEYS.ADDRESS_LOOKUP_API_KEY,
      ...OWNER_AUTH,
    ],
  },
  admin: {
    groups: [],
    settings: [...SNAPSHOT_KEYS, "db_schema_hash"],
  },
  api: {
    groups: [],
    settings: SNAPSHOT_KEYS,
  },
  attachment: {
    groups: [],
    settings: [],
  },
  calculate: {
    groups: publicMessageGroups("payment", "tickets", "validation"),
    settings: [
      ...BOOKING_FLOW,
      CONFIG_KEYS.EMBED_HOSTS,
      CONFIG_KEYS.ADDRESS_LOOKUP_PROVIDER,
    ],
  },
  caldav: {
    groups: [],
    settings: SNAPSHOT_KEYS,
  },
  checkin: {
    groups: [
      ...ADMIN_SHELL_MESSAGE_GROUPS,
      "attendees",
      "check-in",
      "listing-qr",
      "validation",
    ],
    settings: [
      CONFIG_KEYS.COUNTRY,
      CONFIG_KEYS.ATTENDEE_COLUMN_ORDER,
      ...OWNER_AUTH,
    ],
  },
  contact: {
    gate: { kind: "exact-path", path: "/contact" },
    groups: publicMessageGroups("contact", "public-site", "validation"),
    settings: [...PUBLIC_NAV, CONFIG_KEYS.COUNTRY, ...EMAIL],
  },
  "custom.css": {
    groups: [],
    settings: [CONFIG_KEYS.CUSTOM_CSS],
  },
  demo: {
    groups: [...ADMIN_SHELL_MESSAGE_GROUPS, "login", "settings", "validation"],
    settings: [],
  },
  events: {
    groups: [],
    settings: [],
  },
  feeds: {
    groups: [],
    settings: [CONFIG_KEYS.WEBSITE_TITLE, CONFIG_KEYS.COUNTRY],
  },
  gwallet: {
    groups: publicMessageGroups("tickets"),
    settings: [...GOOGLE_WALLET, CONFIG_KEYS.COUNTRY],
  },
  image: {
    groups: [],
    settings: [],
  },
  instance: {
    groups: [],
    settings: [],
  },
  join: {
    groups: JOIN_MESSAGE_GROUPS,
    settings: [],
  },
  listings: {
    gate: { kind: "exact-path", path: "/listings" },
    groups: publicMessageGroups(
      "attributes",
      "availability",
      "public-site",
      "tickets",
    ),
    settings: [...PUBLIC_NAV, CONFIG_KEYS.COUNTRY],
  },
  news: {
    gate: { kind: "public-site-off" },
    groups: publicMessageGroups("news", "public-site"),
    settings: [...PUBLIC_NAV, CONFIG_KEYS.COUNTRY],
  },
  order: {
    groups: publicMessageGroups(
      "availability",
      "capacity",
      "date-picker",
      "modifiers",
      "order",
      "public-site",
      "tickets",
      "validation",
    ),
    settings: [
      ...PUBLIC_NAV,
      CONFIG_KEYS.ORDER_INTRO_TEXT,
      CONFIG_KEYS.COUNTRY,
    ],
  },
  "order.js": {
    groups: [],
    settings: [
      CONFIG_KEYS.EXTERNAL_ORDER_ENABLED,
      CONFIG_KEYS.EMBED_HOSTS,
      CONFIG_KEYS.COUNTRY,
    ],
  },
  page: {
    gate: { kind: "public-site-off" },
    groups: publicMessageGroups("public-site", "site-pages"),
    settings: [...PUBLIC_NAV, CONFIG_KEYS.COUNTRY],
  },
  pay: {
    groups: publicMessageGroups("ledger", "payment", "tickets", "validation"),
    settings: PAYMENT,
  },
  payment: {
    groups: ["payment", "validation"],
    settings: [...PAYMENT, ...EMAIL],
  },
  "read-only": {
    groups: [],
    settings: [],
  },
  renew: {
    groups: publicMessageGroups(
      "address-lookup",
      "payment",
      "public-site",
      "renewal",
      "tickets",
      "validation",
    ),
    settings: [...BOOKING_FLOW, CONFIG_KEYS.ADDRESS_LOOKUP_PROVIDER],
  },
  setup: {
    groups: [],
    served: false,
    settings: [],
  },
  sms: {
    groups: [],
    settings: [
      CONFIG_KEYS.SMS_GATEWAY_WEBHOOK_SECRET,
      CONFIG_KEYS.SMS_GATEWAY_PASSPHRASE,
    ],
  },
  t: {
    groups: publicMessageGroups("listing-qr", "payment", "tickets"),
    settings: [CONFIG_KEYS.COUNTRY, ...APPLE_WALLET, ...GOOGLE_WALLET],
  },
  terms: {
    gate: { kind: "exact-path", path: "/terms" },
    groups: publicMessageGroups("public-site"),
    settings: PUBLIC_NAV,
  },
  ticket: {
    groups: publicMessageGroups(
      "address-lookup",
      "availability",
      "date-picker",
      "modifiers",
      "order",
      "payment",
      "public-site",
      "questions",
      "tickets",
      "validation",
    ),
    settings: [
      ...BOOKING_FLOW,
      CONFIG_KEYS.EMBED_HOSTS,
      CONFIG_KEYS.ADDRESS_LOOKUP_PROVIDER,
    ],
  },
  unsubscribe: {
    groups: publicMessageGroups("unsubscribe", "validation"),
    settings: [CONFIG_KEYS.WEBSITE_TITLE],
  },
  v1: {
    groups: ["tickets"],
    settings: [...APPLE_WALLET, CONFIG_KEYS.COUNTRY],
  },
  wallet: {
    groups: publicMessageGroups("tickets"),
    settings: [...APPLE_WALLET, CONFIG_KEYS.COUNTRY],
  },
};

const table: Record<string, PrefixSpec> = PREFIX_ROUTES;

/** The pre-routing settings bundle must be byte-identical. */
const assertSettings = (name: string, settings: readonly string[]): void => {
  const path = name === "" ? "/" : `/${name}/x`;
  expect(settingsForPath(path)).toEqual([...INFRA, ...settings]);
};

/** The dispatching route must exist and render the frozen groups. */
const assertRoute = (name: string, groups: readonly string[]) => {
  const route = prefixHandlers[name];
  if (!route) throw new Error(`prefix "${name}" no longer dispatches`);
  expect(route.messageGroups).toEqual(groups);
  return route;
};

/**
 * The gate must keep its presence, plus a probe that answers without
 * loading anything.
 */
const assertGate = async (
  name: string,
  gate: FrozenGate | undefined,
): Promise<void> => {
  const spec = table[name];
  if (!spec) throw new Error(`prefix "${name}" is no longer declared`);
  const route = prefixHandlers[name];
  if (!route) throw new Error(`prefix "${name}" no longer dispatches`);
  const path = name === "" ? "/" : `/${name}`;
  if (gate === undefined) {
    expect(spec.gate).toBeUndefined();
    expect(await route.beforeMessages(path, "GET")).toBeNull();
    return;
  }
  expect(spec.gate).toBeDefined();
  if (gate.kind === "exact-path") {
    expect(await route.beforeMessages("/definitely-other", "GET")).toBe(null);
    return;
  }
  // The method guard answers before the setting is read; the redirect with
  // the public site off is proven by the app router tests.
  expect(await route.beforeMessages(path, "POST")).toBeNull();
};

describe("prefix fold equivalence (settings, groups, gates)", () => {
  test("declares exactly the prefixes that existed before the fold", () => {
    expect(Object.keys(table).sort()).toEqual(Object.keys(FROZEN).sort());
  });

  for (const [name, fact] of Object.entries(FROZEN)) {
    test(`${name === "" ? "(root)" : name} resolves exactly as before the fold`, async () => {
      assertSettings(name, fact.settings);

      if (fact.served === false) {
        const spec = table[name];
        if (!spec) throw new Error(`prefix "${name}" is no longer declared`);
        expect(Object.hasOwn(prefixHandlers, name)).toBe(false);
        return;
      }

      assertRoute(name, fact.groups);
      await assertGate(name, fact.gate);
    });
  }

  test("news and page share one public-site gate", () => {
    const news = table.news;
    const page = table.page;
    if (!news || !page) {
      throw new Error("news or page is no longer declared");
    }
    expect(news.gate).toBe(page.gate);
  });

  test("an undeclared segment still gets the full snapshot", () => {
    expect(settingsForPath("/constructor")).toEqual([
      ...INFRA,
      ...SNAPSHOT_KEYS,
    ]);
  });
});
