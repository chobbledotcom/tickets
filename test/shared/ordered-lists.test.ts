/**
 * Every ordered list, held to the same rules. The sample table is keyed by
 * list, so a new list without a sample does not compile.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { ORDERED_LISTS } from "#shared/ordered-lists.ts";

/** One row of a list, the record it belongs to, and where they lead. */
type Sample = {
  row: object;
  parent?: number;
  path: string;
  anchor: string;
  listPath: string;
  moved: string;
};

/** The parts of a list this test reads. The methods take any row, so every
 *  list fits. */
type ListUnderTest = {
  readonly rowPath: string;
  readonly moved: string;
  readonly writes: object;
  paramsOf(row: object, parent: unknown): Record<string, unknown>;
  keyOf(params: Record<string, unknown>): unknown;
  parentOf(params: Record<string, unknown>): unknown;
  listPathFor(params: Record<string, unknown>): string;
  column(parent?: unknown): {
    anchor(row: object): string;
    path(row: object): string;
  };
};

/* jscpd:ignore-start -- static data, not code */
const SAMPLES: Record<keyof typeof ORDERED_LISTS, Sample> = {
  answer: {
    anchor: "5",
    listPath: "/admin/questions/2",
    moved: "Answer moved",
    parent: 2,
    path: "/admin/questions/2/answers/5",
    row: { id: 5 },
  },
  attribute: {
    anchor: "5",
    listPath: "/admin/attributes",
    moved: "Attribute moved",
    path: "/admin/attributes/5",
    row: { id: 5 },
  },
  attributeOption: {
    anchor: "5",
    listPath: "/admin/attributes/2",
    moved: "Option moved",
    parent: 2,
    path: "/admin/attributes/2/options/5",
    row: { id: 5 },
  },
  groupImage: {
    anchor: "5",
    listPath: "/admin/groups/2/images",
    moved: "Image moved",
    parent: 2,
    path: "/admin/groups/2/images/5",
    row: { id: 5 },
  },
  listing: {
    anchor: "5",
    listPath: "/admin/listings",
    moved: "Listing moved",
    path: "/admin/listing/5",
    row: { id: 5 },
  },
  listingImage: {
    anchor: "5",
    listPath: "/admin/listing/2/images",
    moved: "Image moved",
    parent: 2,
    path: "/admin/listing/2/images/5",
    row: { id: 5 },
  },
  newsImage: {
    anchor: "5",
    listPath: "/admin/site/news/2/images",
    moved: "Image moved",
    parent: 2,
    path: "/admin/site/news/2/images/5",
    row: { id: 5 },
  },
  question: {
    anchor: "5",
    listPath: "/admin/questions",
    moved: "Question moved",
    path: "/admin/questions/5",
    row: { id: 5 },
  },
  sitePage: {
    anchor: "5",
    listPath: "/admin/site/pages",
    moved: "Order updated",
    path: "/admin/site/pages/5",
    row: { id: 5 },
  },
  sitePageImage: {
    anchor: "5",
    listPath: "/admin/site/pages/2/images",
    moved: "Image moved",
    parent: 2,
    path: "/admin/site/pages/2/images/5",
    row: { id: 5 },
  },
  sitePageItem: {
    anchor: "group:5",
    listPath: "/admin/site/pages/2/items",
    moved: "Order updated",
    parent: 2,
    path: "/admin/site/pages/2/items/group/5",
    row: { id: 5, type: "group" },
  },
  status: {
    anchor: "5",
    listPath: "/admin/settings/statuses",
    moved: "Status moved",
    path: "/admin/settings/statuses/5",
    row: { id: 5 },
  },
};
/* jscpd:ignore-end */

describe("ordered lists", () => {
  for (const [name, sample] of Object.entries(SAMPLES)) {
    const list: ListUnderTest = ORDERED_LISTS[name as keyof typeof SAMPLES];
    const column = list.column(sample.parent);
    const params = list.paramsOf(sample.row, sample.parent);

    test(`${name}: declares its two moves under the row path`, () => {
      expect(list.writes).toEqual({
        [`${name}MoveAfter`]: `${list.rowPath}/move-after`,
        [`${name}MoveBefore`]: `${list.rowPath}/move-before`,
      });
    });

    test(`${name}: the arrows post to the row and name it as the server keys it`, () => {
      expect({
        anchor: column.anchor(sample.row),
        path: column.path(sample.row),
        serverKey: String(list.keyOf(params)),
      }).toEqual({
        anchor: sample.anchor,
        path: sample.path,
        serverKey: sample.anchor,
      });
    });

    test(`${name}: a move returns to the page that shows the list`, () => {
      expect([list.parentOf(params), list.listPathFor(params)]).toEqual([
        sample.parent,
        sample.listPath,
      ]);
    });

    test(`${name}: says what moved`, () => {
      expect(t(list.moved)).toBe(sample.moved);
    });
  }
});
