import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { initTicketQuantityRequired } from "#src/ui/client/admin/ticket-quantity-required.ts";
import { createDomInstaller } from "#test-utils/happy-dom.ts";

describe("ticket quantity required", () => {
  const dom = createDomInstaller();
  afterEach(() => dom.cleanup());

  const setupForm = (html: string) => {
    const window = dom.installDom(html);
    const form = window.document.querySelector("form")!;
    initTicketQuantityRequired();
    return {
      form,
      submit: () => {
        const event = new window.Event("submit", { cancelable: true });
        form.dispatchEvent(event);
        return event;
      },
      window,
    };
  };

  test("leaves forms without ticket quantities unchanged", () => {
    const { form, submit } = setupForm('<form id="other"></form>');
    const event = submit();

    expect(event.defaultPrevented).toBe(false);
    expect(form.querySelector("[role=alert]")).toBeNull();
  });

  test("allows submission when any ticket quantity is positive", () => {
    const { form, submit, window } = setupForm(`
      <form>
        <input name="quantity_1" value="invalid">
        <select name="quantity_2"><option selected value="2">2</option></select>
      </form>
    `);
    const quantity = form.querySelector("select")!;

    quantity.dispatchEvent(new window.Event("change"));
    const event = submit();

    expect(event.defaultPrevented).toBe(false);
    expect(form.querySelector("[role=alert]")).toBeNull();
  });

  test("allows submission when a package quantity is positive", () => {
    const { form, submit } = setupForm(`
      <form>
        <select name="quantity_1"><option selected value="0">0</option></select>
        <select name="package_quantity_2"><option selected value="1">1</option></select>
      </form>
    `);

    const event = submit();

    expect(event.defaultPrevented).toBe(false);
    expect(form.querySelector("[role=alert]")).toBeNull();
  });

  test("allows leading-zero quantities accepted by the server", () => {
    const { form, submit } = setupForm(`
      <form><input name="quantity_1" value="01"></form>
    `);

    const event = submit();

    expect(event.defaultPrevented).toBe(false);
    expect(form.querySelector("[role=alert]")).toBeNull();
  });

  test("blocks malformed ticket quantities", () => {
    const { form, submit, window } = setupForm(`
      <form>
        <input name="quantity_1" value="1invalid">
        <input name="quantity_2" value="9007199254740992">
      </form>
    `);
    window.HTMLElement.prototype.scrollIntoView = () => {};

    const event = submit();

    expect(event.defaultPrevented).toBe(true);
    expect(form.querySelector("[role=alert]")?.textContent).toBe(
      "Please select at least one ticket",
    );
  });

  test("blocks submission and shows one error when no tickets are selected", () => {
    const { form, submit, window } = setupForm(`
      <form>
        <p>Tickets</p>
        <input name="quantity_1" value="invalid">
        <input name="quantity_2" value="-1">
        <select name="quantity_3"><option selected value="0">0</option></select>
      </form>
    `);
    let scrollCount = 0;
    window.HTMLElement.prototype.scrollIntoView = () => {
      scrollCount += 1;
    };

    const first = submit();
    const second = submit();

    const errors = form.querySelectorAll('[role="alert"]');
    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(true);
    expect(errors.length).toBe(1);
    expect(errors[0]!.className).toBe("error");
    expect(errors[0]!.textContent).toBe("Please select at least one ticket");
    expect(form.firstElementChild).toBe(errors[0]);
    expect(scrollCount).toBe(2);
  });

  test("recreates a removed error after another invalid submission", () => {
    const { form, submit, window } = setupForm(`
      <form><select name="quantity_1"><option selected value="0">0</option></select></form>
    `);
    const quantity = form.querySelector("select")!;
    window.HTMLElement.prototype.scrollIntoView = () => {};
    submit();

    quantity.dispatchEvent(new window.Event("change"));
    expect(form.querySelector("[role=alert]")).toBeNull();

    submit();
    expect(form.querySelector("[role=alert]")?.textContent).toBe(
      "Please select at least one ticket",
    );
  });
});
