import { afterEach } from "@std/testing/bdd";
import type { Window } from "happy-dom";
import { initManualCheckin } from "#src/ui/client/admin/manual-checkin.ts";
import type { ManualOffline } from "#src/ui/client/admin/manual-search.ts";
import {
  createDomInstaller,
  createGlobalStash,
  type DomInstaller,
  fireEvent,
} from "#test-utils/happy-dom.ts";
import { rebrandedPage } from "#test-utils/rebrand-page.ts";

const CHECKIN_FORM = `
  <form
    data-manual-checkin
    data-message-check-in-button="Check In"
    data-message-already-checked-in="{name} already checked in for {listingName} ({tickets})"
    data-message-checked-in="{name} checked in for {listingName} ({tickets})"
    data-message-checked-in-partial="{name} checked in for {listingName} ({tickets} of {total} tickets)"
    data-message-error="Check-in failed"
    data-message-network-error="Could not reach server"
    data-message-not-found="No matching ticket"
    data-message-refunded="{name} was refunded."
    data-message-search-button="Search"
    data-message-search-failed="The search failed."
    data-message-search-none="Nobody matches."
    data-message-search-too-short="Type more letters."
    data-message-select-quantity="How many tickets for {name}?"
    data-message-skipped="Skipped {name}"
    data-message-ticket-count-one="{count} pass"
    data-message-ticket-count-other="{count} tickets"
    data-message-ticket-option="{name} ({tickets})"
    data-message-ticket-option-detail="{name} ({tickets}) - {detail}"
    data-message-verify-id-note=" - check ID"
    data-scan-path="/admin/listing/7/scan"
  >
    <input id="manual-checkin-input" />
    <input name="csrfToken" value="csrf" />
    <div class="combobox-list hidden" id="ticket-options" role="listbox"></div>
    <p class="hidden checkin-status-error checkin-status-success checkin-status-warning" id="manual-checkin-status">Waiting</p>
    <button type="submit"><span>Search</span></button>
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

/** The manual form as the operator's ticket-to-booking rebrand renders it:
 * the rebrand rewrites the rendered catalog copy's prose only, so the
 * {tickets} holes the client fills keep their spelling. */
export const REBRANDED_FORM = rebrandedPage(CHECKIN_FORM, [
  ["How many tickets for {name}?", "How many bookings for {name}?"],
  ["({tickets} of {total} tickets)", "({tickets} of {total} bookings)"],
  [
    'data-message-ticket-count-other="{count} tickets"',
    'data-message-ticket-count-other="{count} bookings"',
  ],
  [
    'data-message-not-found="No matching ticket"',
    'data-message-not-found="No matching booking"',
  ],
]);

/** The people the fixture's own search finds: the search route's answer. */
export const FOUND_PEOPLE = [
  { attendeeId: 11, details: ["Camping · 12 Jun"], name: "Ada", quantity: 2 },
  { attendeeId: 12, details: [], name: "Bea", quantity: 1 },
  { attendeeId: 13, details: [], name: "Cy", quantity: 3 },
];

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

/** Wait until the page settles, or fail after a bounded number of turns. A
 * mutant that never answers the door would otherwise hang the whole run
 * instead of failing the one test. */
export const waitUntilSettled = async (
  settled: () => boolean,
  what: string,
): Promise<void> => {
  for (let turn = 0; turn < 1000; turn++) {
    if (settled()) return;
    await Promise.resolve();
  }
  throw new Error(`${what} never settled`);
};

/** Install the page and wire its manual check-in, with no search yet. */
const installManualCheckin = (
  dom: DomInstaller,
  page: string,
  offline: ManualOffline | null,
): ManualCheckinPage => {
  const window = dom.installDom(page);
  const scrolledIds: string[] = [];
  window.HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
    scrolledIds.push(this.dataset.attendeeId!);
  };
  initManualCheckin(offline);
  const input = document.querySelector<HTMLInputElement>(
    "#manual-checkin-input",
  )!;
  const form = document.querySelector<HTMLFormElement>(
    "[data-manual-checkin]",
  )!;
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
      document.querySelector<HTMLElement>(".combobox-active")?.dataset
        .attendeeId ?? null,
    buttonLabel: () => String(submitButton.textContent).trim(),
    form,
    input,
    keydown,
    listbox: document.querySelector<HTMLElement>("#ticket-options")!,
    pick: (attendeeId) => {
      // A missing option makes fireEvent throw.
      const option = document.querySelector<HTMLElement>(
        `[data-attendee-id='${attendeeId}']`,
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
  page: string,
): Promise<ManualCheckinPage> => {
  const ready = installManualCheckin(dom, page, null);
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
  page = CHECKIN_FORM,
): ManualCheckinHarness => {
  const dom = createDomInstaller();
  const stash = createGlobalStash();
  afterEach(async () => {
    await dom.cleanup();
    stash.restore();
  });
  return {
    dom,
    fresh: (offline) => installManualCheckin(dom, page, offline),
    pickedPage: async (attendeeId) => {
      const ready = await setupManualCheckin(dom, page);
      ready.pick(attendeeId);
      return ready;
    },
    setup: () => setupManualCheckin(dom, page),
    stubScans: (answers) => {
      const sent: Record<string, unknown>[] = [];
      let served = 0;
      stash.set("fetch", async (_url: string, init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const answer = answers[Math.min(served++, answers.length - 1)]!;
        return { json: async () => answer } as Response;
      });
      return sent;
    },
  };
};
