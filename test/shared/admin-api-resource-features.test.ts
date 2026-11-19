import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { resourceFeature } from "#shared/admin-api-resource-features.ts";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";

describe("resource features", () => {
  test("each resource belongs to its feature, or to none", () => {
    const features = Object.fromEntries(
      Object.values(ADMIN_API_RESOURCES).map((entry) => [
        entry.path,
        resourceFeature(entry.path),
      ]),
    );

    expect(features).toEqual({
      "attendee-statuses": undefined,
      attendees: undefined,
      attributes: "attributes",
      "external-sources": "externalSources",
      groups: undefined,
      holidays: undefined,
      images: undefined,
      listings: undefined,
      questions: "questions",
      "site-pages": "site",
    });
  });
});
