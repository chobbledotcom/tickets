import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { sendEmailOk } from "#shared/email-ok.ts";
import { minimalEmailMessage, testEmailConfig } from "#test-utils/email.ts";
import { useFetchStub } from "#test-utils/mocks.ts";

describe("sendEmailOk", () => {
  const fetch = useFetchStub();

  test("returns true when the provider accepts the send", async () => {
    expect(await sendEmailOk(testEmailConfig, minimalEmailMessage)).toBe(true);
  });

  test("returns false when the provider rejects the send", async () => {
    fetch.restubFetch(() =>
      Promise.resolve(new Response("Forbidden", { status: 403 })),
    );

    const errorSpy = spy(console, "error");
    try {
      expect(await sendEmailOk(testEmailConfig, minimalEmailMessage)).toBe(
        false,
      );
    } finally {
      errorSpy.restore();
    }
  });
});
