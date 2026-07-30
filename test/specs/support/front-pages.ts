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
  type PageRead,
  submitRenderedAdminForm,
} from "#test/specs/support/browser.ts";
import {
  fillInAndSend,
  whyValueCannotBeSent,
} from "#test/specs/support/form-controls.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { adminFormPost } from "#test-utils/session.ts";
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
  const browser = await submitRenderedAdminForm(world, path, "Save", values);
  world.ownerTold = browser.pageText;
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
 * carries two saves — the switch and the words — and both go through what the
 * served page really offers. */
export const ownerTurnsOrderPageOn = async (
  world: TicketsWorld,
  intro: string,
): Promise<void> => {
  await enablePublicSite();
  const browser = await openAdminPage(world, "/admin/site/order");
  await fillInAndSend(browser, { order_enabled: "true" }, "Save");
  expect(browser.pageText).toContain("Order page enabled");
  // The introduction lives in the page's second form, behind the same Save
  // wording as the switch, so it is sent the way the served form describes it
  // rather than through a button the harness cannot tell apart.
  expect(
    whyValueCannotBeSent(browser.currentHtml, "order_intro_text", intro),
  ).toBeNull();
  const { response } = await adminFormPost("/admin/site/order", {
    order_intro_text: intro,
  });
  expect(response.status).toBe(302);
};

/** What a visitor on one of the front pages is shown. */
export const visitorOnFrontPage = async (path: string): Promise<PageRead> => {
  await enablePublicSite();
  return newcomerReading(path);
};
