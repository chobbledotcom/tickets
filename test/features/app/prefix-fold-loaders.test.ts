/**
 * The paired fold test for the prefix declaration (issue #2268), part 2:
 * loaders.
 *
 * The loader facts are frozen from PREFIX_LOADERS and the static handler
 * entries in src/features/app/routes.ts as they stood at main 1a46674ff. For
 * every prefix the folded loader must keep its kind, the module exports it
 * picks, and the patterns it binds; the dynamic import targets must stay the
 * same modules; and the static handler guards must still answer before
 * loading anything. The settings, group, and gate facts live in
 * prefix-fold.test.ts.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { PREFIX_ROUTES, type PrefixSpec } from "#routes/app/prefixes.ts";
import { prefixHandlers } from "#routes/app/routes.ts";

/** One loader fact per prefix, frozen from the pre-fold tables. `setup` has
 * none: the setup router serves it before main dispatch. The name fields are
 * the frozen dispatch contract; the module load and inline handler live in
 * production code only. */
type FrozenLoader =
  | { kind: "handler"; pick: string }
  | { kind: "inline" }
  | { kind: "route-table"; routes: Readonly<Record<string, string>> }
  | { kind: "routes-object"; pick: string };

const FROZEN_LOADERS: Record<string, FrozenLoader | undefined> = {
  "": { kind: "route-table", routes: { "GET /": "handleHome" } },
  "address-lookup": {
    kind: "route-table",
    routes: { "GET /address-lookup": "handleAddressLookupGet" },
  },
  admin: { kind: "handler", pick: "routeAdmin" },
  api: { kind: "inline" },
  attachment: { kind: "routes-object", pick: "attachmentRoutes" },
  calculate: { kind: "handler", pick: "routeTicket" },
  caldav: { kind: "handler", pick: "routeFeed" },
  checkin: { kind: "handler", pick: "routeCheckin" },
  contact: { kind: "inline" },
  "custom.css": { kind: "inline" },
  demo: { kind: "handler", pick: "routeDatabaseReset" },
  events: { kind: "inline" },
  feeds: { kind: "handler", pick: "routeFeed" },
  gwallet: { kind: "handler", pick: "routeGoogleWallet" },
  image: { kind: "handler", pick: "routeImage" },
  instance: { kind: "routes-object", pick: "instanceRoutes" },
  join: { kind: "handler", pick: "routeJoin" },
  listings: {
    kind: "route-table",
    routes: { "GET /listings": "handlePublicListings" },
  },
  news: { kind: "handler", pick: "routeNews" },
  order: { kind: "handler", pick: "routeOrder" },
  "order.js": { kind: "inline" },
  page: { kind: "handler", pick: "routeSitePage" },
  pay: { kind: "handler", pick: "routeBalance" },
  payment: { kind: "handler", pick: "routePayment" },
  "read-only": { kind: "inline" },
  renew: {
    kind: "route-table",
    routes: {
      "GET /renew": "handleRenewalGet",
      "POST /renew": "handleRenewalPost",
    },
  },
  setup: undefined,
  sms: { kind: "handler", pick: "routeSmsWebhook" },
  t: { kind: "handler", pick: "routeTicketView" },
  terms: {
    kind: "route-table",
    routes: { "GET /terms": "handlePublicTerms" },
  },
  ticket: { kind: "handler", pick: "routeTicket" },
  unsubscribe: {
    kind: "route-table",
    routes: {
      "GET /unsubscribe": "handleUnsubscribeGet",
      "POST /unsubscribe": "handleUnsubscribePost",
    },
  },
  v1: { kind: "handler", pick: "routeWalletWebservice" },
  wallet: { kind: "handler", pick: "routeWallet" },
};

/** Dynamic import targets, frozen from the pre-fold routes.ts. */
const FROZEN_SPECIFIERS = [
  "#routes/admin/api-mount.ts",
  "#routes/admin/api.ts",
  "#routes/admin/database-reset.ts",
  "#routes/admin/index.ts",
  "#routes/api/index.ts",
  "#routes/api/sms-webhook.ts",
  "#routes/api/webhooks.ts",
  "#routes/attachments.ts",
  "#routes/checkin.ts",
  "#routes/feeds.ts",
  "#routes/images.ts",
  "#routes/instance.ts",
  "#routes/join.ts",
  "#routes/public/address-lookup.ts",
  "#routes/public/balance.ts",
  "#routes/public/custom-css.ts",
  "#routes/public/news.ts",
  "#routes/public/order-js.ts",
  "#routes/public/order.ts",
  "#routes/public/pages.ts",
  "#routes/public/renewal.ts",
  "#routes/public/site-page.ts",
  "#routes/public/ticket-routes.ts",
  "#routes/public/unsubscribe.ts",
  "#routes/tickets/index.ts",
  "#routes/wallet/google.ts",
  "#routes/wallet/index.ts",
  "#routes/wallet/webservice.ts",
];

/**
 * The loader must keep its kind, module exports, and bound patterns. The
 * declaration's loader data carries the module load too; the frozen facts
 * name the dispatch contract, and the import-target test pins the modules.
 */
const assertLoader = (name: string, loader: FrozenLoader | undefined): void => {
  const table: Record<string, PrefixSpec> = PREFIX_ROUTES;
  const spec = table[name];
  if (!spec) throw new Error(`prefix "${name}" is no longer declared`);
  const declared = spec.loader;
  if (declared === undefined) {
    expect(loader).toBeUndefined();
    return;
  }
  if (declared.kind === "inline") {
    // The inline handler's behavior is pinned by the guard probes here and
    // by the app router's dispatch tests.
    expect(loader?.kind).toBe("inline");
    return;
  }
  const named =
    declared.kind === "route-table"
      ? { kind: declared.kind, routes: declared.routes }
      : { kind: declared.kind, pick: declared.pick };
  expect(named).toEqual(loader);
};

describe("prefix fold equivalence (loaders)", () => {
  for (const [name, loader] of Object.entries(FROZEN_LOADERS)) {
    test(`${name === "" ? "(root)" : name} loads what it loaded before the fold`, () => {
      assertLoader(name, loader);
    });
  }

  test("every loader loads the module it loaded before the fold", async () => {
    const sources = await Promise.all([
      Deno.readTextFile("src/features/app/prefixes.ts"),
      Deno.readTextFile("src/features/app/prefix-loaders.ts"),
    ]);
    const specifiers = [...sources.join("\n").matchAll(/import\("([^"]+)"\)/g)]
      .map((match) => match[1])
      .sort();
    expect(specifiers).toEqual(FROZEN_SPECIFIERS);
  });

  test("static handler guards answer before loading anything", async () => {
    for (const name of [
      "contact",
      "custom.css",
      "events",
      "order.js",
      "read-only",
    ]) {
      const route = prefixHandlers[name];
      if (!route) throw new Error(`prefix "${name}" no longer dispatches`);
      const response = await route.handler(
        new Request("https://site.test/probe"),
        "/definitely-not",
        "GET",
      );
      expect(response, `${name} answered for a path it does not own`).toBe(
        null,
      );
    }
  });
});
