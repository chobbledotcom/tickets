import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { initManualCheckin } from "#src/ui/client/admin/manual-checkin.ts";
import { fireEvent } from "#test-utils/happy-dom.ts";
import { useManualCheckinPage } from "./fixture.ts";

describe("manual check-in combobox", () => {
  const { dom, pickedPage, setup } = useManualCheckinPage();

  test("does nothing when the manual check-in form is absent", () => {
    dom.installDom("<p>Other page</p>");
    expect(() => initManualCheckin(null)).not.toThrow();
  });

  test("arrow keys move through visible options and wrap", async () => {
    const page = await setup();
    page.input.focus();
    page.input.value = "a";
    fireEvent(page.input, new page.window.Event("input"));

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

  test("ArrowUp moves to the prior option when three are visible", async () => {
    const page = await setup();
    page.input.focus();
    page.keydown("ArrowDown");

    page.keydown("ArrowUp");

    expect(page.activeId()).toBe("13");
  });

  test("arrow keys keep the active option when filtering hides every option", async () => {
    const page = await setup();
    page.input.focus();
    page.keydown("ArrowDown");
    page.input.value = "missing";
    fireEvent(page.input, new page.window.Event("input"));

    const arrow = page.keydown("ArrowDown");

    expect(arrow.defaultPrevented).toBe(true);
    expect(page.activeId()).toBe("11");
    expect(page.listbox.classList.contains("hidden")).toBe(true);
  });

  test("input filtering clears a selected attendee", async () => {
    const page = await pickedPage("11");
    page.input.value = "Bea";

    fireEvent(page.input, new page.window.Event("input"));

    expect(page.buttonLabel()).toBe("Search");
    expect(page.listbox.classList.contains("hidden")).toBe(true);
  });

  test("filtering treats an option without text as an empty label", async () => {
    const page = await setup();
    const option = document.querySelector<HTMLElement>(
      "[data-attendee-id='11']",
    )!;
    Object.defineProperty(option, "textContent", {
      configurable: true,
      value: null,
    });
    page.input.focus();
    page.input.value = "mutated";

    fireEvent(page.input, new page.window.Event("input"));

    expect(option.classList.contains("hidden")).toBe(true);
    expect(page.listbox.classList.contains("hidden")).toBe(true);
  });

  test("the option list only closes for clicks outside the combobox", async () => {
    const page = await setup();
    page.input.focus();
    expect(page.listbox.classList.contains("hidden")).toBe(false);
    expect(page.input.getAttribute("aria-expanded")).toBe("true");

    fireEvent(page.input, new page.window.Event("click", { bubbles: true }));
    expect(page.listbox.classList.contains("hidden")).toBe(false);

    fireEvent(page.listbox, new page.window.Event("click", { bubbles: true }));
    expect(page.listbox.classList.contains("hidden")).toBe(false);

    page.window.document.body.dispatchEvent(
      new page.window.Event("click", { bubbles: true }),
    );
    expect(page.listbox.classList.contains("hidden")).toBe(true);
  });

  test("clicking an option replaces the current selection", async () => {
    const page = await pickedPage("11");
    expect(page.input.value).toBe("Ada (2 tickets) — Camping · 12 Jun");
    const option = document.querySelector<HTMLElement>(
      "[data-attendee-id='12']",
    )!;

    fireEvent(option, new page.window.Event("click", { bubbles: true }));

    expect(page.buttonLabel()).toBe("Check In");
    expect(page.input.value).toBe("Bea (1 pass)");
  });

  test("a pick carries its day and listing beside the name", async () => {
    const page = await setup();
    const option = document.querySelector<HTMLElement>(
      "[data-attendee-id='11']",
    )!;

    fireEvent(option, new page.window.Event("click", { bubbles: true }));

    expect(page.buttonLabel()).toBe("Check In");
    expect(page.input.value).toBe("Ada (2 tickets) — Camping · 12 Jun");
  });

  test("clicking an option uses the singular fallback message when unset", async () => {
    const page = await setup();
    delete page.form.dataset.messageTicketCountOne;
    const option = document.querySelector<HTMLElement>(
      "[data-attendee-id='12']",
    )!;

    fireEvent(option, new page.window.Event("click", { bubbles: true }));

    expect(page.input.value).toBe("Bea (1 ticket)");
  });

  test("Enter selects the active option", async () => {
    const page = await setup();
    page.input.focus();
    page.keydown("ArrowDown");

    const enter = page.keydown("Enter");

    expect(enter.defaultPrevented).toBe(true);
    expect(page.buttonLabel()).toBe("Check In");
    expect(page.input.value).toBe("Ada (2 tickets) — Camping · 12 Jun");
    expect(page.listbox.classList.contains("hidden")).toBe(true);
    expect(page.input.getAttribute("aria-expanded")).toBe("false");
  });

  test("Enter keeps its default action when no option is active", async () => {
    const page = await setup();
    const enter = page.keydown("Enter");
    expect(enter.defaultPrevented).toBe(false);
    expect(page.buttonLabel()).toBe("Search");
  });

  test("other keys keep their default action", async () => {
    const page = await setup();
    const tab = page.keydown("Tab");
    expect(tab.defaultPrevented).toBe(false);
    expect(page.activeId()).toBeNull();
  });

  test("Escape closes the option list", async () => {
    const page = await setup();
    page.input.focus();
    expect(page.listbox.classList.contains("hidden")).toBe(false);

    const escapeEvent = page.keydown("Escape");

    expect(escapeEvent.defaultPrevented).toBe(false);
    expect(page.listbox.classList.contains("hidden")).toBe(true);
    expect(page.input.getAttribute("aria-expanded")).toBe("false");
  });
});
