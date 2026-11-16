/**
 * The docs as one viewer of one site sees them. A feature that is off, or a
 * key the viewer cannot set, is absent. Everything else is as the whole docs
 * show it.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type {
  DocsView,
  EndpointDoc,
} from "#shared/admin-api-example/endpoint-doc.ts";
import { adminApiEndpoints } from "#shared/admin-api-example.ts";
import type { AdminFeatureKey } from "#shared/admin-features.ts";
import type { WriteAccess } from "#shared/rest/field-specs.ts";
import {
  ADMIN_API_ENDPOINTS,
  documentedRoutes,
  everyFeature,
  jsonLeaves,
  OPEN_ACCESS,
  OPEN_VIEW,
} from "./helpers.ts";

/** The docs of a site with the given changes to the open view. */
const docsWith = (changes: {
  features?: Partial<WriteAccess["features"]>;
  locks?: Partial<WriteAccess["locks"]>;
  off?: AdminFeatureKey[];
}): EndpointDoc[] => {
  const view: DocsView = {
    access: {
      features: { ...OPEN_ACCESS.features, ...changes.features },
      locks: { ...OPEN_ACCESS.locks, ...changes.locks },
    },
    features: {
      ...everyFeature(true),
      ...Object.fromEntries((changes.off ?? []).map((key) => [key, false])),
    },
  };
  return adminApiEndpoints(view);
};

const BUILDER_KEYS = [
  "assign_built_site",
  "initial_site_months",
  "months_per_unit",
];

/** Every key that any body of the docs holds, at any depth. */
const keysIn = (
  docs: EndpointDoc[],
  part: "request" | "response",
): Set<string> =>
  new Set(
    docs.flatMap((endpoint) => {
      const body = endpoint[part];
      return body === undefined
        ? []
        : jsonLeaves(JSON.parse(body), "body").flatMap((leaf) =>
            leaf.where
              .split(/[.[\]]/)
              .filter((piece) => /^[a-z_]+$/.test(piece)),
          );
    }),
  );

/** Every key the field tables of the docs name. */
const fieldKeysIn = (docs: EndpointDoc[]): Set<string> =>
  new Set(
    docs.flatMap((endpoint) => (endpoint.fields ?? []).map((row) => row.key)),
  );

/** Which of the keys the docs show anywhere: a table, a request, an answer. */
const shownAnywhere = (docs: EndpointDoc[], keys: string[]): string[] => {
  const shown = new Set([
    ...fieldKeysIn(docs),
    ...keysIn(docs, "request"),
    ...keysIn(docs, "response"),
  ]);
  return keys.filter((key) => shown.has(key));
};

const routesUnder = (docs: EndpointDoc[], path: string): string[] =>
  documentedRoutes(docs).filter((route) => route.includes(path));

describe("the docs one viewer sees", () => {
  test("the open view shows each feature key somewhere", () => {
    expect(
      shownAnywhere(ADMIN_API_ENDPOINTS, [
        ...BUILDER_KEYS,
        "uses_logistics",
        "split_logistics_agents",
        "attribute_option_ids",
      ]),
    ).toEqual([
      ...BUILDER_KEYS,
      "uses_logistics",
      "split_logistics_agents",
      "attribute_option_ids",
    ]);
  });

  test("site building off shows no site building key in a table, a request, or an answer", () => {
    const docs = docsWith({ features: { builder: false } });

    expect(shownAnywhere(docs, BUILDER_KEYS)).toEqual([]);
    expect(shownAnywhere(docs, ["uses_logistics", "closes_at"])).toEqual([
      "uses_logistics",
      "closes_at",
    ]);
  });

  test("logistics off shows no logistics key, on a listing or on an attendee", () => {
    const docs = docsWith({ features: { logistics: false } });

    expect(
      shownAnywhere(docs, ["uses_logistics", "split_logistics_agents"]),
    ).toEqual([]);
    expect(shownAnywhere(docs, BUILDER_KEYS)).toEqual(BUILDER_KEYS);
  });

  test("attributes off shows no attribute options key and no attribute route", () => {
    const docs = docsWith({
      features: { attributes: false },
      off: ["attributes"],
    });

    expect(shownAnywhere(docs, ["attribute_option_ids"])).toEqual([]);
    expect(routesUnder(docs, "/api/admin/attributes")).toEqual([]);
    expect(routesUnder(docs, "/api/admin/listings")).toEqual(
      routesUnder(ADMIN_API_ENDPOINTS, "/api/admin/listings"),
    );
  });

  test("each resource of a feature leaves the docs with its feature, and no other does", () => {
    const routesWithout = (key: AdminFeatureKey) =>
      documentedRoutes(docsWith({ off: [key] }));
    const without = (path: string) =>
      documentedRoutes(ADMIN_API_ENDPOINTS).filter(
        (route) => !route.includes(path),
      );

    expect(routesWithout("questions")).toEqual(without("/api/admin/questions"));
    expect(routesWithout("site")).toEqual(without("/api/admin/site-pages"));
    expect(routesWithout("externalSources")).toEqual(
      without("/api/admin/external-sources"),
    );
    expect(routesWithout("money")).toEqual(
      documentedRoutes(ADMIN_API_ENDPOINTS),
    );
  });

  test("a key the demo locks leaves the table and the requests, and stays in the answers", () => {
    const docs = docsWith({ locks: { demo: true } });

    expect(fieldKeysIn(docs).has("webhook_url")).toBe(false);
    expect(keysIn(docs, "request").has("webhook_url")).toBe(false);
    expect(keysIn(docs, "response").has("webhook_url")).toBe(true);
    expect(fieldKeysIn(ADMIN_API_ENDPOINTS).has("webhook_url")).toBe(true);
  });

  test("every key of a request example has a row in its table, in every view", () => {
    const views = [
      docsWith({}),
      docsWith({
        features: { attributes: false, builder: false, logistics: false },
      }),
      docsWith({ locks: { demo: true, editor: true, nonOwner: true } }),
    ];
    const strays = views.flatMap((docs) =>
      docs.flatMap((endpoint) => {
        if (endpoint.fields === undefined || endpoint.request === undefined) {
          return [];
        }
        const rows = new Set(endpoint.fields.map((row) => row.key));
        return Object.keys(JSON.parse(endpoint.request))
          .filter((key) => !rows.has(key))
          .map((key) => `${endpoint.method} ${endpoint.path} ${key}`);
      }),
    );

    expect(strays).toEqual([]);
  });

  test("the open view is the whole docs", () => {
    expect(adminApiEndpoints(OPEN_VIEW)).toEqual(ADMIN_API_ENDPOINTS);
    expect(docsWith({})).toEqual(ADMIN_API_ENDPOINTS);
  });
});
