import { afterEach } from "@std/testing/bdd";
import type { Window } from "happy-dom";
import { type ScannerWords, wordingOf } from "#shared/scanner-words.ts";
import { initManualCheckin } from "#src/ui/client/admin/manual-checkin.ts";
import type { ManualOffline } from "#src/ui/client/admin/manual-search.ts";
import { wordsWith } from "#test/ui/client/scanner/words.ts";
import {
  createDomInstaller,
  createGlobalStash,
  type DomInstaller,
  fireEvent,
  waitUntilSettled,
} from "#test-utils/happy-dom.ts";

/** The manual check-in's markup, as the scanner template renders it. The
 * confirm and quantity overlays sit beside it. */
const CHECKIN_FORM = `
  <form id="manual-checkin">
    <input id="manual-checkin-input" />
    <div class="combobox-list hidden" id="ticket-options" role="listbox"></div>
    <p class="hidden checkin-status-error checkin-status-success checkin-status-warning" id="manual-checkin-status">Waiting</p>
    <button id="manual-checkin-submit" type="submit"><span>Search</span></button>
  </form>
  <div class="scanner-overlay hidden" id="scanner-quantity">
    <div class="scanner-overlay-backdrop"></div>
    <div class="scanner-overlay-box">
      <p id="scanner-quantity-message"></p>
      <select id="scanner-quantity-select"></select>
      <button id="scanner-quantity-confirm" type="button">Check In</button>
      <button id="scanner-quantity-cancel" type="button">Cancel</button>
    </div>
  </div>
  <div class="hidden" id="scanner-confirm">
    <span id="scanner-confirm-message"></span>
    <button id="scanner-confirm-yes">Yes</button>
    <button id="scanner-confirm-no">No</button>
    <button id="scanner-confirm-close">Close</button>
  </div>
`;

/** The words these tests run on. Each one a test asserts differs from the
 * page's own, so a test proves the form shows the word it was handed. */
export const FORM_WORDS: ScannerWords = wordsWith({
  error: "Check-in failed",
  networkError: "Could not reach server",
  notFound: "No matching ticket",
  refunded: "{name} was refunded.",
  searchFailed: "The search failed.",
  searchNone: "Nobody matches.",
  searchTooShort: "Type more letters.",
  ticketCountOne: "{count} pass",
  ticketOptionDetail: "{name} ({tickets}) - {detail}",
});

/** The form's words as the operator's ticket-to-booking rebrand renders
 * them: the rebrand rewrites the catalog copy's prose only, so the
 * {tickets} holes the client fills keep their spelling. */
export const REBRANDED_WORDS: ScannerWords = {
  ...FORM_WORDS,
  checkedInPartial:
    "{name} checked in for {listingName} ({tickets} of {total} bookings)",
  notFound: "No matching booking",
  selectQuantity: "How many bookings for {name}?",
  ticketCountOther: "{count} bookings",
};

/** The people the fixture's own search finds: the search route's answer. */
export const FOUND_PEOPLE = [
  { attendeeId: 11, details: ["Camping · 12 Jun"], name: "Ada", quantity: 2 },
  { attendeeId: 12, details: [], name: "Bea", quantity: 1 },
  { attendeeId: 13, details: [], name: "Cy", quantity: 3 },
];

/** A full check-in answer for Ada at the Ceilidh, as the scan route sends
 * it. `overrides` changes the fields a test is about. */
export const checkedIn = (overrides: Record<string, unknown> = {}) => ({
  listingName: "Ceilidh",
  name: "Ada",
  quantity: 2,
  remaining: 0,
  status: "checked_in",
  total: 2,
  ...overrides,
});

/** An answer that says Ada is already checked in at the Ceilidh. */
export const alreadyIn = (overrides: Record<string, unknown> = {}) => ({
  listingName: "Ceilidh",
  name: "Ada",
  quantity: 2,
  status: "already_checked_in",
  total: 2,
  ...overrides,
});

export interface ManualCheckinPage {
  activeId: () => string | null;
  /** The words on the submit button: what the next submit does. */
  buttonLabel: () => string;
  form: HTMLFormElement;
  input: HTMLInputElement;
  keydown: (key: string) => { readonly defaultPrevented: boolean };
  listbox: HTMLElement;
  /** Pick the person whose option carries the attendee id. */
  pick: (attendeeId: string) => void;
  scrolledIds: string[];
  status: HTMLElement;
  submit: () => Promise<{ readonly defaultPrevented: boolean }>;
  submitButton: HTMLButtonElement;
  window: Window;
}

