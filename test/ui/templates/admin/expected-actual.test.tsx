import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  type ExpectedActualItem,
  ExpectedActualNotice,
  ExpectedActualTableRow,
  hasExpectedActualMismatches,
} from "#templates/admin/expected-actual.tsx";

const item = (over: Partial<ExpectedActualItem> = {}): ExpectedActualItem => ({
  actual: "4",
  expected: "3",
  label: "Total",
  ...over,
});

test("hasExpectedActualMismatches is false only for an empty list", () => {
  expect(hasExpectedActualMismatches([])).toBe(false);
  expect(hasExpectedActualMismatches([item()])).toBe(true);
  expect(hasExpectedActualMismatches([item(), item()])).toBe(true);
});

test("ExpectedActualNotice returns null when there are no items", () => {
  expect(ExpectedActualNotice({ explanation: "explanation", items: [] })).toBe(
    null,
  );
});

test("ExpectedActualNotice renders the wrapper, badge and first item", () => {
  const html = ExpectedActualNotice({
    explanation: "The stored value does not match the expected value.",
    items: [item({ actual: "4", expected: "3", label: "Total" })],
  })!.toString();

  expect(html).toContain('class="expected-actual-notice"');
  expect(html).toContain('role="alert"');
  expect(html).toContain('class="badge-alert"');
  // Default badge label and title come from i18n.
  expect(html).toContain(">Mismatch</span>");
  expect(html).toContain("Stored total mismatch");
  // Summary spells out the first item with the surrounding spacing preserved.
  expect(html).toContain(
    "<strong>Total</strong>: expected <strong>3</strong>, got <strong>4</strong>.",
  );
  expect(html).toContain("The stored value does not match the expected value.");
});

test("ExpectedActualNotice omits the extra summary text for a single item", () => {
  const html = ExpectedActualNotice({
    explanation: "explanation",
    items: [item()],
  })!.toString();

  expect(html).not.toContain("more)");
  // Single item: exactly one list entry.
  expect(html.match(/<li>/g)?.length).toBe(1);
});

test("ExpectedActualNotice appends the pluralised extra count for many items", () => {
  const html = ExpectedActualNotice({
    explanation: "explanation",
    items: [
      item({ label: "Total" }),
      item({ label: "Subtotal" }),
      item({ label: "Tax" }),
    ],
  })!.toString();

  // count = items.length - 1 = 2 → "(+2 more)".
  expect(html).toContain("(+2 more)");
  expect(html).not.toContain("(+3 more)");
  expect(html).not.toContain("(+1 more)");
  // Only the first item drives the summary line.
  expect(html).toContain("<strong>Total</strong>: expected");
  // The full list renders every item, spacing between the labels and values
  // included.
  expect(html.match(/<li>/g)?.length).toBe(3);
  expect(html).toContain(
    "<strong>Subtotal</strong>: expected <strong>3</strong>, got <strong>4</strong>",
  );
  expect(html).toContain(
    "<strong>Tax</strong>: expected <strong>3</strong>, got <strong>4</strong>",
  );
});

test("ExpectedActualNotice honours explicit badge and title overrides", () => {
  const html = ExpectedActualNotice({
    badgeLabel: "Custom badge",
    explanation: "explanation",
    items: [item()],
    title: "Custom title",
  })!.toString();

  expect(html).toContain(">Custom badge</span>");
  expect(html).toContain("Custom title");
  expect(html).not.toContain("Mismatch");
  expect(html).not.toContain("Stored total mismatch");
});

test("ExpectedActualNotice keeps empty-string overrides instead of the defaults", () => {
  const html = ExpectedActualNotice({
    badgeLabel: "",
    explanation: "explanation",
    items: [item()],
    title: "",
  })!.toString();

  // `??` keeps the empty strings; `||` would fall back to the i18n defaults.
  expect(html).not.toContain("Mismatch");
  expect(html).not.toContain("Stored total mismatch");
});

test("ExpectedActualNotice renders the action link only when both parts are set", () => {
  const withLink = ExpectedActualNotice({
    actionHref: "/fix",
    actionLabel: "Fix it",
    explanation: "explanation",
    items: [item()],
  })!.toString();
  expect(withLink).toContain('<a href="/fix">Fix it</a>');

  const hrefOnly = ExpectedActualNotice({
    actionHref: "/fix",
    explanation: "explanation",
    items: [item()],
  })!.toString();
  expect(hrefOnly).not.toContain("<a href=");

  const labelOnly = ExpectedActualNotice({
    actionLabel: "Fix it",
    explanation: "explanation",
    items: [item()],
  })!.toString();
  expect(labelOnly).not.toContain("<a href=");

  const neither = ExpectedActualNotice({
    explanation: "explanation",
    items: [item()],
  })!.toString();
  expect(neither).not.toContain("<a href=");
});

test("ExpectedActualTableRow returns null when there are no mismatches", () => {
  expect(
    ExpectedActualTableRow({
      header: "Header",
      notice: { explanation: "explanation", items: [] },
    }),
  ).toBe(null);
});

test("ExpectedActualTableRow wraps the notice in a table row when there are mismatches", () => {
  const html = ExpectedActualTableRow({
    header: "Order total",
    notice: { explanation: "explanation", items: [item()] },
  })!.toString();

  expect(html).toContain("<tr>");
  expect(html).toContain("<th>Order total</th>");
  expect(html).toContain("<td>");
  expect(html).toContain('class="expected-actual-notice"');
});
