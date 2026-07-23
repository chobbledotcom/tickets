import { afterEach } from "@std/testing/bdd";
import type { Window } from "happy-dom";
import { initManualCheckin } from "#src/ui/client/admin/manual-checkin.ts";
import {
  createDomInstaller,
  type DomInstaller,
} from "#test-utils/happy-dom.ts";

const CHECKIN_FORM = `
  <form
    data-listing-id="7"
    data-manual-checkin
    data-message-error="Check-in failed"
    data-message-network-error="Could not reach server"
    data-message-not-found="No matching ticket"
    data-message-refunded="{name} was refunded."
    data-message-ticket-count-one="{count} pass"
    data-message-ticket-count-other="{count} tickets"
    data-message-verify-id-note=" - check ID"
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
}

/** Install a fresh manual check-in page for each test in the current suite. */
export const useManualCheckinPage = (): ManualCheckinHarness => {
  const dom = createDomInstaller();
  afterEach(() => dom.cleanup());
  return { dom, setup: () => setupManualCheckin(dom) };
};
