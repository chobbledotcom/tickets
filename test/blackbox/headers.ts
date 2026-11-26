/**
 * Header checks the black-box tests share.
 */

import { expect } from "@std/expect";

/** A JSON answer that no browser keeps and that the site's policy covers. */
export const expectPrivateJson = (headers: Headers): void => {
  expect({
    cache: headers.get("cache-control"),
    policy: headers
      .get("content-security-policy")
      ?.includes("default-src 'self'"),
    type: headers.get("content-type"),
  }).toEqual({
    cache: "private, no-store",
    policy: true,
    type: "application/json; charset=utf-8",
  });
};
