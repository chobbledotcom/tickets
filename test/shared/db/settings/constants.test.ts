/** Direct tests for db/settings/constants.ts — the email-template cap and
 *  the Stripe/SumUp secret-prefix classifier. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  keyModeOf,
  MAX_EMAIL_TEMPLATE_LENGTH,
} from "#db/settings/constants.ts";

describe("MAX_EMAIL_TEMPLATE_LENGTH", () => {
  test("allows a 50 KB template body", () => {
    expect(MAX_EMAIL_TEMPLATE_LENGTH).toBe(51_200);
  });
});

describe("keyModeOf", () => {
  test("classifies a Stripe or SumUp test secret", () => {
    expect(keyModeOf("sk_test_51JsZxk")).toBe("test");
  });

  test("classifies a Stripe or SumUp live secret", () => {
    expect(keyModeOf("sk_live_51JsZxk")).toBe("live");
  });

  test("returns null for a key without a known prefix", () => {
    expect(keyModeOf("pk_live_51JsZxk")).toBeNull();
  });

  test("returns null for an empty key", () => {
    expect(keyModeOf("")).toBeNull();
  });

  test("requires the whole prefix, not just its letters", () => {
    expect(keyModeOf("sk_testimonial_x")).toBeNull();
    expect(keyModeOf("sk_livestream_x")).toBeNull();
  });
});
