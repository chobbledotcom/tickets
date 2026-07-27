import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  adminBulkActionsPage,
  adminDeactivateGroupPage,
  adminDuplicateGroupPage,
  adminReactivateGroupPage,
} from "#templates/admin/bulk-actions.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { testGroup, testListingWithCount } from "#test-utils/factories.ts";
import { useSetting } from "#test-utils/settings.ts";

const GROUP = testGroup({ id: 17, name: "Summer <Crew>" });
const ACTIVE = testListingWithCount({ active: true, id: 4 });
const INACTIVE = testListingWithCount({ active: false, id: 5 });

const embeddedListingsJson = (html: string): string => {
  const match = html.match(
    /<script id="duplicate-preview-listings" type="application\/json">([\s\S]*?)<\/script>/,
  );
  const json = match?.[1];
  if (json === undefined) {
    throw new Error("Duplicate preview JSON script was not rendered");
  }
  return json;
};

describe("admin bulk action templates", () => {
  beforeAll(setupAdminPageTest);
  useSetting({ timezone: "UTC" });

  test("offers deactivation when the group has an active listing", () => {
    const html = adminBulkActionsPage(GROUP, [ACTIVE, INACTIVE], OWNER_SESSION);

    expect(html).toContain('href="/admin/groups/17/bulk-actions/duplicate"');
    expect(html).toContain('href="/admin/groups/17/bulk-actions/deactivate"');
    expect(html).not.toContain(
      'href="/admin/groups/17/bulk-actions/reactivate"',
    );
    expect(html).toContain(
      "2 listings in <strong>Summer &lt;Crew&gt;</strong>.",
    );
  });

  test("offers reactivation only when every listing is inactive", () => {
    const html = adminBulkActionsPage(GROUP, [INACTIVE], OWNER_SESSION);

    expect(html).toContain('href="/admin/groups/17/bulk-actions/reactivate"');
    expect(html).not.toContain(
      'href="/admin/groups/17/bulk-actions/deactivate"',
    );
  });

  test("offers neither activation change for an empty group", () => {
    const html = adminBulkActionsPage(GROUP, [], OWNER_SESSION);

    expect(html).toContain('href="/admin/groups/17/bulk-actions/duplicate"');
    expect(html).not.toContain("/bulk-actions/deactivate");
    expect(html).not.toContain("/bulk-actions/reactivate");
    expect(html).toContain(
      "0 listings in <strong>Summer &lt;Crew&gt;</strong>.",
    );
  });

  test("renders the duplicate form and its initial preview", () => {
    const listing = testListingWithCount({
      date: "2026-08-03T14:30:00.000Z",
      id: 9,
      name: "Afternoon session",
    });
    const html = adminDuplicateGroupPage(
      GROUP,
      [listing],
      OWNER_SESSION,
      "Try again.",
    );

    expect(html).toContain("Try again.");
    expect(html).toContain('action="/admin/groups/17/bulk-actions/duplicate"');
    expect(html).toContain('data-duplicate-preview data-timezone="UTC"');
    expect(html).toMatch(
      /<input(?=[^>]*name="new_name")(?=[^>]*required)(?=[^>]*value="Summer &lt;Crew&gt; \(copy\)")[^>]*>/,
    );
    for (const name of [
      "name_find",
      "name_replace",
      "date_find",
      "date_replace",
    ]) {
      expect(html).toContain(`name="${name}"`);
    }
    expect(html).toContain('<tbody data-duplicate-preview-rows="">');
    expect(html).toContain('<tr data-listing-id="9">');
    expect(html).toContain("Afternoon session");
    expect(html).toContain("2026-08-03 14:30");
  });

  test("neutralises closing tags in embedded listing JSON without changing its data", () => {
    const dangerousName = '</script><script>alert("owned")</script>&';
    const listing = testListingWithCount({
      date: "2026-08-03T14:30:00.000Z",
      id: 9,
      name: dangerousName,
    });
    const html = adminDuplicateGroupPage(GROUP, [listing], OWNER_SESSION);
    const json = embeddedListingsJson(html);

    expect(json).toBe(
      '[{"date":"2026-08-03T14:30:00.000Z","id":9,"name":"\\u003c/script>\\u003cscript>alert(\\"owned\\")\\u003c/script>&"}]',
    );
    expect(JSON.parse(json)).toEqual([
      { date: listing.date, id: listing.id, name: dangerousName },
    ]);
    expect(html).not.toContain('</script><script>alert("owned")');
    expect(html).toContain(
      "&lt;/script&gt;&lt;script&gt;alert(&quot;owned&quot;)&lt;/script&gt;&amp;",
    );
  });

  test("renders the duplicate empty state with an empty JSON payload", () => {
    const html = adminDuplicateGroupPage(GROUP, [], OWNER_SESSION);

    expect(html).toContain("This group has no listings");
    expect(html).not.toContain("data-duplicate-preview-rows");
    expect(embeddedListingsJson(html)).toBe("[]");
  });

  test("renders the deactivate confirmation for active listings as dangerous", () => {
    const html = adminDeactivateGroupPage(
      GROUP,
      [ACTIVE, INACTIVE],
      OWNER_SESSION,
      "Name did not match.",
    );

    expect(html).toContain("Name did not match.");
    expect(html).toContain('action="/admin/groups/17/bulk-actions/deactivate"');
    expect(html).toContain("1 active listing");
    expect(html).toContain("Warning:");
    expect(html).toContain('<button class="danger" type="submit">');
    expect(html).toMatch(
      /<input(?=[^>]*name="confirm_identifier")(?=[^>]*placeholder="Summer &lt;Crew&gt;")(?=[^>]*required)[^>]*>/,
    );
  });

  test("renders the reactivate confirmation for inactive listings as safe", () => {
    const html = adminReactivateGroupPage(
      GROUP,
      [ACTIVE, INACTIVE],
      OWNER_SESSION,
    );

    expect(html).toContain('action="/admin/groups/17/bulk-actions/reactivate"');
    expect(html).toContain(
      "1 listing in <strong>Summer &lt;Crew&gt;</strong>.",
    );
    expect(html).toContain("public ticket pages will be accessible");
    expect(html).not.toContain("Warning:");
    expect(html).not.toContain('<button class="danger" type="submit">');
    expect(html).toContain('name="confirm_identifier"');
  });
});
