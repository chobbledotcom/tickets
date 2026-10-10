import { afterEach } from "@std/testing/bdd";
import type { Window } from "happy-dom";
import { initManualCheckin } from "#src/ui/client/admin/manual-checkin.ts";
import {
  createDomInstaller,
  createGlobalStash,
  type DomInstaller,
} from "#test-utils/happy-dom.ts";

const CHECKIN_FORM = `
  <form
    data-manual-checkin
    data-message-already-checked-in="{name} already checked in for {listingName} ({tickets})"
    data-message-checked-in="{name} checked in for {listingName} ({tickets})"
    data-message-checked-in-partial="{name} checked in for {listingName} ({tickets} of {total} tickets)"
    data-message-error="Check-in failed"
    data-message-network-error="Could not reach server"
    data-message-not-found="No matching ticket"
    data-message-refunded="{name} was refunded."
    data-message-select-quantity="How many tickets for {name}?"
    data-message-skipped="Skipped {name}"
    data-message-ticket-count-one="{count} pass"
    data-message-ticket-count-other="{count} tickets"
    data-message-ticket-option="{name} ({tickets})"
    data-message-ticket-option-detail="{name} ({tickets}) - {detail}"
    data-message-verify-id-note=" - check ID"
    data-scan-path="/admin/listing/7/scan"
  >
    <input id="manual-checkin-attendee-id" />
    <input id="manual-checkin-input" />
    <input name="csrf_token" value="csrf" />
    <div class="combobox-list hidden" id="ticket-options" role="listbox">
      <div data-attendee-id="11" data-detail="Camping · 12 Jun" data-name="Ada" data-quantity="2" role="option" tabindex="0">Ada (2 tickets)</div>
      <div data-attendee-id="12" data-name="Bea" data-quantity="1" role="option" tabindex="0">Bea (1 ticket)</div>
      <div data-attendee-id="13" data-name="Cy" data-quantity="3" role="option" tabindex="0">Cy (3 tickets)</div>
    </div>
    <p class="hidden checkin-status-error checkin-status-success checkin-status-warning" id="manual-checkin-status">Waiting</p>
    <button type="submit">Check in</button>
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

export interface ManualCheckinPage {
  activeId: () => string | null;
  attendeeIdInput: HTMLInputElement;
  form: HTMLFormElement;
  input: HTMLInputElement;
  keydown: (key: string) => { readonly defaultPrevented: boolean };
  listbox: HTMLElement;
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

const setupManualCheckin = (dom: DomInstaller): ManualCheckinPage => {
  const window = dom.installDom(CHECKIN_FORM);
  const scrolledIds: string[] = [];
  window.HTMLElement.prototype.scrollIntoView = function () {
    scrolledIds.push((this as unknown as HTMLElement).dataset.attendeeId!);
  };
  initManualCheckin();
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
    input.dispatchEvent(event as unknown as Event);
    return event;
  };
  return {
    activeId: () =>
      document.querySelector<HTMLElement>(".combobox-active")?.dataset
        .attendeeId ?? null,
    attendeeIdInput: document.querySelector<HTMLInputElement>(
      "#manual-checkin-attendee-id",
    )!,
    form,
    input,
    keydown,
    listbox: document.querySelector<HTMLElement>("#ticket-options")!,
    scrolledIds,
    status: document.querySelector<HTMLElement>("#manual-checkin-status")!,
    submit: async () => {
      const event = new window.Event("submit", {
        bubbles: true,
        cancelable: true,
      });
      form.dispatchEvent(event as unknown as Event);
      await waitUntilSettled(() => !submitButton.disabled, "the check-in");
      return event;
    },
    submitButton,
    window,
  };
};

export interface ManualCheckinHarness {
  dom: DomInstaller;
  setup: () => ManualCheckinPage;
  /** Serve the given JSON answers to the scan API, one per POST, recording
   * each request body the page sends. */
  stubScans: (answers: Record<string, unknown>[]) => Record<string, unknown>[];
}

/** Install a fresh manual check-in page for each test in the current suite. */
export const useManualCheckinPage = (): ManualCheckinHarness => {
  const dom = createDomInstaller();
  const stash = createGlobalStash();
  afterEach(async () => {
    await dom.cleanup();
    stash.restore();
  });
  return {
    dom,
    setup: () => setupManualCheckin(dom),
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
