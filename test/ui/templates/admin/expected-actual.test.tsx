import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  driftedRowItems,
  type ExpectedActualItem,
  ExpectedActualNotice,
  ExpectedActualTableRow,
} from "#templates/admin/expected-actual.tsx";

const item = (over: Partial<ExpectedActualItem> = {}): ExpectedActualItem => ({
  actual: "4",
  expected: "3",
  label: "Total",
  ...over,
});

test("driftedRowItems keeps only the drifted rows, as expected/actual items", () => {
  const items = driftedRowItems([
    { current: "4", label: "Total", recalculated: "3" },
    { current: "5", label: "Subtotal", recalculated: "5" },
    { current: "0", label: "Tax", recalculated: "1" },
  ]);
  // The matching Subtotal row is dropped; each drifted row maps the stored
  // value to `actual` and the recounted value to `expected`.
  expect(items).toEqual([
    { actual: "4", expected: "3", label: "Total" },
    { actual: "0", expected: "1", label: "Tax" },
  ]);
});

test("driftedRowItems returns an empty list when every row matches", () => {
  expect(
    driftedRowItems([{ current: "2", label: "Total", recalculated: "2" }]),
  ).toEqual([]);
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

  assertStringIncludes(html, 'class="expected-actual-notice"');
  assertStringIncludes(html, 'role="alert"');
  assertStringIncludes(html, 'class="badge-alert"');
  // Default badge label and title come from i18n.
  assertStringIncludes(html, ">Mismatch</span>");
  assertStringIncludes(html, "Stored total mismatch");
  // Summary spells out the first item with the surrounding spacing preserved.
  assertStringIncludes(
    html,
    "<strong>Total</strong>: expected <strong>3</strong>, got <strong>4</strong>.",
  );
  assertStringIncludes(
    html,
    "The stored value does not match the expected value.",
  );
});

test("ExpectedActualNotice omits the extra summary text for a single item", () => {
  const html = ExpectedActualNotice({
    explanation: "explanation",
    items: [item()],
  })!.toString();

  assert(
    !html.includes("more)"),
    "the value should not contain the searched item",
  );
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
  assertStringIncludes(html, "(+2 more)");
  assert(
    !html.includes("(+3 more)"),
    "the value should not contain the searched item",
  );
  assert(
    !html.includes("(+1 more)"),
    "the value should not contain the searched item",
  );
  // Only the first item drives the summary line, so scope the check to the
  // <summary> to make sure a later item can't satisfy it.
  const summary = html.match(/<summary>[\s\S]*?<\/summary>/)?.[0];
  assertStringIncludes(summary ?? "", "<strong>Total</strong>: expected");
  assert(
    summary !== undefined && !summary.includes("<strong>Subtotal</strong>"),
    "the value should not contain the searched item",
  );
  assert(
    summary !== undefined && !summary.includes("<strong>Tax</strong>"),
    "the value should not contain the searched item",
  );
  // The full list renders every item, spacing between the labels and values
  // included.
  expect(html.match(/<li>/g)?.length).toBe(3);
  assertStringIncludes(
    html,
    "<strong>Subtotal</strong>: expected <strong>3</strong>, got <strong>4</strong>",
  );
  assertStringIncludes(
    html,
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

  assertStringIncludes(html, ">Custom badge</span>");
  assertStringIncludes(html, "Custom title");
  assert(
    !html.includes("Mismatch"),
    "the value should not contain the searched item",
  );
  assert(
    !html.includes("Stored total mismatch"),
    "the value should not contain the searched item",
  );
});

test("ExpectedActualNotice keeps empty-string overrides instead of the defaults", () => {
  const html = ExpectedActualNotice({
    badgeLabel: "",
    explanation: "explanation",
    items: [item()],
    title: "",
  })!.toString();

  // `??` keeps the empty strings; `||` would fall back to the i18n defaults.
  // Assert the overrides are rendered as empty elements, not merely omitted.
  assertStringIncludes(html, '<span class="badge-alert"></span>');
  assertStringIncludes(html, "<div><p></p><p>explanation</p>");
  assert(
    !html.includes("Mismatch"),
    "the value should not contain the searched item",
  );
  assert(
    !html.includes("Stored total mismatch"),
    "the value should not contain the searched item",
  );
});

test("ExpectedActualNotice renders the action link only when both parts are set", () => {
  const withLink = ExpectedActualNotice({
    actionHref: "/fix",
    actionLabel: "Fix it",
    explanation: "explanation",
    items: [item()],
  })!.toString();
  assertStringIncludes(withLink, '<a href="/fix">Fix it</a>');

  const hrefOnly = ExpectedActualNotice({
    actionHref: "/fix",
    explanation: "explanation",
    items: [item()],
  })!.toString();
  assert(
    !hrefOnly.includes("<a href="),
    "the value should not contain the searched item",
  );

  const labelOnly = ExpectedActualNotice({
    actionLabel: "Fix it",
    explanation: "explanation",
    items: [item()],
  })!.toString();
  assert(
    !labelOnly.includes("<a href="),
    "the value should not contain the searched item",
  );

  const neither = ExpectedActualNotice({
    explanation: "explanation",
    items: [item()],
  })!.toString();
  assert(
    !neither.includes("<a href="),
    "the value should not contain the searched item",
  );
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

  // Verify the notice is nested inside the same row and cell as the header,
  // not merely present somewhere in the output.
  expect(html).toMatch(
    /^<tr><th>Order total<\/th><td><details class="expected-actual-notice"[\s\S]*<\/details><\/td><\/tr>$/,
  );
});
