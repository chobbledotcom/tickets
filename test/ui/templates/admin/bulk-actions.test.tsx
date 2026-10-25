import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { FormParams } from "#shared/form-data.ts";
import { setSavedFormData } from "#shared/forms/saved-data.ts";
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
import { assertPageMatchesSnapshot } from "#test-utils/page-snapshot.ts";
import { withRequestContext } from "#test-utils/request-context.ts";
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

    assertStringIncludes(
      html,
      'href="/admin/groups/17/bulk-actions/duplicate"',
    );
    assertStringIncludes(
      html,
      'href="/admin/groups/17/bulk-actions/deactivate"',
    );
    assert(!html.includes('href="/admin/groups/17/bulk-actions/reactivate"'));
    assertStringIncludes(
      html,
      "2 listings in <strong>Summer &lt;Crew&gt;</strong>.",
    );
    // The landing links back to the group itself and highlights the Groups nav.
    assertStringIncludes(
      html,
      'href="/admin/groups/17">← Summer &lt;Crew&gt;</a>',
    );
    assertStringIncludes(html, '<a class="active" href="/admin/groups"');
    // Each landing action names what it does after its link, and the prose
    // block heads the page copy.
    assertStringIncludes(html, '<div class="prose"><h1>Bulk Actions</h1>');
    assertStringIncludes(html, "Deactivate Group</a> — ");
    assertStringIncludes(html, "Duplicate Group</a> — Create a new group");
  });

  test("offers reactivation only when every listing is inactive", () => {
    const html = adminBulkActionsPage(GROUP, [INACTIVE], OWNER_SESSION);

    assertStringIncludes(
      html,
      'href="/admin/groups/17/bulk-actions/reactivate"',
    );
    assert(!html.includes('href="/admin/groups/17/bulk-actions/deactivate"'));
    // The reactivate action keeps the landing's link — description join too.
    assertStringIncludes(html, "Reactivate Group</a> — ");
    // The deactivate join is hidden along with its link.
    assert(!html.includes("Deactivate Group</a> — "));
  });

  test("offers neither activation change for an empty group", () => {
    const html = adminBulkActionsPage(GROUP, [], OWNER_SESSION);

    assertStringIncludes(
      html,
      'href="/admin/groups/17/bulk-actions/duplicate"',
    );
    assert(!html.includes("/bulk-actions/deactivate"));
    assert(!html.includes("/bulk-actions/reactivate"));
    assertStringIncludes(
      html,
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

    assertStringIncludes(html, "Try again.");
    assertStringIncludes(
      html,
      'action="/admin/groups/17/bulk-actions/duplicate"',
    );
    assertStringIncludes(html, 'data-duplicate-preview data-timezone="UTC"');
    expect(html).toMatch(
      /<input(?=[^>]*name="new_name")(?=[^>]*required)(?=[^>]*type="text")(?=[^>]*value="Summer &lt;Crew&gt; \(copy\)")[^>]*>/,
    );
    // The duplicate page's back-link lands on the bulk-actions landing, not
    // the group page, and its copy heads a prose block.
    assertStringIncludes(
      html,
      'href="/admin/groups/17/bulk-actions">← Bulk Actions</a>',
    );
    // The find field starts empty (its own name_find input shows no value).
    assertStringIncludes(html, "<td data-preview-original-name>");
    assertStringIncludes(html, '<div class="prose"><h1>Duplicate Group</h1>');
    // The nested nav highlight matches the landing's Groups section.
    assertStringIncludes(html, '<a class="active" href="/admin/groups"');
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
      assertStringIncludes(html, `name="${name}"`);
    }
    assertStringIncludes(html, '<tbody data-duplicate-preview-rows="">');
    // The preview table tags each cell with the JS preview hooks (a boolean
    // attribute renders with no value), and the find/replace inputs carry
    // their kinds.
    assertStringIncludes(html, "<td data-preview-original-name>");
    assertStringIncludes(html, "<td data-preview-new-name>");
    assertStringIncludes(html, "<td data-preview-original-date>");
    assertStringIncludes(html, "<td data-preview-new-date>");
    expect(html).toMatch(/<input(?=[^>]*name="name_find")(?=[^>]*type="text")/);
    expect(html).toMatch(/<input(?=[^>]*name="date_find")(?=[^>]*type="date")/);
    assertStringIncludes(html, 'id="duplicate-group-form"');
    assertStringIncludes(html, "<span>Duplicate Group</span>");
    // A name whose text would change under any non-empty find still previews
    // unchanged: the initial find is empty.
    assertStringIncludes(
      html,
      "<td data-preview-original-name>Afternoon session</td>",
    );
    assertStringIncludes(
      html,
      "<td data-preview-new-name>Unmutated session</td>",
    );
    assertStringIncludes(html, '<tr data-listing-id="9">');
    assertStringIncludes(html, "Afternoon session");
    assertStringIncludes(html, "2026-08-03 14:30");
  });

  test("renders the restored replacements into the fields and the preview", async () => {
    // A failed duplicate stashes the submitted values; the follow-up GET
    // renders them back into the fields AND opens the preview on them.
    await withRequestContext(async () => {
      setSavedFormData(
        new FormParams(
          "date_find=2026-03-02&date_replace=2026-03-09&name_find=First&name_replace=Second&new_name=Chosen Copy",
        ),
      );
      const listing = testListingWithCount({
        date: "2026-03-02T18:00:00.000Z",
        id: 4,
        name: "First Night",
      });

      const html = adminDuplicateGroupPage(GROUP, [listing], OWNER_SESSION);

      assertStringIncludes(html, 'value="Chosen Copy"');
      assertStringIncludes(html, 'value="First"');
      assertStringIncludes(html, 'value="Second"');
      assertStringIncludes(html, 'value="2026-03-02"');
      assertStringIncludes(html, 'value="2026-03-09"');
      // The preview opens on the restored replacements, not on empty ones:
      // the new-name and new-date cells already show the computed result.
      assertStringIncludes(html, "<td data-preview-new-name>Second Night</td>");
      assertStringIncludes(
        html,
        "<td data-preview-new-date>2026-03-09 18:00</td>",
      );
      assertStringIncludes(
        html,
        "<td data-preview-original-name>First Night</td>",
      );
      assertStringIncludes(
        html,
        "<td data-preview-original-date>2026-03-02 18:00</td>",
      );
    });
  });

  test("restores a submitted empty new name as empty", async () => {
    await withRequestContext(async () => {
      setSavedFormData(new FormParams("new_name="));

      const html = adminDuplicateGroupPage(GROUP, [ACTIVE], OWNER_SESSION);

      // The operator submitted an empty name, so the field comes back empty:
      // the "<group> (copy)" default must not resurface over that choice.
      assert(!html.includes("(copy)"));
    });
  });

  test("restores each replacement independently when one is absent", async () => {
    // A submitted form may carry one field of a pair and not its partner
    // (the POST stores what it received). The absent side falls back to
    // empty, so an empty date_find leaves the dates unshifted and an empty
    // name_replace deletes the find text instead of substituting it.
    await withRequestContext(async () => {
      setSavedFormData(
        new FormParams("date_replace=2026-03-09&name_find=First"),
      );

      const listing = testListingWithCount({
        date: "2026-03-02T18:00:00.000Z",
        id: 4,
        name: "First Night",
      });

      const html = adminDuplicateGroupPage(GROUP, [listing], OWNER_SESSION);

      assertStringIncludes(html, 'value="2026-03-09"');
      assertStringIncludes(html, 'value="First"');
      assertStringIncludes(html, "<td data-preview-new-name> Night</td>");
      assertStringIncludes(
        html,
        "<td data-preview-new-date>2026-03-02 18:00</td>",
      );
    });
  });

  test("restores the date shift when only the reference date was submitted", async () => {
    // The mirrored asymmetry: date_find present, date_replace absent. The
    // absent replace falls back to empty, so the empty replace leaves the
    // dates unshifted.
    await withRequestContext(async () => {
      setSavedFormData(
        new FormParams(
          "date_find=2026-03-02&name_find=First&name_replace=Second",
        ),
      );

      const listing = testListingWithCount({
        date: "2026-03-02T18:00:00.000Z",
        id: 4,
        name: "First Night",
      });

      const html = adminDuplicateGroupPage(GROUP, [listing], OWNER_SESSION);

      assertStringIncludes(html, 'value="2026-03-02"');
      assertStringIncludes(html, 'value="Second"');
      assertStringIncludes(html, "<td data-preview-new-name>Second Night</td>");
      assertStringIncludes(
        html,
        "<td data-preview-new-date>2026-03-02 18:00</td>",
      );
    });
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
    assert(!html.includes('</script><script>alert("owned")'));
    assertStringIncludes(
      html,
      "&lt;/script&gt;&lt;script&gt;alert(&quot;owned&quot;)&lt;/script&gt;&amp;",
    );
  });

  test("renders the duplicate empty state with an empty JSON payload", () => {
    const html = adminDuplicateGroupPage(GROUP, [], OWNER_SESSION);

    assertStringIncludes(html, "This group has no listings");
    assert(!html.includes("data-duplicate-preview-rows"));
    expect(embeddedListingsJson(html)).toBe("[]");
  });

  test("renders the deactivate confirmation for active listings as dangerous", () => {
    const html = adminDeactivateGroupPage(
      GROUP,
      [ACTIVE, INACTIVE],
      OWNER_SESSION,
      "Name did not match.",
    );

    assertStringIncludes(html, "Name did not match.");
    assertStringIncludes(
      html,
      'action="/admin/groups/17/bulk-actions/deactivate"',
    );
    assertStringIncludes(html, "1 active listing");
    assertStringIncludes(html, "Warning:");
    assertStringIncludes(html, '<button class="danger" type="submit">');
    expect(html).toMatch(
      /<input(?=[^>]*name="confirm_identifier")(?=[^>]*placeholder="Summer &lt;Crew&gt;")(?=[^>]*required)[^>]*>/,
    );
    // The warning lead is bold wording, joined to the count that follows it.
    assertStringIncludes(
      html,
      "<strong>Warning:</strong> Deactivating this group will deactivate 1",
    );
    // The confirm page sits in the Groups nav section like the landing does.
    assertStringIncludes(html, '<a class="active" href="/admin/groups"');
  });

  test("renders the reactivate confirmation for inactive listings as safe", () => {
    // Two active and one inactive: the reactivate page counts the INACTIVE
    // listing, so the fixture must differ in each direction.
    const html = adminReactivateGroupPage(
      GROUP,
      [ACTIVE, ACTIVE, INACTIVE],
      OWNER_SESSION,
    );

    assertStringIncludes(
      html,
      'action="/admin/groups/17/bulk-actions/reactivate"',
    );
    assertStringIncludes(
      html,
      "1 listing in <strong>Summer &lt;Crew&gt;</strong>.",
    );
    assertStringIncludes(html, "public ticket pages will be accessible");
    assert(!html.includes("Warning:"));
    assert(!html.includes('<button class="danger" type="submit">'));
    assertStringIncludes(html, 'name="confirm_identifier"');
    // An activate-flipping page still sits in the Groups nav section, so the
    // nav highlights Groups the way the landing does.
    assertStringIncludes(html, '<a class="active" href="/admin/groups"');
  });

  describe("the bulk-actions page shells", () => {
    test("renders the landing page identically to the parent build", () => {
      const html = adminBulkActionsPage(GROUP, [ACTIVE], OWNER_SESSION);

      assertPageMatchesSnapshot(
        new URL("./bulk-landing.snapshot.html", import.meta.url),
        html,
      );
    });

    test("renders the duplicate page identically to the parent build", () => {
      const html = adminDuplicateGroupPage(
        GROUP,
        [ACTIVE],
        OWNER_SESSION,
        "Group name is taken",
      );

      assertPageMatchesSnapshot(
        new URL("./bulk-duplicate.snapshot.html", import.meta.url),
        html,
      );
    });
  });
});
