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
    data-message-verify-id-note=" - check ID"
    data-scan-path="/admin/listing/7/scan"
  >
    <input id="manual-checkin-input" />
    <input id="manual-checkin-token" />
    <input name="csrf_token" value="csrf" />
    <ul class="hidden" id="ticket-options">
      <li data-name="Ada" data-quantity="2" data-token="ada" role="option">Ada</li>
      <li data-name="Bea" data-quantity="1" data-token="bea" role="option">Bea</li>
      <li data-name="Cy" data-quantity="3" data-token="cy" role="option">Cy</li>
    </ul>
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
`;

export interface ManualCheckinPage {
  activeToken: () => string | null;
  form: HTMLFormElement;
  input: HTMLInputElement;
  keydown: (key: string) => { readonly defaultPrevented: boolean };
  listbox: HTMLElement;
  scrolledTokens: string[];
  status: HTMLElement;
  submit: () => Promise<{ readonly defaultPrevented: boolean }>;
  submitButton: HTMLButtonElement;
  tokenInput: HTMLInputElement;
  window: Window;
}

const setupManualCheckin = (dom: DomInstaller): ManualCheckinPage => {
  const window = dom.installDom(CHECKIN_FORM);
  const scrolledTokens: string[] = [];
  window.HTMLElement.prototype.scrollIntoView = function () {
    scrolledTokens.push((this as unknown as HTMLElement).dataset.token!);
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
  const tokenInput = document.querySelector<HTMLInputElement>(
    "#manual-checkin-token",
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
    activeToken: () =>
      document.querySelector<HTMLElement>(".combobox-active")?.dataset.token ??
      null,
    form,
    input,
    keydown,
    listbox: document.querySelector<HTMLElement>("#ticket-options")!,
    scrolledTokens,
    status: document.querySelector<HTMLElement>("#manual-checkin-status")!,
    submit: async () => {
      const event = new window.Event("submit", { cancelable: true });
      form.dispatchEvent(event as unknown as Event);
      while (submitButton.disabled) await Promise.resolve();
      return event;
    },
    submitButton,
    tokenInput,
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
