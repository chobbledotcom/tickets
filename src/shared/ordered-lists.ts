// effects: pure
/**
 * Every ordered admin list, by name. Each entry is the one declaration of its
 * list. The admin routes list, the move routes and the pages read it.
 */

import {
  type IdRow,
  type OrderedListSpec,
  orderedListSpec,
} from "#shared/ordered-list.ts";
import type { ImageUseItemType, SitePageItemType } from "#types";

/** The paths and message of a list whose rows go by their own id. */
type IdListPaths = {
  readonly listPath: string;
  readonly moved: string;
  readonly rowPath: string;
};

/* jscpd:ignore-start -- static data, not code */
const ID_LISTS = {
  answer: {
    listPath: "/admin/questions/:id",
    moved: "questions.answer_moved",
    rowPath: "/admin/questions/:id/answers/:answerId",
  },
  attribute: {
    listPath: "/admin/attributes",
    moved: "attributes.moved",
    rowPath: "/admin/attributes/:id",
  },
  attributeOption: {
    listPath: "/admin/attributes/:id",
    moved: "attributes.option_moved",
    rowPath: "/admin/attributes/:id/options/:optionId",
  },
  groupImage: {
    listPath: "/admin/groups/:id/images",
    moved: "images.item.moved",
    rowPath: "/admin/groups/:id/images/:imageId",
  },
  listing: {
    listPath: "/admin/listings",
    moved: "listings_table.moved",
    rowPath: "/admin/listing/:id",
  },
  listingImage: {
    listPath: "/admin/listing/:id/images",
    moved: "images.item.moved",
    rowPath: "/admin/listing/:id/images/:imageId",
  },
  newsImage: {
    listPath: "/admin/site/news/:id/images",
    moved: "images.item.moved",
    rowPath: "/admin/site/news/:id/images/:imageId",
  },
  question: {
    listPath: "/admin/questions",
    moved: "questions.moved",
    rowPath: "/admin/questions/:id",
  },
  sitePage: {
    listPath: "/admin/site/pages",
    moved: "site.pages.moved",
    rowPath: "/admin/site/pages/:id",
  },
  sitePageImage: {
    listPath: "/admin/site/pages/:id/images",
    moved: "images.item.moved",
    rowPath: "/admin/site/pages/:id/images/:imageId",
  },
  status: {
    listPath: "/admin/settings/statuses",
    moved: "statuses.moved",
    rowPath: "/admin/settings/statuses/:id",
  },
} as const satisfies Record<string, IdListPaths>;
/* jscpd:ignore-end */

/** The lists whose rows go by their own id, each named by its key. */
type IdLists = {
  readonly [Name in keyof typeof ID_LISTS & string]: OrderedListSpec<
    Name,
    (typeof ID_LISTS)[Name]["rowPath"],
    IdRow,
    number
  >;
};

const idLists = Object.fromEntries(
  Object.entries(ID_LISTS).map(([name, paths]) => [
    name,
    orderedListSpec({ ...paths, name }),
  ]),
) as IdLists;

/** One item on a site page: what kind of record, and which one. */
type PageItemRow = { readonly id: number; readonly type: SitePageItemType };

export const ORDERED_LISTS = {
  ...idLists,
  sitePageItem: orderedListSpec({
    keyOf: (params) => `${params.itemType}:${params.itemId}`,
    listPath: "/admin/site/pages/:id/items",
    moved: "site.pages.moved",
    name: "sitePageItem",
    paramsOf: (item: PageItemRow, pageId) => ({
      id: pageId,
      itemId: item.id,
      itemType: item.type,
    }),
    rowPath: "/admin/site/pages/:id/items/:itemType/:itemId",
  }),
} as const;

/** The ordered images of each kind of record that has an Images tab. */
export const IMAGE_ORDERS = {
  group: ORDERED_LISTS.groupImage,
  listing: ORDERED_LISTS.listingImage,
  news: ORDERED_LISTS.newsImage,
  page: ORDERED_LISTS.sitePageImage,
} as const satisfies Record<ImageUseItemType, object>;
