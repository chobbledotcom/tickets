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
    expect(html()).toContain('class="active" href="/admin/attributes"');
  });

  test("renders the add-attribute form with its action and id", () => {
    expect(html()).toContain(
      '<form action="/admin/attributes" autocomplete="off" method="POST" id="new-attribute">',
    );
    expect(html()).toContain('id="new-attribute">');
  });

  test("renders the reorder column and move controls when writable", () => {
    // The reorder flag is on: the Order header and the move arrows both show.
    expect(html()).toContain('<th class="col-reorder">Order</th>');
    expect(html()).toContain("/admin/attributes/1/move-down");
    expect(html()).toContain("/admin/attributes/2/move-up");
  });

  test("links to the listings guide section", () => {
    expect(html()).toContain(
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
    expect(withListings([])).toContain('id="new-attribute-option">');
  });

  test("shows the options reorder column when writable", () => {
    expect(withListings([])).toContain('<th class="col-reorder">Order</th>');
  });

  test("falls back to a zero count for an option no listing uses", () => {
    // Option 11 (Blue) is absent from the counts map, so its cell shows 0.
    expect(withListings([])).toContain(
      '<a href="/admin/attributes/1/options/11/edit">Blue</a></td><td class="col-quantity">0</td>',
    );
    // Option 10 (Red) has a real count of 3.
    expect(withListings([])).toContain(
      '<a href="/admin/attributes/1/options/10/edit">Red</a></td><td class="col-quantity">3</td>',
    );
  });

  test("shows the empty state when no listing uses the attribute", () => {
    const html = withListings([]);
    expect(html).toContain(NO_LISTINGS_TEXT);
    expect(html).not.toContain('href="/admin/listing/');
  });

  test("shows the listings table (not the empty state) for one listing", () => {
    const html = withListings([ACTIVE_LISTING]);
    expect(html).toContain('<a href="/admin/listing/5">Active Show</a>');
    expect(html).not.toContain(NO_LISTINGS_TEXT);
  });

  test("renders the listing and options column headers", () => {
    expect(withListings([ACTIVE_LISTING])).toContain(
      "<th>Listing</th><th>Options</th>",
    );
  });

  test("renders each listing's joined option texts", () => {
    // showOptions is true here, so the option-texts column appears and the
    // texts are joined with ", ".
    expect(withListings([ACTIVE_LISTING])).toContain("<td>Red, Blue</td>");
  });

  test("mutes deactivated listings and leaves active ones unstyled", () => {
    const html = withListings([ACTIVE_LISTING, DEACTIVATED_LISTING]);
    expect(html).toContain(
      '<td><a href="/admin/listing/5">Active Show</a></td>',
    );
    expect(html).toContain(
      '<a class="muted" href="/admin/listing/6">Old Show</a>',
    );
  });

  test("links to the attribute delete page", () => {
    expect(withListings([])).toContain(
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
    expect(html()).toContain('class="active" href="/admin/attributes"');
  });

  test("links back to the parent attribute", () => {
    expect(html()).toContain(
      '<a class="btn small" href="/admin/attributes/1">',
    );
  });

  test("omits the options column and texts (showOptions is false)", () => {
    // Only the Listing header, no Options column and no joined-texts cell.
    expect(html()).toContain("<thead><tr><th>Listing</th></tr></thead>");
    expect(html()).toContain(
      '<tr><td><a href="/admin/listing/5">Active Show</a></td></tr>',
    );
    expect(html()).not.toContain("<td>Red, Blue</td>");
  });

  test("links to the option delete page with danger styling", () => {
    expect(html()).toContain(
      '<a class="danger" href="/admin/attributes/1/options/10/delete">Delete option</a>',
    );
  });
});

describe("attribute delete pages", () => {
  beforeAll(setupAttributePageTest);
  afterAll(resetFeaturePageTest);

  test("attribute delete page marks the nav active and posts to delete", () => {
    const html = adminAttributeDeletePage(ATTRIBUTE, OWNER_SESSION);
    expect(html).toContain('class="active" href="/admin/attributes"');
    expect(html).toContain('action="/admin/attributes/1/delete"');
    expect(html).toContain(
      "To delete this attribute, type its name &quot;Colour&quot;",
    );
  });

  test("option delete page marks the nav active and posts to delete", () => {
    const html = adminAttributeOptionDeletePage(
      ATTRIBUTE,
      OPTION,
      OWNER_SESSION,
    );
    expect(html).toContain('class="active" href="/admin/attributes"');
    expect(html).toContain('action="/admin/attributes/1/options/10/delete"');
    expect(html).toContain("This will remove &quot;Red&quot; from Colour");
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
    expect(html).toContain('<a class="btn small" href="/admin/attributes">');
    expect(html).toContain(
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
    expect(html).toContain(
      'No attributes created yet. <a href="/admin/attributes">Create attributes</a>.',
    );
    expect(html).toContain('<a class="btn small" href="/admin/attributes">');
  });
});

describe("attribute pages in read-only mode", () => {
  beforeAll(setupAttributePageTest);
  afterAll(resetFeaturePageTest);

  test("keeps the list readable without create or reorder controls", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = adminAttributesPage([ATTRIBUTE], OWNER_SESSION);
    expect(html).toContain("Colour");
    expect(html).toContain('href="/admin/attributes/1"');
    expect(html).not.toContain('id="new-attribute"');
    expect(html).not.toContain('<th class="col-reorder">Order</th>');
    expect(html).not.toContain("/admin/attributes/1/move-");
  });

  test("keeps details readable without edit or delete controls", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = adminAttributePage(ATTRIBUTE, OWNER_SESSION, undefined, {
      listingCounts: new Map([[10, 2]]),
      listings: [],
    });
    expect(html).toContain("Red");
    expect(html).toContain('<td class="col-quantity">2</td>');
    expect(html).not.toContain('action="/admin/attributes/1/edit"');
    expect(html).not.toContain("/admin/attributes/1/options/10/edit");
    expect(html).not.toContain("/admin/attributes/1/delete");
    expect(html).not.toContain("/options/10/move-");
    expect(html).not.toContain('<th class="col-reorder">Order</th>');
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
    expect(html).not.toContain("/options/10/move-up");
    expect(html).toContain("/options/10/move-down");
    expect(html).toContain("/options/11/move-up");
    expect(html).not.toContain("/options/11/move-down");
  });
});
