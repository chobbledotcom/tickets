/**
 * The order of a record's images, set on its Images tab with the arrows or a
 * drop. A listing shows its images as cards inside the Images form, so each
 * arrow is a button of that form, and a drop moves the card in the form for
 * Save to store. A group shows them in a table, with an arrow form on each
 * row, and a drop posts the same move as an arrow.
 */

import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { SORTABLE_MOVED } from "#src/ui/client/admin/sortable.ts";
import { type App, createApp, inProcess } from "#test/blackbox/driver.ts";
import {
  addGroup,
  addImage,
  addListing,
  openApi,
} from "#test/blackbox/seed.ts";
import { openSortablePage } from "#test/blackbox/sortable-page.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createDomInstaller, requireElement } from "#test-utils/happy-dom.ts";

/** The image ids in the order a page shows them, read off the handles. */
const shownIds = (html: string): number[] =>
  [...html.matchAll(/data-sortable-path="[^"]*\/images\/(\d+)"/g)].map(
    (match) => Number(match[1]),
  );

/** A record with three images, A, B and C in that order, and the path of its
 *  Images tab. */
type ImagedRecord = { app: App; images: number[]; tab: string };

const withImages = async (kind: "group" | "listing"): Promise<ImagedRecord> => {
  const app = createApp(inProcess);
  await app.logIn();
  const api = await openApi(app);
  const id =
    kind === "listing"
      ? (await addListing(api, { max_attendees: 10, name: "Pottery" })).id
      : await addGroup(api, "Workshops");
  const item = { item_id: id, item_type: kind };
  const images = [
    await addImage(api, "A", item),
    await addImage(api, "B", item),
    await addImage(api, "C", item),
  ];
  const base = kind === "listing" ? "/admin/listing" : "/admin/groups";
  return { app, images, tab: `${base}/${id}/images` };
};

/** Press the move a picture offers on the tab, naming another anchor when
 *  the move is a drop. */
const move = (
  { app, tab }: ImagedRecord,
  image: number,
  place: string,
  fields: Record<string, string> = {},
) => app.submit(tab, fields, `${tab}/${image}/move-${place}`);

describeWithEnv("image order", { db: true, storage: "local" }, () => {
  const dom = createDomInstaller();
  afterEach(() => dom.cleanup());

  for (const kind of ["listing", "group"] as const) {
    test(`a ${kind}'s up arrow moves an image before the one above`, async () => {
      const record = await withImages(kind);
      const [a, b, c] = record.images;

      const moved = await move(record, c!, "before");

      expect(moved.location).toMatch(new RegExp(`^${record.tab}\\?flash=`));
      expect(shownIds((await record.app.get(record.tab)).html)).toEqual([
        a,
        c,
        b,
      ]);
    });

    test(`a ${kind}'s drop moves an image several places`, async () => {
      const record = await withImages(kind);
      const [a, b, c] = record.images;

      await move(record, a!, "after", { anchor: String(c) });

      expect(shownIds((await record.app.get(record.tab)).html)).toEqual([
        b,
        c,
        a,
      ]);
    });
  }

  test("a drop on the left half of a card puts the image before it in the form, and posts nothing", async () => {
    const record = await withImages("listing");
    const [a, b, c] = record.images;
    const page = openSortablePage(
      dom,
      (await record.app.get(record.tab)).html,
      {
        across: true,
        selector: '[data-sortable="grid"]',
      },
    );
    const list = requireElement<HTMLElement>(
      page.document,
      '[data-sortable="grid"]',
    );
    let moves = 0;
    list.addEventListener(SORTABLE_MOVED, () => {
      moves += 1;
    });

    page.drag({ item: 2, steps: [["pointermove", 5], ["pointerup"]] });

    expect({
      moves,
      sent: page.sent,
      shown: shownIds(page.document.body.innerHTML),
    }).toEqual({ moves: 1, sent: [], shown: [c, a, b] });
  });

  test("a drop on the right half of a card puts the image after it", async () => {
    const record = await withImages("listing");
    const [a, b, c] = record.images;
    const page = openSortablePage(
      dom,
      (await record.app.get(record.tab)).html,
      { across: true, selector: '[data-sortable="grid"]' },
    );

    page.drag({ item: 0, steps: [["pointermove", 55], ["pointerup"]] });

    expect(shownIds(page.document.body.innerHTML)).toEqual([b, c, a]);
  });

  test("the listing's cards are a sortable grid inside the Images form", async () => {
    const record = await withImages("listing");

    const html = (await record.app.get(record.tab)).html;

    expect(html).toMatch(
      /<form[^>]*action="\/admin\/listing\/\d+\/images"[\s\S]*data-sortable="grid" data-sortable-drop="local"[\s\S]*formaction="[^"]*\/move-before"[\s\S]*<\/form>/,
    );
  });
});
