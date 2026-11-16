/**
 * A feature that is off is off for the API too: its routes refuse, its body
 * keys refuse, its answer keys are absent, and the documentation page says
 * nothing of it.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import type { AdminFeatureKey } from "#shared/admin-features.ts";
import { expectUnauthorized } from "#test-utils/admin-api-auth.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withEnv } from "#test-utils/env.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { apiRequest, testCookie } from "#test-utils/session.ts";
import { featureSetting } from "#test-utils/settings.ts";

const disabled = (feature: string): string =>
  `The ${feature} feature is disabled. Turn it on in Settings, then try again.`;

/** The keys a listing answer holds only while their feature is on. */
const FEATURE_KEYS = [
  "assign_built_site",
  "attribute_option_ids",
  "initial_site_months",
  "months_per_unit",
  "uses_logistics",
];

/** Which of the feature keys one listing answer holds. */
const featureKeysOf = (listing: Record<string, unknown>): string[] =>
  FEATURE_KEYS.filter((key) => key in listing);

const setFeatures = (...on: AdminFeatureKey[]): void => {
  settings.setForTest(featureSetting(...on));
};

/** A listing create with the given body. */
const postListing = (body: Record<string, unknown>): Promise<Response> =>
  apiRequest("/api/admin/listings", { body, method: "POST" });

/** The docs page as an owner reads it. */
const docsPage = async (): Promise<string> => {
  const response = await handleRequest(
    mockRequest("/admin/api-keys/docs", {
      headers: { cookie: await testCookie() },
    }),
  );
  return response.text();
};

