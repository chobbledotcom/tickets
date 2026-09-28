import { afterEach } from "@std/testing/bdd";
import type { Window } from "happy-dom";
import { initManualCheckin } from "#src/ui/client/admin/manual-checkin.ts";
import {
  createDomInstaller,
  type DomInstaller,
} from "#test-utils/happy-dom.ts";

const CHECKIN_FORM = `
  <form
    data-manual-checkin
    data-message-error="Check-in failed"
    data-message-network-error="Could not reach server"
    data-message-not-found="No matching ticket"
    data-message-refunded="{name} was refunded."
    data-message-ticket-count-one="{count} pass"
    data-message-ticket-count-other="{count} tickets"
    data-message-verify-id-note=" - check ID"
    data-scan-path="/admin/listing/7/scan"
  >
    <input id="manual-checkin-attendee-id" />
    <input id="manual-checkin-input" />
    <input name="csrf_token" value="csrf" />
    <div class="combobox-list hidden" id="ticket-options" role="listbox">
      <div data-attendee-id="11" data-name="Ada" data-quantity="2" role="option" tabindex="0">Ada (2 tickets)</div>
      <div data-attendee-id="12" data-name="Bea" data-quantity="1" role="option" tabindex="0">Bea (1 ticket)</div>
      <div data-attendee-id="13" data-name="Cy" data-quantity="3" role="option" tabindex="0">Cy (3 tickets)</div>
    </div>
    <p class="hidden checkin-status-error checkin-status-success checkin-status-warning" id="manual-checkin-status">Waiting</p>
    <button type="submit">Check in</button>
  </form>
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
      while (submitButton.disabled) await Promise.resolve();
      return event;
    },
    submitButton,
    window,
  };
};

export const useManualCheckinPage = (): {
  dom: DomInstaller;
  setup: () => ManualCheckinPage;
} => {
  const dom = createDomInstaller();
  afterEach(() => dom.cleanup());
  return { dom, setup: () => setupManualCheckin(dom) };
};
