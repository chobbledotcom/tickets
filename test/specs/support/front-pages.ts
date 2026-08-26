/**
 * The pages the public site opens on — the homepage, the contact page, and
 * the order page. The visitor's half is read by somebody never signed in,
 * because these pages exist for exactly that person.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import {
  newcomerReading,
  openAdminPage,
  organiserPressesOnPage,
  type PageRead,
} from "#test/specs/support/browser.ts";
import { requireCheckboxOffered } from "#test/specs/support/form-controls/reading.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

// jscpd:ignore-end

/** One front-page editor, driven the same way for each page: the public site
 * on, the form filled in from the page the site serves, and what the owner
 * was told kept for the story to read. */
const writesFrontPage = async (
  world: TicketsWorld,
  path: string,
  values: Record<string, string>,
): Promise<void> => {
  await enablePublicSite();
  await organiserPressesOnPage(world, path, "Save", values);
};

export const ownerWritesHomepage = (
  world: TicketsWorld,
  title: string,
  welcome: string,
): Promise<void> =>
  writesFrontPage(world, "/admin/site", {
    homepage_text: welcome,
    website_title: title,
  });

export const ownerWritesContactPage = (
  world: TicketsWorld,
  text: string,
): Promise<void> =>
  writesFrontPage(world, "/admin/site/contact", { contact_page_text: text });

/** The owner turns the order page on and writes its introduction. The page
 * carries two forms behind the same Save wording; each send goes through the
 * form that really renders the field being filled in. */
export const ownerTurnsOrderPageOn = async (
  world: TicketsWorld,
  intro: string,
): Promise<void> => {
  await enablePublicSite();
  const browser = await openAdminPage(world, "/admin/site/order");
  // The tick only counts if the page's own box really sends "true" — the
  // value the route reads — not a value the story made up.
  requireCheckboxOffered(browser.currentHtml, "order_enabled", "true");
  await fillInAndSend(browser, { order_enabled: "true" }, "Save");
  expect(browser.pageText).toContain("Order page enabled");
  await fillInAndSend(browser, { order_intro_text: intro }, "Save");
  expect(browser.pageText).toContain("Order page updated");
};

/** What a visitor on one of the front pages is shown — nothing more. The
 * scenario's own setup decides whether the site is on, so a save that broke
 * the site would fail here rather than being quietly repaired. */
export const visitorOnFrontPage = (path: string): Promise<PageRead> =>
  newcomerReading(path);