/** Install the page and wire its manual check-in, with no search yet. */
const installManualCheckin = (
  dom: DomInstaller,
  words: ScannerWords,
  offline: ManualOffline | null,
): ManualCheckinPage => {
  const window = dom.installDom(CHECKIN_FORM);
  const scrolledIds: string[] = [];
  window.HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
    scrolledIds.push(this.dataset.key!);
  };
  initManualCheckin({
    csrfToken: "csrf",
    offline,
    scanPath: "/admin/listing/7/scan",
    searchPath: "/admin/listing/7/scan-search",
    wording: wordingOf(words),
  });
  const input = document.querySelector<HTMLInputElement>(
    "#manual-checkin-input",
  )!;
  const form = document.querySelector<HTMLFormElement>("#manual-checkin")!;
  const submitButton = form.querySelector<HTMLButtonElement>(
    'button[type="submit"]',
  )!;
  const keydown = (key: string): { readonly defaultPrevented: boolean } => {
    const event = new window.KeyboardEvent("keydown", {
      cancelable: true,
      key,
    });
    fireEvent(input, event);
    return event;
  };
  const submit = async () => {
    const event = new window.Event("submit", {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(form, event);
    await waitUntilSettled(() => !submitButton.disabled, "the check-in");
    return event;
  };
  return {
    activeId: () =>
      document.querySelector<HTMLElement>(".combobox-active")?.dataset.key ??
      null,
    buttonLabel: () => String(submitButton.textContent).trim(),
    form,
    input,
    keydown,
    listbox: document.querySelector<HTMLElement>("#ticket-options")!,
    pick: (attendeeId) => {
      // A missing option makes fireEvent throw.
      const option = document.querySelector<HTMLElement>(
        `[data-key='${attendeeId}']`,
      )!;
      fireEvent(option, new window.Event("click", { bubbles: true }));
    },
    scrolledIds,
    status: document.querySelector<HTMLElement>("#manual-checkin-status")!,
    submit,
    submitButton,
    window,
  };
};

/** The page after a search that finds `FOUND_PEOPLE`. The page lists nobody
 * until the door searches, so the fixture searches, then closes the list.
 * Each test starts the way a door does after its search. */
const setupManualCheckin = async (
  dom: DomInstaller,
  words: ScannerWords,
): Promise<ManualCheckinPage> => {
  const ready = installManualCheckin(dom, words, null);
  const stash = createGlobalStash();
  stash.set("fetch", async () => Response.json({ options: FOUND_PEOPLE }));
  ready.input.value = "fixture search";
  await ready.submit();
  stash.restore();
  ready.input.value = "";
  ready.keydown("Escape");
  return ready;
};

export interface ManualCheckinHarness {
  dom: DomInstaller;
  /** The page before any search, wired to `offline`. */
  fresh: (offline: ManualOffline | null) => ManualCheckinPage;
  /** The page after its search, with the person `attendeeId` picked. */
  pickedPage: (attendeeId: string) => Promise<ManualCheckinPage>;
  setup: () => Promise<ManualCheckinPage>;
  /** Serve the given JSON answers to the scan API, one per POST, recording
   * each request body the page sends. */
  stubScans: (answers: Record<string, unknown>[]) => Record<string, unknown>[];
}

/** Install a fresh manual check-in page for each test in the current suite. */
export const useManualCheckinPage = (
  words: ScannerWords = FORM_WORDS,
): ManualCheckinHarness => {
  const dom = createDomInstaller();
  const stash = createGlobalStash();
  afterEach(async () => {
    await dom.cleanup();
    stash.restore();
  });
  return {
    dom,
    fresh: (offline) => installManualCheckin(dom, words, offline),
    pickedPage: async (attendeeId) => {
      const ready = await setupManualCheckin(dom, words);
      ready.pick(attendeeId);
      return ready;
    },
    setup: () => setupManualCheckin(dom, words),
    stubScans: (answers) => {
      const sent: Record<string, unknown>[] = [];
      let served = 0;
      stash.set("fetch", async (_url: string, init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const answer = answers[Math.min(served++, answers.length - 1)]!;
        return Response.json(answer);
      });
      return sent;
    },
  };
};
