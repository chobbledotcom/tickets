import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { ExpectedActualNotice } from "#templates/admin/expected-actual.tsx";

test("ExpectedActualNotice uses the default title when none is provided", () => {
  const html = ExpectedActualNotice({
    explanation: "The stored value does not match the expected value.",
    items: [{ actual: "4", expected: "3", label: "Total" }],
  })!.toString();

  expect(html).toContain("Stored total error");
  expect(html).toContain("expected <strong>3</strong>, got");
  expect(html).toContain("Click for info.");
});
