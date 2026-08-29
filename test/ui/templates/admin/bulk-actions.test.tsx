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
    // The landing links back to the group itself and highlights the Groups nav.
    expect(html).toContain('href="/admin/groups/17">← Summer &lt;Crew&gt;</a>');
    expect(html).toContain('<a class="active" href="/admin/groups"');
    // Each landing action names what it does after its link, and the prose
    // block heads the page copy.
    expect(html).toContain('<div class="prose"><h1>Bulk Actions</h1>');
    expect(html).toContain("Deactivate Group</a> — ");
    expect(html).toContain("Duplicate Group</a> — Create a new group");
  });

  test("offers reactivation only when every listing is inactive", () => {
    const html = adminBulkActionsPage(GROUP, [INACTIVE], OWNER_SESSION);

    expect(html).toContain('href="/admin/groups/17/bulk-actions/reactivate"');
    expect(html).not.toContain(
      'href="/admin/groups/17/bulk-actions/deactivate"',
    );
    // The reactivate action keeps the landing's link — description join too.
    expect(html).toContain("Reactivate Group</a> — ");
    // The deactivate join is hidden along with its link.
    expect(html).not.toContain("Deactivate Group</a> — ");
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
    // A name holding the word "mutated": under a non-empty initial find, its
    // new-name preview would differ. The initial find is empty, so the
    // preview shows the name exactly.
    const watchMutated = testListingWithCount({
      id: 10,
      name: "Unmutated session",
    });
    const html = adminDuplicateGroupPage(
      GROUP,
      [listing, watchMutated],
      OWNER_SESSION,
      "Try again.",
    );

    expect(html).toContain("Try again.");
    expect(html).toContain('action="/admin/groups/17/bulk-actions/duplicate"');
    expect(html).toContain('data-duplicate-preview data-timezone="UTC"');
    expect(html).toMatch(
      /<input(?=[^>]*name="new_name")(?=[^>]*required)(?=[^>]*type="text")(?=[^>]*value="Summer &lt;Crew&gt; \(copy\)")[^>]*>/,
    );
    // The duplicate page's back-link lands on the bulk-actions landing, not
    // the group page, and its copy heads a prose block.
    expect(html).toContain(
      'href="/admin/groups/17/bulk-actions">← Bulk Actions</a>',
    );
    // The find field starts empty (its own name_find input shows no value).
    expect(html).toContain("<td data-preview-original-name>");
    expect(html).toContain('<div class="prose"><h1>Duplicate Group</h1>');
    // The nested nav highlight matches the landing's Groups section.
    expect(html).toContain('<a class="active" href="/admin/groups"');
    // The find/replace pairs keep their input kinds.
    expect(html).toMatch(
      /<input(?=[^>]*name="name_replace")(?=[^>]*type="text")[^>]*>/,
    );
    expect(html).toMatch(
      /<input(?=[^>]*name="date_replace")(?=[^>]*type="date")[^>]*>/,
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
    // The preview table tags each cell with the JS preview hooks (a boolean
    // attribute renders with no value), and the find/replace inputs carry
    // their kinds.
    expect(html).toContain("<td data-preview-original-name>");
    expect(html).toContain("<td data-preview-new-name>");
    expect(html).toContain("<td data-preview-original-date>");
    expect(html).toContain("<td data-preview-new-date>");
    expect(html).toMatch(/<input(?=[^>]*name="name_find")(?=[^>]*type="text")/);
    expect(html).toMatch(/<input(?=[^>]*name="date_find")(?=[^>]*type="date")/);
    expect(html).toContain('id="duplicate-group-form"');
    expect(html).toContain("<span>Duplicate Group</span>");
    // A name whose text would change under any non-empty find still previews
    // unchanged: the initial find is empty.
    expect(html).toContain(
      "<td data-preview-original-name>Afternoon session</td>",
    );
    expect(html).toContain("<td data-preview-new-name>Unmutated session</td>");
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
    // The warning lead is bold wording, joined to the count that follows it.
    expect(html).toContain(
      "<strong>Warning:</strong> Deactivating this group will deactivate 1",
    );
    // The confirm page sits in the Groups nav section like the landing does.
    expect(html).toContain('<a class="active" href="/admin/groups"');
  });

  test("renders the reactivate confirmation for inactive listings as safe", () => {
    // Two active and one inactive: the reactivate page counts the INACTIVE
    // listing, so the fixture must differ in each direction.
    const html = adminReactivateGroupPage(
      GROUP,
      [ACTIVE, ACTIVE, INACTIVE],
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
    // An activate-flipping page still sits in the Groups nav section, so the
    // nav highlights Groups the way the landing does.
    expect(html).toContain('<a class="active" href="/admin/groups"');
  });
});
