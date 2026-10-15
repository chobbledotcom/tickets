import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import type { AttributeOption, AttributeWithOptions } from "#db/attributes.ts";
import type { AttributeListingRow } from "#routes/admin/attribute-page-data.ts";
import {
  adminAttributeDeletePage,
  adminAttributeOptionDeletePage,
  adminAttributeOptionEditPage,
  adminAttributePage,
  adminAttributesPage,
  attributeNameFlat,
  ListingAttributesPanel,
} from "#templates/admin/attributes.tsx";
import { OWNER_SESSION } from "#test-utils/admin-page-test.ts";
import { withEnv } from "#test-utils/env.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import {
  resetFeaturePageTest,
  setupFeaturePageTest,
} from "./feature-page-test.ts";

const ATTRIBUTE: AttributeWithOptions = {
  id: 1,
  name: "Colour",
  options: [
    { attribute_id: 1, id: 10, sort_order: 0, text: "Red" },
    { attribute_id: 1, id: 11, sort_order: 1, text: "Blue" },
  ],
  sort_order: 0,
};
const ATTRIBUTE_B: AttributeWithOptions = {
  id: 2,
  name: "Size",
  options: [],
  sort_order: 1,
};
const OPTION: AttributeOption = ATTRIBUTE.options[0]!;

// One active and one deactivated listing, each carrying the option texts it
// selected — enough to tell the "muted" (deactivated) row apart from the live
// one, and to prove the joined option texts render.
const ACTIVE_LISTING: AttributeListingRow = {
  active: true,
  id: 5,
  name: "Active Show",
  optionTexts: ["Red", "Blue"],
};
const DEACTIVATED_LISTING: AttributeListingRow = {
  active: false,
  id: 6,
  name: "Old Show",
  optionTexts: ["Red"],
};

// Only option 10 has a listing count; option 11 is absent from the map, so its
// cell must fall back to 0 (not 1, not undefined).
const COUNTS = new Map([[10, 3]]);

const NO_LISTINGS_TEXT = "No listings have this attribute set yet.";

const setupAttributePageTest = setupFeaturePageTest("attributes");

describe("attributeNameFlat", () => {
  test("joins name lines with a slash separator", () => {
    // A two-line attribute name flattens with " / " between the lines, so the
    // dropping the separator (or changing it) is caught.
    expect(attributeNameFlat("Red\nGreen")).toBe("Red / Green");
    expect(attributeNameFlat("A\r\nB")).toBe("A / B");
    expect(attributeNameFlat("Plain")).toBe("Plain");
  });
});

describe("adminAttributesPage (writable list)", () => {
  beforeAll(setupAttributePageTest);
  afterAll(resetFeaturePageTest);

  const html = (): string =>
    adminAttributesPage([ATTRIBUTE, ATTRIBUTE_B], OWNER_SESSION);

  test("marks the attributes nav link active", () => {
    assertStringIncludes(html(), 'class="active" href="/admin/attributes"');
  });

  test("renders the add-attribute form with its action and id", () => {
    assertStringIncludes(
      html(),
      '<form action="/admin/attributes" autocomplete="off" method="POST" id="new-attribute">',
    );
    assertStringIncludes(html(), 'id="new-attribute">');
  });

  test("renders the reorder column and move controls when writable", () => {
    // The reorder flag is on: the Order header and the move arrows both show.
    assertStringIncludes(html(), '<th class="col-reorder">Order</th>');
    assertStringIncludes(html(), "/admin/attributes/1/move-down");
    assertStringIncludes(html(), "/admin/attributes/2/move-up");
  });

  test("links to the listings guide section", () => {
    assertStringIncludes(
      html(),
      '<a class="guide-link" href="/admin/guide#listings">',
    );
  });
});

