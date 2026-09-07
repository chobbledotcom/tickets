import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  applyHiddenNoindex,
  applyNoindex,
  parseSlugs,
  REGISTRATION_CLOSED_SUBMIT_MESSAGE,
} from "#routes/public/types.ts";

describe("public ticket route helpers", () => {
  test("reads one or more listing slugs", () => {
    expect(parseSlugs("a+")).toEqual(["a"]);
    expect(parseSlugs("first")).toEqual(["first"]);
    expect(parseSlugs("first+second+")).toEqual(["first", "second"]);
  });

  test("keeps the closed-registration message", () => {
    expect(REGISTRATION_CLOSED_SUBMIT_MESSAGE).toBe(
      "Sorry, registration closed while you were submitting.",
    );
  });

  test("marks a response for the robots middleware", () => {
    const response = new Response();

    expect(applyNoindex(response)).toBe(response);
    expect(response.headers.get("x-robots-noindex")).toBe("true");
  });

  test("marks only a hidden page", () => {
    const visibleResponse = new Response();
    const hiddenResponse = new Response();

    expect(applyHiddenNoindex(visibleResponse, false)).toBe(visibleResponse);
    expect(visibleResponse.headers.has("x-robots-noindex")).toBe(false);
    expect(applyHiddenNoindex(hiddenResponse, true)).toBe(hiddenResponse);
    expect(hiddenResponse.headers.get("x-robots-noindex")).toBe("true");
  });
});
