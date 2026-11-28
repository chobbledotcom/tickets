import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  ADMIN_API_RESOURCES,
  type AdminApiResource,
} from "#shared/admin-api-resources.ts";

describe("resource features", () => {
  test("each resource carries its feature, or none", () => {
    const entries: readonly AdminApiResource[] =
      Object.values(ADMIN_API_RESOURCES);
    const features = Object.fromEntries(
      entries.map((entry) => [entry.path, entry.feature]),
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
      redirects: undefined,
      "site-pages": "site",
    });
  });
});
