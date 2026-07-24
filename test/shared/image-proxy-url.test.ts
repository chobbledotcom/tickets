import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getImageProxyUrl } from "#shared/image-proxy-url.ts";

test("builds the route for an encrypted image", () => {
  expect(getImageProxyUrl("abc123.jpg")).toBe("/image/abc123.jpg");
});
