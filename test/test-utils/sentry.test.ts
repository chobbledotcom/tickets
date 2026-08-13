import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { sentryRequestBody } from "#test-utils/sentry.ts";

describe("sentry test assertions", () => {
  test("reject calls that never reached Sentry", () => {
    expect(() => sentryRequestBody([])).toThrow("Sentry was not called");
  });

  test("read a string envelope body", async () => {
    using fetchStub = stubFetch(new Response());
    await fetch("https://bugs.example.test/api/2/envelope/", {
      body: "string envelope",
      method: "POST",
    });

    expect(sentryRequestBody(fetchStub.calls)).toBe("string envelope");
  });

  test("decode a byte envelope body", async () => {
    using fetchStub = stubFetch(new Response());
    await fetch("https://bugs.example.test/api/2/envelope/", {
      body: new TextEncoder().encode("byte envelope"),
      method: "POST",
    });

    expect(sentryRequestBody(fetchStub.calls)).toBe("byte envelope");
  });
});