describe("adminAttributePage (detail)", () => {
  beforeAll(setupAttributePageTest);
  afterAll(resetFeaturePageTest);

  const withListings = (listings: AttributeListingRow[]): string =>
    adminAttributePage(ATTRIBUTE, OWNER_SESSION, undefined, {
      listingCounts: COUNTS,
      listings,
    });

  test("marks the attributes nav link active", () => {
    expect(
      withListings([]).includes('class="active" href="/admin/attributes"'),
    ).toBe(true);
  });

  test("renders the add-option form with its id", () => {
    assertStringIncludes(withListings([]), 'id="new-attribute-option">');
  });

  test("shows the options reorder column when writable", () => {
    assertStringIncludes(
      withListings([]),
      '<th class="col-reorder">Order</th>',
    );
  });

  test("falls back to a zero count for an option no listing uses", () => {
    // Option 11 (Blue) is absent from the counts map, so its cell shows 0.
    assertStringIncludes(
      withListings([]),
      '<a href="/admin/attributes/1/options/11/edit">Blue</a></td><td class="col-quantity">0</td>',
    );
    // Option 10 (Red) has a real count of 3.
    assertStringIncludes(
      withListings([]),
      '<a href="/admin/attributes/1/options/10/edit">Red</a></td><td class="col-quantity">3</td>',
    );
  });

  test("shows the empty state when no listing uses the attribute", () => {
    const html = withListings([]);
    assertStringIncludes(html, NO_LISTINGS_TEXT);
    assert(
      !html.includes('href="/admin/listing/'),
      "the value should not contain the searched item",
    );
  });

  test("shows the listings table (not the empty state) for one listing", () => {
    const html = withListings([ACTIVE_LISTING]);
    assertStringIncludes(html, '<a href="/admin/listing/5">Active Show</a>');
    assert(
      !html.includes(NO_LISTINGS_TEXT),
      "the value should not contain the searched item",
    );
  });

  test("renders the listing and options column headers", () => {
    assertStringIncludes(
      withListings([ACTIVE_LISTING]),
      "<th>Listing</th><th>Options</th>",
    );
  });

  test("renders each listing's joined option texts", () => {
    // showOptions is true here, so the option-texts column appears and the
    // texts are joined with ", ".
    assertStringIncludes(withListings([ACTIVE_LISTING]), "<td>Red, Blue</td>");
  });

  test("mutes deactivated listings and leaves active ones unstyled", () => {
    const html = withListings([ACTIVE_LISTING, DEACTIVATED_LISTING]);
    assertStringIncludes(
      html,
      '<td><a href="/admin/listing/5">Active Show</a></td>',
    );
    assertStringIncludes(
      html,
      '<a class="muted" href="/admin/listing/6">Old Show</a>',
    );
  });

  test("links to the attribute delete page", () => {
    assertStringIncludes(
      withListings([]),
      '<a class="danger" href="/admin/attributes/1/delete">Delete attribute</a>',
    );
  });
});

describe("adminAttributeOptionEditPage", () => {
  beforeAll(setupAttributePageTest);
  afterAll(resetFeaturePageTest);

  const html = (): string =>
    adminAttributeOptionEditPage(ATTRIBUTE, OPTION, OWNER_SESSION, undefined, [
      ACTIVE_LISTING,
    ]);

  test("marks the attributes nav link active", () => {
    assertStringIncludes(html(), 'class="active" href="/admin/attributes"');
  });

  test("links back to the parent attribute", () => {
    assertStringIncludes(
      html(),
      '<a class="btn small" href="/admin/attributes/1">',
    );
  });

  test("omits the options column and texts (showOptions is false)", () => {
    // Only the Listing header, no Options column and no joined-texts cell.
    assertStringIncludes(html(), "<thead><tr><th>Listing</th></tr></thead>");
    assertStringIncludes(
      html(),
      '<tr><td><a href="/admin/listing/5">Active Show</a></td></tr>',
    );
    assert(
      !html().includes("<td>Red, Blue</td>"),
      "the value should not contain the searched item",
    );
  });

  test("links to the option delete page with danger styling", () => {
    assertStringIncludes(
      html(),
      '<a class="danger" href="/admin/attributes/1/options/10/delete">Delete option</a>',
    );
  });
});

describe("attribute delete pages", () => {
  beforeAll(setupAttributePageTest);
  afterAll(resetFeaturePageTest);

  test("attribute delete page marks the nav active and posts to delete", () => {
    const html = adminAttributeDeletePage(ATTRIBUTE, OWNER_SESSION);
    assertStringIncludes(html, 'class="active" href="/admin/attributes"');
    assertStringIncludes(html, 'action="/admin/attributes/1/delete"');
    assertStringIncludes(
      html,
      "To delete this attribute, type its name &quot;Colour&quot;",
    );
  });

  test("option delete page marks the nav active and posts to delete", () => {
    const html = adminAttributeOptionDeletePage(
      ATTRIBUTE,
      OPTION,
      OWNER_SESSION,
    );
    assertStringIncludes(html, 'class="active" href="/admin/attributes"');
    assertStringIncludes(
      html,
      'action="/admin/attributes/1/options/10/delete"',
    );
    assertStringIncludes(html, "This will remove &quot;Red&quot; from Colour");
  });
});

