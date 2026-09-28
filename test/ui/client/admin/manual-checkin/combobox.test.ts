import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { initManualCheckin } from "#src/ui/client/admin/manual-checkin.ts";
import { useManualCheckinPage } from "./fixture.ts";

describe("manual check-in combobox", () => {
  const { dom, setup } = useManualCheckinPage();

  test("does nothing when the manual check-in form is absent", () => {
    dom.installDom("<p>Other page</p>");
    expect(() => initManualCheckin()).not.toThrow();
  });

  test("arrow keys move through visible options and wrap", () => {
    const page = setup();
    page.input.focus();
    page.input.value = "a";
    page.input.dispatchEvent(
      new page.window.Event("input") as unknown as Event,
    );

    const first = page.keydown("ArrowDown");
    expect(first.defaultPrevented).toBe(true);
    expect(page.activeId()).toBe("11");

    page.keydown("ArrowDown");
    expect(page.activeId()).toBe("12");
    page.keydown("ArrowDown");
    expect(page.activeId()).toBe("11");
    page.keydown("ArrowUp");
    expect(page.activeId()).toBe("12");
    expect(page.scrolledIds).toEqual(["11", "12", "11", "12"]);
  });

  test("ArrowUp moves to the prior option when three are visible", () => {
    const page = setup();
    page.input.focus();
    page.keydown("ArrowDown");

    page.keydown("ArrowUp");

    expect(page.activeId()).toBe("13");
  });

  test("arrow keys keep the active option when filtering hides every option", () => {
    const page = setup();
    page.input.focus();
    page.keydown("ArrowDown");
    page.input.value = "missing";
    page.input.dispatchEvent(
      new page.window.Event("input") as unknown as Event,
    );

    const arrow = page.keydown("ArrowDown");

    expect(arrow.defaultPrevented).toBe(true);
    expect(page.activeId()).toBe("11");
    expect(page.listbox.classList.contains("hidden")).toBe(true);
  });

  test("input filtering clears a selected attendee", () => {
    const page = setup();
    page.attendeeIdInput.value = "11";
    page.input.value = "Bea";

    page.input.dispatchEvent(
      new page.window.Event("input") as unknown as Event,
    );

    expect(page.attendeeIdInput.value).toBe("");
    expect(page.listbox.classList.contains("hidden")).toBe(true);
  });

  test("filtering treats an option without text as an empty label", () => {
    const page = setup();
    const option = document.querySelector<HTMLElement>(
      "[data-attendee-id='11']",
    )!;
    Object.defineProperty(option, "textContent", {
      configurable: true,
      value: null,
    });
    page.input.focus();
    page.input.value = "mutated";

    page.input.dispatchEvent(
      new page.window.Event("input") as unknown as Event,
    );

    expect(option.classList.contains("hidden")).toBe(true);
    expect(page.listbox.classList.contains("hidden")).toBe(true);
  });

  test("the option list only closes for clicks outside the combobox", () => {
    const page = setup();
    page.input.focus();
    expect(page.listbox.classList.contains("hidden")).toBe(false);
    expect(page.input.getAttribute("aria-expanded")).toBe("true");

    page.input.dispatchEvent(
      new page.window.Event("click", { bubbles: true }) as unknown as Event,
    );
    expect(page.listbox.classList.contains("hidden")).toBe(false);

    page.listbox.dispatchEvent(
      new page.window.Event("click", { bubbles: true }) as unknown as Event,
    );
    expect(page.listbox.classList.contains("hidden")).toBe(false);

    page.window.document.body.dispatchEvent(
      new page.window.Event("click", { bubbles: true }),
    );
    expect(page.listbox.classList.contains("hidden")).toBe(true);
  });

  test("clicking an option replaces the current selection", () => {
    const page = setup();
    page.attendeeIdInput.value = "99";
    page.input.value = "Old attendee";
    const option = document.querySelector<HTMLElement>(
      "[data-attendee-id='12']",
    )!;

    option.dispatchEvent(
      new page.window.Event("click", { bubbles: true }) as unknown as Event,
    );

    expect(page.attendeeIdInput.value).toBe("12");
    expect(page.input.value).toBe("Bea (1 pass)");
  });

  test("clicking an option uses the singular fallback message when unset", () => {
    const page = setup();
    delete page.form.dataset.messageTicketCountOne;
    const option = document.querySelector<HTMLElement>(
      "[data-attendee-id='12']",
    )!;

    option.dispatchEvent(
      new page.window.Event("click", { bubbles: true }) as unknown as Event,
    );

    expect(page.input.value).toBe("Bea (1 ticket)");
  });

  test("Enter selects the active option", () => {
    const page = setup();
    page.input.focus();
    page.keydown("ArrowDown");

    const enter = page.keydown("Enter");

    expect(enter.defaultPrevented).toBe(true);
    expect(page.attendeeIdInput.value).toBe("11");
    expect(page.input.value).toBe("Ada (2 tickets)");
    expect(page.listbox.classList.contains("hidden")).toBe(true);
    expect(page.input.getAttribute("aria-expanded")).toBe("false");
  });

  test("Enter keeps its default action when no option is active", () => {
    const page = setup();
    const enter = page.keydown("Enter");
    expect(enter.defaultPrevented).toBe(false);
    expect(page.attendeeIdInput.value).toBe("");
  });

  test("other keys keep their default action", () => {
    const page = setup();
    const tab = page.keydown("Tab");
    expect(tab.defaultPrevented).toBe(false);
    expect(page.activeId()).toBeNull();
  });

  test("Escape closes the option list", () => {
    const page = setup();
    page.input.focus();
    expect(page.listbox.classList.contains("hidden")).toBe(false);

    const escapeEvent = page.keydown("Escape");

    expect(escapeEvent.defaultPrevented).toBe(false);
    expect(page.listbox.classList.contains("hidden")).toBe(true);
    expect(page.input.getAttribute("aria-expanded")).toBe("false");
  });
});
