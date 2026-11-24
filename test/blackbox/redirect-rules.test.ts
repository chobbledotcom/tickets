/**
 * The addresses that an owner can save as a redirect. Each row is a from page
 * or a to page as typed, with what the list shows after the save or the
 * reason for the refusal.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import {
  addRedirect,
  deleteRedirect,
  expectNoRedirects,
  listedRedirects,
  refusalsOf,
  shopWith,
} from "#test/blackbox/redirects.ts";
import { describeWithEnv } from "#test-utils/db.ts";

type Row = readonly [string, string];

/* jscpd:ignore-start -- lists of strings, not code */
const FROM_KEPT: Row[] = [
  ["/old-page", "/old-page"],
  ["  /Old-Page/  ", "/old-page"],
  ["/ticket/Old-Slug", "/ticket/old-slug"],
  ["/", "/"],
  ["/a%20b", "/a%20b"],
  ["/administration", "/administration"],
];
const FROM_REFUSED: Row[] = [
  ["old-page", "from_not_a_path"],
  ["https://example.com/old", "from_not_a_path"],
  ["/old?x=1", "from_has_query"],
  ["/old#top", "from_has_query"],
  ["//evil.example/path", "from_unsafe"],
  ["/a\\b", "from_unsafe"],
  ["/a/../b", "from_unsafe"],
  ["/a/%2e%2e/b", "from_unsafe"],
  ["/a%5Cb", "from_unsafe"],
  ["/a%zz", "from_unsafe"],
  ["/a\nb", "from_unsafe"],
  ["/admin", "from_reserved"],
  ["/admin/settings", "from_reserved"],
  ["/ADMIN/x", "from_reserved"],
  ["/api/admin/listings", "from_reserved"],
];
const TO_KEPT: Row[] = [
  ["/new-page", "/new-page"],
  ["/new-page?x=1#top", "/new-page?x=1#top"],
  ["/", "/"],
  ["/日本語?q=ü#x", "/%E6%97%A5%E6%9C%AC%E8%AA%9E?q=%C3%BC#x"],
  ["/a b", "/a%20b"],
  ["https://example.com/new", "https://example.com/new"],
  ["http://example.com", "http://example.com/"],
  ["HTTPS://Example.COM/A?b=c#d", "https://example.com/A?b=c#d"],
  ["https://example.com/日本", "https://example.com/%E6%97%A5%E6%9C%AC"],
];
const TO_REFUSED: Row[] = [
  ["//evil.example", "to_unsafe"],
  ["/a/../b", "to_unsafe"],
  ["/a\\b", "to_unsafe"],
  ["/a\r\nSet-Cookie: x=1", "to_unsafe"],
  ["https://user:pass@example.com", "to_unsafe"],
  ["https://user@example.com", "to_unsafe"],
  ["javascript:alert(1)", "to_not_http"],
  ["data:text/html,hi", "to_not_http"],
  ["ftp://example.com", "to_not_http"],
  ["mailto:a@example.com", "to_not_http"],
  ["example.com/page", "to_not_http"],
  ["not a url", "to_not_http"],
];
/* jscpd:ignore-end */

type Shop = Awaited<ReturnType<typeof shopWith>>;
type Pair = [string, string];

/** The row that the list shows after each add, with each add undone. */
const savedAs = async (app: Shop, pairs: Pair[]): Promise<Pair[]> => {
  const saved: Pair[] = [];
  for (const pair of pairs) {
    await addRedirect(app, ...pair);
    const [row] = await listedRedirects(app);
    await deleteRedirect(app, row![0]);
    saved.push(row!);
  }
  return saved;
};

/** What each box holds for one typed address: the from box with a safe to
 *  page, or the to box with a safe from page. */
const inFromBox = ([typed]: Row): Pair => [typed, "https://example.com/t"];
const inToBox = ([typed]: Row): Pair => ["/src", `  ${typed} `];

/** The row that the list shows for a kept address, and the message that a
 *  refusal shows. */
const keptFrom = ([, key]: Row): Pair => [key, "https://example.com/t"];
const keptTo = ([, saved]: Row): Pair => ["/src", saved];
const messageOf = ([, reason]: Row): string =>
  t(`redirects.error.${reason}`, { max: 250 });

describeWithEnv("the addresses a redirect can name", { db: true }, () => {
  const KEPT: [string, Row[], (row: Row) => Pair, (row: Row) => Pair][] = [
    [
      "a from page is saved in lower case, with no slash at its end",
      FROM_KEPT,
      inFromBox,
      keptFrom,
    ],
    [
      "a to page is saved as a valid address, with its characters encoded",
      TO_KEPT,
      inToBox,
      keptTo,
    ],
  ];
  const REFUSED: [string, Row[], (row: Row) => Pair][] = [
    [
      "a from page is refused with its reason when it is not a page of this site",
      FROM_REFUSED,
      (row) => [row[0], "/b"],
    ],
    [
      "a to page is refused with its reason when it is unsafe or not a web address",
      TO_REFUSED,
      inToBox,
    ],
  ];

  for (const [title, rows, put, kept] of KEPT) {
    test(title, async () => {
      expect(await savedAs(await shopWith(), rows.map(put))).toEqual(
        rows.map(kept),
      );
    });
  }

  for (const [title, rows, put] of REFUSED) {
    test(title, async () => {
      const app = await shopWith();
      expect(await refusalsOf(app, rows.map(put))).toEqual(rows.map(messageOf));
      await expectNoRedirects(app);
    });
  }
});