describe("ListingAttributesPanel", () => {
  beforeAll(setupAttributePageTest);
  afterAll(resetFeaturePageTest);

  const LISTING = testListingWithCount({ id: 7, name: "Panel Listing" });

  test("links to manage attributes and pre-checks selected options", () => {
    const html = String(
      ListingAttributesPanel({
        attributes: [ATTRIBUTE],
        listing: LISTING,
        selectedOptionIds: new Set([10]),
      }),
    );
    assertStringIncludes(
      html,
      '<a class="btn small" href="/admin/attributes">',
    );
    assertStringIncludes(
      html,
      '<input checked name="option_ids" type="checkbox" value="10">',
    );
  });

  test("shows the empty state with a create link when there are no attributes", () => {
    const html = String(
      ListingAttributesPanel({
        attributes: [],
        listing: LISTING,
        selectedOptionIds: new Set(),
      }),
    );
    // The prompt keeps a space before the create link, and the manage link is
    // still shown in the footer.
    assertStringIncludes(
      html,
      'No attributes created yet. <a href="/admin/attributes">Create attributes</a>.',
    );
    assertStringIncludes(
      html,
      '<a class="btn small" href="/admin/attributes">',
    );
  });

  test("says an attribute has no options yet rather than showing none", () => {
    const html = String(
      ListingAttributesPanel({
        attributes: [ATTRIBUTE_B],
        listing: LISTING,
        selectedOptionIds: new Set(),
      }),
    );

    assertStringIncludes(html, "<em>No options for this attribute yet.</em>");
    assert(
      !html.includes('name="option_ids"'),
      "the value should not contain the searched item",
    );
  });

  test("offers the one option an attribute has", () => {
    const oneOption: AttributeWithOptions = {
      ...ATTRIBUTE,
      options: [OPTION],
    };

    const html = String(
      ListingAttributesPanel({
        attributes: [oneOption],
        listing: LISTING,
        selectedOptionIds: new Set(),
      }),
    );

    assertStringIncludes(
      html,
      '<input name="option_ids" type="checkbox" value="10">',
    );
    assert(
      !html.includes("No options for this attribute yet."),
      "the value should not contain the searched item",
    );
  });

  test("flows each attribute's options as a wrapping row", () => {
    const html = String(
      ListingAttributesPanel({
        attributes: [ATTRIBUTE],
        listing: LISTING,
        selectedOptionIds: new Set(),
      }),
    );

    assertStringIncludes(html, 'class="checkboxes listing-section"');
  });
});

describe("attribute pages in read-only mode", () => {
  beforeAll(setupAttributePageTest);
  afterAll(resetFeaturePageTest);

  test("keeps the list readable without create or reorder controls", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = adminAttributesPage([ATTRIBUTE], OWNER_SESSION);
    assertStringIncludes(html, "Colour");
    assertStringIncludes(html, 'href="/admin/attributes/1"');
    assert(
      !html.includes('id="new-attribute"'),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes('<th class="col-reorder">Order</th>'),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("/admin/attributes/1/move-"),
      "the value should not contain the searched item",
    );
  });

  test("keeps details readable without edit or delete controls", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = adminAttributePage(ATTRIBUTE, OWNER_SESSION, undefined, {
      listingCounts: new Map([[10, 2]]),
      listings: [],
    });
    assertStringIncludes(html, "Red");
    assertStringIncludes(html, '<td class="col-quantity">2</td>');
    assert(
      !html.includes('action="/admin/attributes/1/edit"'),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("/admin/attributes/1/options/10/edit"),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("/admin/attributes/1/delete"),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("/options/10/move-"),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes('<th class="col-reorder">Order</th>'),
      "the value should not contain the searched item",
    );
  });
});

describe("attribute option arrows", () => {
  beforeAll(setupAttributePageTest);
  afterAll(resetFeaturePageTest);

  test("use their declared action routes", () => {
    const html = adminAttributePage(ATTRIBUTE, OWNER_SESSION, undefined, {
      listingCounts: new Map(),
      listings: [],
    });
    assert(
      !html.includes("/options/10/move-up"),
      "the value should not contain the searched item",
    );
    assertStringIncludes(html, "/options/10/move-down");
    assertStringIncludes(html, "/options/11/move-up");
    assert(
      !html.includes("/options/11/move-down"),
      "the value should not contain the searched item",
    );
  });
});
