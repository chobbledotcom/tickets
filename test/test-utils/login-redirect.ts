import { expect } from "@std/expect";
import { expectRedirect } from "#test-utils/assertions.ts";

/** The parsed redirect target of a 302 response, as an address on the test
 *  site. An off-site Location fails here, so no caller can assert against a
 *  redirect that leaves the site. */
export const landedAt = (response: Response): URL => {
  const target = new URL(expectRedirect(response), "http://localhost");
  expect(target.origin).toBe("http://localhost");
  return target;
};

/** Assert a 302 to the login flow that carries `returnPath` — the page the
 *  visitor asked for, which a successful login returns to. */
export const expectLoginRedirectWithReturn =
  (returnPath: string) =>
  (response: Response): void => {
    const landed = landedAt(response);
    expect(landed.pathname).toBe("/admin");
    expect(landed.searchParams.get("return_url")).toBe(returnPath);
  };
