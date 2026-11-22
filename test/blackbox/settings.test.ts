import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { redirectOf } from "#test/blackbox/settings.ts";

const answer = (location: string | null) => ({
  headers: new Headers(),
  html: "",
  location,
  status: 302,
});

test("a save redirect gives the address that it names", () => {
  expect(redirectOf(answer("/admin/settings"))).toBe("/admin/settings");
});

test("a save redirect that names no address fails loudly", () => {
  expect(() => redirectOf(answer(null))).toThrow("The save named no address.");
});
