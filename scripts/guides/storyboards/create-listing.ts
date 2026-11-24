/**
 * The first guide: an organiser creates one listing and opens its public page.
 * Every action goes through the real admin form. The two evidence actions name
 * the Cucumber captures the video uses as its visual reference.
 *
 * The camera zooms into text fields only, and each focus includes the field's
 * label: the highlight covers the whole labelled row, not just the input.
 * Date, number, checkbox, card, and button interactions stay at the whole-page
 * view, so a zoom always means "type here" rather than merely "this is
 * clickable".
 */

import type { GuideStoryboard } from "../storyboard.ts";

/* jscpd:ignore-start -- a guide is a static list of real user actions */
export const createListingGuide: GuideStoryboard = {
  actions: [
    { kind: "click", selector: 'a[href="/admin/listing/new"]' },
    { kind: "wait", ms: 2500 },
    {
      kind: "click",
      selector: 'a[href="/admin/listing/new?template=custom"]',
    },
    { kind: "wait", ms: 700 },
    { kind: "focus", selector: 'label:has(input[name="name"])' },
    { kind: "wait", ms: 900 },
    { kind: "type", selector: 'input[name="name"]', text: "Pottery Evening" },
    { kind: "blur" },
    { kind: "focus", selector: 'label:has(textarea[name="description"])' },
    { kind: "wait", ms: 900 },
    {
      kind: "type",
      selector: ".md-editor .ProseMirror",
      text: "A relaxed evening of pottery. All tools and clay are included.",
    },
    { kind: "blur" },
    { kind: "fill", selector: 'input[name="dateDate"]', value: "2030-06-14" },
    { kind: "fill", selector: 'input[name="dateTime"]', value: "18:30" },
    { kind: "wait", ms: 800 },
    { kind: "focus", selector: 'label:has(input[name="location"])' },
    { kind: "wait", ms: 900 },
    {
      kind: "type",
      selector: 'input[name="location"]',
      text: "The Old Kiln, Bristol",
    },
    { kind: "blur" },
    { kind: "type", selector: 'input[name="maxAttendees"]', text: "20" },
    { kind: "type", selector: 'input[name="maxQuantity"]', text: "4" },
    { kind: "wait", ms: 600 },
    { kind: "focus", selector: 'label:has(input[name="unitPrice"])' },
    { kind: "wait", ms: 900 },
    { kind: "type", selector: 'input[name="unitPrice"]', text: "15.00" },
    { kind: "blur" },
    { kind: "check", selector: 'input[name="fields"][value="email"]' },
    { kind: "wait", ms: 500 },
    {
      captureId: "listing-form",
      caseId: "booking.group-page-journey",
      kind: "evidence",
    },
    { deltaY: 1400, kind: "scroll", settleMs: 130, steps: 10 },
    { kind: "blur" },
    { kind: "wait", ms: 2000 },
    {
      kind: "click",
      selector: 'form[action="/admin/listing"] button[type="submit"]',
    },
    { kind: "wait", ms: 1800 },
    { kind: "wait", ms: 1500 },
    {
      kind: "click",
      selector: 'a[href^="/admin/listing/"]:has-text("Pottery Evening")',
    },
    { kind: "wait", ms: 1200 },
    {
      kind: "openLink",
      selector: 'a[href*="/ticket/"]:not([href$="/qr"])',
    },
    { kind: "wait", ms: 1200 },
    {
      captureId: "public-booking-page",
      caseId: "minimum-quantity.choices-skip-below-the-minimum",
      kind: "evidence",
    },
    { kind: "wait", ms: 2000 },
  ],
  fps: 30,
  setup: [
    { kind: "open", path: "/admin/features/site" },
    { kind: "check", selector: 'input[name="enabled"][value="true"]' },
    {
      kind: "click",
      selector: 'form[action="/admin/features/site"] button[type="submit"]',
    },
    { kind: "wait", ms: 400 },
  ],
  slug: "create-a-listing",
  title: "Create a listing",
};
/* jscpd:ignore-end */
