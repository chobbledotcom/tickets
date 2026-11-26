import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { alreadyIn, checkedIn, useManualCheckinPage } from "./fixture.ts";

describe("manual check-in submission", () => {
  const { pickedPage, setup } = useManualCheckinPage();

  test("a search shorter than two letters asks for more and calls nothing", async () => {
    const page = await setup();
    using fetchStub = stubFetch(Response.json({ status: "checked_in" }));
    page.input.value = " a ";

    const event = await page.submit();

    expect(event.defaultPrevented).toBe(true);
    expect(fetchStub.calls.length).toBe(0);
    expect(page.status.textContent).toBe("Type more letters.");
    expect(page.status.className).toBe("checkin-status checkin-status-warning");
  });

  test("successful submission checks in and removes the selected option", async () => {
    const page = await pickedPage("11");
    page.input.value = "Ada";
    using _fetch = stubFetch((url, init) => {
      expect(url).toBe("/admin/listing/7/scan");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({
        "content-type": "application/json",
        "x-csrf-token": "csrf",
      });
      expect(JSON.parse(String(init?.body))).toEqual({ attendee_id: 11 });
      return Response.json(checkedIn());
    });

    await page.submit();

    expect(page.status.textContent).toBe(
      "Ada checked in for Ceilidh (2 tickets)",
    );
    expect(page.status.className).toBe("checkin-status checkin-status-success");
    expect(page.listbox.querySelector("[data-key='11']")).toBeNull();
    expect(page.buttonLabel()).toBe("Search");
    expect(page.input.value).toBe("");
  });

  test("a check-in answer that misses its counts fails loudly and keeps the pick", async () => {
    const page = await pickedPage("11");
    using _fetch = stubFetch(Response.json(checkedIn({ quantity: "two" })));

    await page.submit();

    // A broken answer is a contract break, not a generic refusal.
    expect(page.status.textContent).toBe(
      "Something went wrong. Reload this page, then try again.",
    );
    expect(page.listbox.querySelectorAll("[role=option]").length).toBe(3);
    expect(page.buttonLabel()).toBe("Check In");
  });

  test("successful submission keeps a zero ticket quantity", async () => {
    const page = await pickedPage("11");
    using _fetch = stubFetch(
      Response.json(checkedIn({ quantity: 0, total: 0 })),
    );

    await page.submit();

    expect(page.status.textContent).toBe(
      "Ada checked in for Ceilidh (0 tickets)",
    );
  });

  test("a full check-in removes every matching option", async () => {
    const page = await setup();
    const option = page.listbox.querySelector<HTMLElement>("[data-key='11']")!;
    page.listbox.append(option.cloneNode(true));
    page.pick("11");
    using _fetch = stubFetch(Response.json(checkedIn()));

    await page.submit();

    expect(page.listbox.querySelectorAll("[data-key='11']").length).toBe(0);
  });

  test("a check-in with tickets remaining keeps the person's option, showing what is left", async () => {
    const page = await pickedPage("11");
    using _fetch = stubFetch(Response.json(checkedIn({ remaining: 3 })));

    await page.submit();

    const option = page.listbox.querySelector<HTMLElement>("[data-key='11']")!;
    expect(option.dataset.quantity).toBe("3");
    expect(option.textContent).toBe("Ada (3 tickets) - Camping · 12 Jun");
    expect(page.buttonLabel()).toBe("Search");
    expect(page.input.value).toBe("");
  });

  test("an option with no day or listing keeps the plain label as it shrinks", async () => {
    const page = await pickedPage("13");
    using _fetch = stubFetch(
      Response.json(checkedIn({ name: "Cy", remaining: 1 })),
    );

    await page.submit();

    const option = page.listbox.querySelector<HTMLElement>("[data-key='13']")!;
    expect(option.dataset.quantity).toBe("1");
    expect(option.textContent).toBe("Cy (1 pass)");
  });

  test("already checked in results show a warning with their ticket quantity", async () => {
    for (const [quantity, words] of [
      [0, "Ada already checked in for Ceilidh (0 tickets)"],
      [2, "Ada already checked in for Ceilidh (2 tickets)"],
    ] as const) {
      const page = await pickedPage("11");
      using _fetch = stubFetch(
        Response.json(alreadyIn({ quantity, total: quantity })),
      );

      await page.submit();

      expect(page.status.textContent).toBe(words);
      expect(page.status.className).toBe(
        "checkin-status checkin-status-warning",
      );
    }
  });

  for (const scanError of [
    {
      expected: "Ada was refunded.",
      name: "refunded results show an error",
      result: { name: "Ada", status: "refunded" },
    },
    {
      expected: "No matching ticket",
      name: "not found results show an error",
      result: { status: "not_found" },
    },
    {
      expected: "Invalid quantity",
      name: "a refusal shows the API's own words",
      result: { error: "Invalid quantity" },
    },
    {
      expected: "Check-in failed",
      name: "an answer with no words shows the page's error words",
      result: {},
    },
  ]) {
    test(scanError.name, async () => {
      const page = await pickedPage("11");
      using _fetch = stubFetch(Response.json(scanError.result));

      await page.submit();

      expect(page.status.textContent).toBe(scanError.expected);
      expect(page.status.className).toBe("checkin-status checkin-status-error");
    });
  }

  test("network failures show an error and re-enable submission", async () => {
    const page = await pickedPage("11");
    using _fetch = stubFetch(new Error("offline"));

    await page.submit();

    expect(page.status.textContent).toBe("Could not reach server");
    expect(page.status.className).toBe("checkin-status checkin-status-error");
    expect(page.submitButton.disabled).toBe(false);
  });
});
