/**
 * Ticking or clearing one box on the page in front of the browser and saving
 * it: the box's own value is read off the page, a tick only lands on a box
 * that started clear, a clear only on one that started ticked, and a save
 * that silently dropped the box fails here.
 */

// jscpd:ignore-start
import { AssertionError } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { sendOneBox } from "#test/specs/support/form-controls.ts";
import { recordingBrowser } from "#test-utils/test-browser/helpers.ts";

// jscpd:ignore-end

describe("sending one box", () => {
  const BOX = "hidden";
  const box = (attributes = "") =>
    `<input type="checkbox" name="${BOX}" value="shy"${attributes}>`;
  const CLEAR = box();
  const TICKED = box(" checked");
  const NO_BOX = "";

  /** One page: an editor's form holding one box and its save button. */
  const page = (box: string) =>
    `<form action="/save" method="POST">${box}<button>${t("common.save_changes")}</button></form>`;

  /** One save through a page holding `box`: what the site received. */
  const save = async (box: string, tick: boolean) => {
    const html = page(box);
    const { browser, sent } = recordingBrowser();
    browser.currentHtml = html;
    await sendOneBox(browser, html, BOX, tick);
    return new URLSearchParams(sent().body);
  };

  /** The two ways a box can move, each proved by what reached the site: the
   * page's own value riding the editor's save, or nothing at all for it. */
  for (const way of [
    {
      box: CLEAR,
      received: ["shy"],
      tick: true,
      what: "ticks a box that started clear, sending the page's own value",
    },
    {
      box: TICKED,
      received: [],
      tick: false,
      what: "clears a box that started ticked, sending nothing for it",
    },
  ]) {
    test(way.what, async () => {
      expect((await save(way.box, way.tick)).getAll(BOX)).toEqual(way.received);
    });
  }

  /** The refusals: a box moved the way it already stands, or no box on the
   * page at all. Each fails loudly, and the site receives nothing. */
  for (const way of [
    {
      box: TICKED,
      message: undefined,
      tick: true,
      what: "refuses to tick a box that is ticked already",
    },
    {
      box: CLEAR,
      message: undefined,
      tick: false,
      what: "refuses to clear a box that is clear already",
    },
    {
      box: NO_BOX,
      message: `The page offers no ${BOX} box to tick`,
      tick: true,
      what: "refuses a box the page does not offer at all",
    },
  ]) {
    test(way.what, async () => {
      const { browser, sent } = recordingBrowser();
      browser.currentHtml = page(way.box);
      await expect(
        sendOneBox(browser, browser.currentHtml, BOX, way.tick),
      ).rejects.toThrow(way.message ?? AssertionError);
      expect(sent().body).toBe("");
    });
  }
});
