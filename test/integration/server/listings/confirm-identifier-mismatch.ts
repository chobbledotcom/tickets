import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  expectFlash,
  followRedirectWithFlash,
} from "#test-utils/assertions.ts";
import { adminFormPost, setupListingAndLogin } from "#test-utils/session.ts";

/**
 * Shared behavior between the deactivate and reactivate confirmation forms: a
 * `confirm_identifier` that doesn't match the listing's name redirects back
 * with an error flash, and the redirected confirmation page still shows that
 * error. Colocated here rather than duplicated across deactivate.test.ts and
 * reactivate.test.ts, whose only real differences are the route, the mismatch
 * test's name/flash message, and reactivate needing the listing deactivated
 * first.
 */
export const testConfirmIdentifierMismatch = (
  path: string,
  mismatchTestName: string,
  expectedFlashMessage: string,
  setupExtra: (listingId: number) => Promise<void> = async () => {},
): void => {
  test(mismatchTestName, async () => {
    const { listing } = await setupListingAndLogin({
      maxAttendees: 100,
      name: "Test Listing",
      thankYouUrl: "https://example.com",
    });
    await setupExtra(listing.id);

    const { response } = await adminFormPost(path, {
      confirm_identifier: "wrong-identifier",
    });
    expect(response.status).toBe(302);
    expectFlash(response, expect.stringContaining(expectedFlashMessage), false);
  });

  test("displays error on confirmation page after failed attempt", async () => {
    const { listing } = await setupListingAndLogin({
      maxAttendees: 100,
      name: "Test Listing",
      thankYouUrl: "https://example.com",
    });
    await setupExtra(listing.id);

    const { cookie, response: postResponse } = await adminFormPost(path, {
      confirm_identifier: "wrong",
    });
    const page = await followRedirectWithFlash(
      postResponse,
      handleRequest,
      cookie,
    );
    const html = await page.text();
    expect(html).toContain("does not match");
  });
};
