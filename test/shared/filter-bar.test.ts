import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { type FilterBarOption, renderFilterBar } from "#shared/filter-bar.ts";

const option = (
  label: string,
  href: string,
  active: boolean,
): FilterBarOption => ({ active, href, label });

describe("renderFilterBar", () => {
  test("renders an active option as bold + underlined text, not a link", () => {
    const html = renderFilterBar("Showing", [option("All", "/all", true)]);
    expect(html).toBe(
      '<div class="table-actions">Showing: <strong><u>All</u></strong></div>',
    );
  });

  test("renders the bare links when the label is null", () => {
    const html = renderFilterBar(null, [option("All", "/all", false)]);
    expect(html).toBe(
      '<div class="table-actions"><a href="/all">All</a></div>',
    );
  });

  test("renders an inactive option as a link to its href", () => {
    const html = renderFilterBar("Showing", [option("All", "/all", false)]);
    expect(html).toBe(
      '<div class="table-actions">Showing: <a href="/all">All</a></div>',
    );
  });

  test("joins multiple options with ' / ' in the given order", () => {
    const html = renderFilterBar("Agent", [
      option("All", "/agent/all", true),
      option("None", "/agent/none", false),
      option("Van 1", "/agent/van-1", false),
    ]);
    expect(html).toBe(
      '<div class="table-actions">Agent: ' +
        "<strong><u>All</u></strong>" +
        ' / <a href="/agent/none">None</a>' +
        ' / <a href="/agent/van-1">Van 1</a>' +
        "</div>",
    );
  });

  test("marks only the active option as bold, linking every other", () => {
    const html = renderFilterBar("Agent", [
      option("All", "/agent/all", false),
      option("Van 1", "/agent/van-1", true),
    ]);
    expect(html).toBe(
      '<div class="table-actions">Agent: ' +
        '<a href="/agent/all">All</a>' +
        " / <strong><u>Van 1</u></strong>" +
        "</div>",
    );
  });

  test("renders the label and an empty body when there are no options", () => {
    const html = renderFilterBar("Showing", []);
    expect(html).toBe('<div class="table-actions">Showing: </div>');
  });

  test("uses the supplied label verbatim in the heading", () => {
    const html = renderFilterBar("Filter by status", [
      option("Open", "/s/open", true),
    ]);
    expect(html).toBe(
      '<div class="table-actions">Filter by status: <strong><u>Open</u></strong></div>',
    );
  });

  test("emits labels verbatim — callers pre-escape user-supplied text", () => {
    // The contract (see module header) is that labels are not escaped here, so
    // an already-escaped agent name round-trips unchanged rather than being
    // double-escaped.
    const escaped = "Tom &amp; Jerry&#39;s Van";
    const html = renderFilterBar("Agent", [option(escaped, "/a/1", false)]);
    expect(html).toBe(
      `<div class="table-actions">Agent: <a href="/a/1">${escaped}</a></div>`,
    );
  });

  test("keeps two adjacent active options separated by ' / '", () => {
    // Two active options in a row would run together if the separator were
    // dropped; asserts the join survives even without an intervening link.
    const html = renderFilterBar("X", [
      option("A", "/a", true),
      option("B", "/b", true),
    ]);
    expect(html).toBe(
      '<div class="table-actions">X: ' +
        "<strong><u>A</u></strong>" +
        " / <strong><u>B</u></strong>" +
        "</div>",
    );
  });
});