describeWithEnv("Admin API - features that are off", { db: true }, () => {
  afterEach(() => {
    settings.clearTestOverride("enabled_features");
  });

  describe("a resource of a feature", () => {
    const GATED: [
      string,
      string,
      { body?: Record<string, unknown>; method: string },
    ][] = [
      ["attributes", "/api/admin/attributes", { method: "GET" }],
      ["attributes", "/api/admin/attributes/1", { method: "GET" }],
      [
        "attributes",
        "/api/admin/attributes",
        { body: { name: "Difficulty" }, method: "POST" },
      ],
      [
        "attributes",
        "/api/admin/attributes/1/options",
        { body: { text: "Easy" }, method: "POST" },
      ],
      ["questions", "/api/admin/questions", { method: "GET" }],
      ["questions", "/api/admin/questions/1/bookings", { method: "GET" }],
      ["site", "/api/admin/site-pages", { method: "GET" }],
      ["site", "/api/admin/site-pages/home", { method: "GET" }],
    ];

    for (const [feature, path, options] of GATED) {
      test(`${options.method} ${path} answers 403 while ${feature} is off`, async () => {
        setFeatures();

        await assertJson(apiRequest(path, options), 403, (body) => {
          expect(body).toEqual({ error: disabled(feature) });
        });
      });
    }

    test("a refused create stores nothing and does not turn the feature on", async () => {
      setFeatures();
      await apiRequest("/api/admin/attributes", {
        body: { name: "Difficulty" },
        method: "POST",
      });
      setFeatures("attributes");

      await assertJson(apiRequest("/api/admin/attributes"), 200, (body) => {
        expect(body.attributes).toEqual([]);
      });
    });

    test("the routes answer again when the feature is on", async () => {
      setFeatures("attributes", "questions", "site");

      await assertJson(apiRequest("/api/admin/attributes"), 200);
      await assertJson(apiRequest("/api/admin/questions"), 200);
      await assertJson(apiRequest("/api/admin/site-pages"), 200);
    });

    test("a caller with no key is refused as unauthorized first", async () => {
      setFeatures();

      await expectUnauthorized("/api/admin/attributes");
    });

    test("a resource of no feature answers on a bare site", async () => {
      setFeatures();

      await assertJson(apiRequest("/api/admin/holidays"), 200);
      await assertJson(apiRequest("/api/admin/groups"), 200);
    });
  });

  describe("a listing write", () => {
    test("refuses attribute options while attributes are off", async () => {
      setFeatures();

      await assertJson(
        postListing({
          attribute_option_ids: [],
          max_attendees: 5,
          name: "Walk",
        }),
        400,
        (body) => {
          expect(body).toEqual({
            error: "attribute_option_ids needs attributes turned on",
          });
        },
      );
      const listed = await assertJson(apiRequest("/api/admin/listings"), 200);
      expect(listed.listings).toEqual([]);
    });

    test("refuses attribute options on an update while attributes are off", async () => {
      const listing = await createTestListing();
      setFeatures();

      await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}`, {
          body: { attribute_option_ids: [] },
          method: "PUT",
        }),
        400,
        (body) => {
          expect(body.error).toBe(
            "attribute_option_ids needs attributes turned on",
          );
        },
      );
    });

    test("takes attribute options when attributes are on", async () => {
      setFeatures("attributes");

      const body = await assertJson(
        postListing({
          attribute_option_ids: [],
          max_attendees: 5,
          name: "Walk",
        }),
        201,
      );

      expect(body.listing.attribute_option_ids).toEqual([]);
    });
  });

  describe("a listing answer", () => {
    test("leaves out every key of a feature that is off, on each route", async () => {
      using _env = withEnv({ CAN_BUILD_SITES: undefined });
      const listing = await createTestListing();
      setFeatures();
      const one = `/api/admin/listings/${listing.id}`;

      const created = await assertJson(
        postListing({ max_attendees: 5, name: "Walk" }),
        201,
      );
      const listed = await assertJson(apiRequest("/api/admin/listings"), 200);
      const read = await assertJson(apiRequest(one), 200);
      const updated = await assertJson(
        apiRequest(one, { body: { name: "Hill walk" }, method: "PUT" }),
        200,
      );
      const off = await assertJson(
        apiRequest(`${one}/deactivate`, { method: "POST" }),
        200,
      );

      expect(
        [
          created.listing,
          listed.listings[0],
          read.listing,
          updated.listing,
          off.listing,
        ].map(featureKeysOf),
      ).toEqual([[], [], [], [], []]);
      // Every other key stays: the group links are of no feature.
      expect(read.listing.group_ids).toEqual([]);
      expect(off.listing.active).toBe(false);
    });

    test("the list names the site features, so a caller knows which keys it takes", async () => {
      using _env = withEnv({ CAN_BUILD_SITES: undefined });
      setFeatures("logistics");

      const listed = await assertJson(apiRequest("/api/admin/listings"), 200);

      expect(listed.features).toEqual({
        attributes: false,
        builder: false,
        logistics: true,
      });
    });

    test("holds the keys of each feature that is on", async () => {
      using _env = withEnv({ CAN_BUILD_SITES: "true" });
      const listing = await createTestListing();
      setFeatures("attributes", "logistics");

      const read = await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}`),
        200,
      );

      expect(featureKeysOf(read.listing)).toEqual(FEATURE_KEYS);
    });

    test("holds only the keys of the one feature that is on", async () => {
      using _env = withEnv({ CAN_BUILD_SITES: undefined });
      const listing = await createTestListing();
      setFeatures("logistics");

      const read = await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}`),
        200,
      );

      expect(featureKeysOf(read.listing)).toEqual(["uses_logistics"]);
    });
  });

  describe("an attendee answer", () => {
    /** Whether the split-agents key is in the list answer and the create
     *  answer of one listing. */
    const holdsSplitKey = async (): Promise<boolean[]> => {
      const listing = await createTestListing();
      const created = await assertJson(
        apiRequest("/api/admin/attendees", {
          body: {
            email: "jane@example.com",
            lines: [{ listingId: listing.id, quantity: 1 }],
            name: "Jane",
          },
          method: "POST",
        }),
        201,
      );
      const listed = await assertJson(
        apiRequest(`/api/admin/listings/${listing.id}/attendees`),
        200,
      );
      return [created.attendee, listed.attendees[0]].map(
        (attendee) => "split_logistics_agents" in attendee,
      );
    };

    test("leaves out the split-agents key while logistics is off", async () => {
      setFeatures();

      expect(await holdsSplitKey()).toEqual([false, false]);
    });

    test("holds the split-agents key while logistics is on", async () => {
      setFeatures("logistics");

      expect(await holdsSplitKey()).toEqual([true, true]);
    });
  });

  describe("the documentation page", () => {
    const FEATURE_WORDS = [
      "/api/admin/attributes",
      "/api/admin/questions",
      "/api/admin/site-pages",
      "/api/admin/external-sources",
      "attribute_option_ids",
      "assign_built_site",
      "initial_site_months",
      "months_per_unit",
      "uses_logistics",
      "split_logistics_agents",
    ];

    test("says nothing of a feature that is off", async () => {
      using _env = withEnv({ CAN_BUILD_SITES: undefined });
      setFeatures("apiKeys");
      const html = await docsPage();

      expect(FEATURE_WORDS.filter((word) => html.includes(word))).toEqual([]);
      // The rest of the docs stay.
      expect(html).toContain("POST /api/admin/listings");
      expect(html).toContain("<code>closes_at</code>");
    });

    test("documents each feature that is on", async () => {
      using _env = withEnv({ CAN_BUILD_SITES: "true" });
      setFeatures(
        "apiKeys",
        "attributes",
        "externalSources",
        "logistics",
        "questions",
        "site",
      );
      const html = await docsPage();

      expect(FEATURE_WORDS.filter((word) => html.includes(word))).toEqual(
        FEATURE_WORDS,
      );
    });
  });
});
