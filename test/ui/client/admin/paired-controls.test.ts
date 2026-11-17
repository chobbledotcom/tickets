import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { initPairedControls } from "#src/ui/client/admin/paired-controls.ts";
import { createDomInstaller, requireElement } from "#test-utils/happy-dom.ts";

describe("paired controls", () => {
  const dom = createDomInstaller();
  afterEach(() => dom.cleanup());

  /** The two paired checkbox labels installed onto the DOM, with the script
   *  wired and both neighbours handed back. */
  const setupPair = () => {
    const window = dom.installDom(`
      <form>
        <label><input type="checkbox" name="isReservation"
               data-exclusive-with="isPaidDefault"
               data-exclusive-why="A paid status can't also be a reservation">
               Reservation</label>
        <label><input type="checkbox" name="isPaidDefault"
               data-exclusive-with="isReservation"
               data-exclusive-why="A paid status can't also be a reservation">
               Paid</label>
      </form>
    `);
    // A double initialisation meets the holder it already built and reuses it.
    initPairedControls();
    initPairedControls();
    const input = (name: string) =>
      requireElement<HTMLInputElement>(
        window.document,
        `input[name="${name}"]`,
      );
    return {
      paid: input("isPaidDefault"),
      reservation: input("isReservation"),
      window,
    };
  };

  /** Holds the control, fires its change, and hands back the why holder. */
  const whyHolder = (control: HTMLInputElement) => {
    control.checked = true;
    control.dispatchEvent(new Event("change"));
    return requireElement<HTMLElement>(
      control.closest("label")!,
      ".exclusive-why",
    );
  };

  test("holding one control of a pair disables the counterpart and shows why", () => {
    const { paid, reservation } = setupPair();

    paid.checked = true;
    paid.dispatchEvent(new Event("change"));

    expect(reservation.disabled).toBe(true);
    const why = whyHolder(paid);
    expect(why.hidden).toBe(false);
    expect(why.textContent).toBe("A paid status can't also be a reservation");
    // Only the held side shows why; the freed side's holder stays hidden.
    const reservationWhy = requireElement<HTMLElement>(
      reservation.closest("label")!,
      ".exclusive-why",
    );
    expect(reservationWhy.hidden).toBe(true);

    paid.checked = false;
    paid.dispatchEvent(new Event("change"));

    expect(reservation.disabled).toBe(false);
    expect(why.hidden).toBe(true);
  });

  test("a control whose counterpart never renders stays alone", () => {
    const window = dom.installDom(`
      <form>
        <label><input type="checkbox" name="lonely"
               data-exclusive-with="missing"> Lonely</label>
      </form>
    `);

    initPairedControls();

    const lonely = requireElement<HTMLInputElement>(
      window.document,
      'input[name="lonely"]',
    );
    expect(lonely.disabled).toBe(false);
    expect(lonely.closest("label")!.querySelector(".exclusive-why")).toBeNull();
  });

  test("a pair without a why renders its holder without a reason", () => {
    const window = dom.installDom(`
      <form>
        <label><input type="checkbox" name="customisableDays"
               data-exclusive-with="canPayMore"> Days</label>
        <label><input type="checkbox" name="canPayMore"
               data-exclusive-with="customisableDays"> Pay more</label>
      </form>
    `);

    initPairedControls();

    const days = requireElement<HTMLInputElement>(
      window.document,
      'input[name="customisableDays"]',
    );
    expect(whyHolder(days).textContent).toBe("");
  });

  test("a control the server rendered already checked holds its counterpart at once", () => {
    const window = dom.installDom(`
      <form>
        <label><input type="checkbox" name="customisableDays" checked
               data-exclusive-with="canPayMore"
               data-exclusive-why="These cannot combine"> Days</label>
        <label><input type="checkbox" name="canPayMore"
               data-exclusive-with="customisableDays"> Pay more</label>
      </form>
    `);

    initPairedControls();

    const payMore = requireElement<HTMLInputElement>(
      window.document,
      'input[name="canPayMore"]',
    );
    expect(payMore.disabled).toBe(true);
  });

  test("a conflict the server re-rendered keeps both controls editable, and stays resolved", () => {
    const window = dom.installDom(`
      <form>
        <label><input type="checkbox" name="isReservation" checked
               data-exclusive-with="isPaidDefault"
               data-exclusive-why="A paid status can't also be a reservation">
               Reservation</label>
        <label><input type="checkbox" name="isPaidDefault" checked
               data-exclusive-with="isReservation"
               data-exclusive-why="A paid status can't also be a reservation">
               Paid</label>
      </form>
    `);

    initPairedControls();

    const pick = (name: string) =>
      requireElement<HTMLInputElement>(
        window.document,
        `input[name="${name}"]`,
      );
    // Disabling in both directions would lock the pair until a reload, so
    // the server-rendered conflict stays editable and its flash explains it.
    const reservation = pick("isReservation");
    const paid = pick("isPaidDefault");
    expect(reservation.disabled).toBe(false);
    expect(paid.disabled).toBe(false);

    paid.checked = false;
    paid.dispatchEvent(new Event("change"));
    expect(reservation.disabled).toBe(false);
    // Staying resolved: the cleared flag cannot re-tick while the held
    // status grants the boundary; unticking the held status frees both.
    expect(paid.disabled).toBe(true);
    expect(reservation.disabled).toBe(false);

    reservation.checked = false;
    reservation.dispatchEvent(new Event("change"));
    expect(paid.disabled).toBe(false);
    expect(reservation.disabled).toBe(false);
  });
});
