import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stubFetch } from "#test-utils/fetch-stub.ts";
import { useManualCheckinPage } from "./fixture.ts";

describe("manual check-in submission", () => {
  const { setup } = useManualCheckinPage();

  test("submission without a selected ticket does not call the server", async () => {
    const page = setup();
    using fetchStub = stubFetch(Response.json({ status: "checked_in" }));

    const event = await page.submit();

    expect(event.defaultPrevented).toBe(true);
    expect(fetchStub.calls.length).toBe(0);
  });

  test("successful submission checks in and removes the selected option", async () => {
    const page = setup();
    page.tokenInput.value = "ada";
    page.input.value = "Ada";
    using _fetch = stubFetch((url, init) => {
      expect(url).toBe("/admin/listing/7/scan");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({
        "content-type": "application/json",
        "x-csrf-token": "csrf",
      });
      expect(JSON.parse(String(init?.body))).toEqual({ token: "ada" });
      return Response.json({ name: "Ada", quantity: 2, status: "checked_in" });
    });

    await page.submit();

    expect(page.status.textContent).toBe("Ada checked in (2 tickets)");
    expect(page.status.className).toBe("checkin-status checkin-status-success");
    expect(page.listbox.querySelector("[data-token=ada]")).toBeNull();
    expect(page.tokenInput.value).toBe("");
    expect(page.input.value).toBe("");
  });

  test("successful submission defaults an invalid quantity to one", async () => {
    const page = setup();
    page.tokenInput.value = "unknown";
    using _fetch = stubFetch(
      Response.json({ name: "Ada", quantity: "two", status: "checked_in" }),
    );

    await page.submit();

    expect(page.status.textContent).toBe("Ada checked in (1 pass)");
    expect(page.listbox.querySelectorAll("[role=option]").length).toBe(3);
  });

  test("successful submission keeps a zero ticket quantity", async () => {
    const page = setup();
    page.tokenInput.value = "unknown";
    using _fetch = stubFetch(
      Response.json({ name: "Ada", quantity: 0, status: "checked_in" }),
    );

    await page.submit();

    expect(page.status.textContent).toBe("Ada checked in (0 tickets)");
  });

  test("successful submission uses empty text for an unknown message value", async () => {
    const page = setup();
    page.form.dataset.messageCheckedIn = "{name}:{missing}";
    page.tokenInput.value = "ada";
    using _fetch = stubFetch(
      Response.json({ name: "Ada", quantity: 2, status: "checked_in" }),
    );

    await page.submit();

    expect(page.status.textContent).toBe("Ada:");
  });

  test("successful submission removes only the first matching option", async () => {
    const page = setup();
    const option = page.listbox.querySelector<HTMLElement>("[data-token=ada]")!;
    page.listbox.append(option.cloneNode(true));
    page.tokenInput.value = "ada";
    using _fetch = stubFetch(
      Response.json({ name: "Ada", quantity: 2, status: "checked_in" }),
    );

    await page.submit();

    expect(page.listbox.querySelectorAll("[data-token=ada]").length).toBe(1);
  });

  test("ID verification resubmits before showing success", async () => {
    const page = setup();
    page.tokenInput.value = "bea";
    const bodies: unknown[] = [];
    const reply = (_url: string, init?: RequestInit): Response => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ status: "verify_id" });
    };
    using _fetch = stubFetch(reply, (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ name: "Bea", quantity: 1, status: "checked_in" });
    });

    await page.submit();

    expect(bodies).toEqual([
      { token: "bea" },
      { id_verified: true, token: "bea" },
    ]);
    expect(page.status.textContent).toBe("Bea checked in (1 pass) - check ID");
  });

  test("ID verification uses its fallback note when no message is configured", async () => {
    const page = setup();
    delete page.form.dataset.messageVerifyIdNote;
    page.tokenInput.value = "bea";
    using _fetch = stubFetch(
      Response.json({ status: "verify_id" }),
      Response.json({ name: "Bea", quantity: 1, status: "checked_in" }),
    );

    await page.submit();

    expect(page.status.textContent).toBe(
      "Bea checked in (1 pass) \u2014 verify their ID",
    );
  });

  test("already checked in results show a warning", async () => {
    const page = setup();
    page.form.dataset.messageAlreadyCheckedIn = "{name} already ({tickets})";
    page.tokenInput.value = "ada";
    using _fetch = stubFetch(
      Response.json({ name: "Ada", quantity: 0, status: "already_checked_in" }),
    );

    await page.submit();

    expect(page.status.textContent).toBe("Ada already (1 pass)");
    expect(page.status.className).toBe("checkin-status checkin-status-warning");
  });

  test("already checked in results keep their ticket quantity", async () => {
    const page = setup();
    page.form.dataset.messageAlreadyCheckedIn = "{tickets}";
    page.tokenInput.value = "ada";
    using _fetch = stubFetch(
      Response.json({ name: "Ada", quantity: 2, status: "already_checked_in" }),
    );

    await page.submit();

    expect(page.status.textContent).toBe("2 tickets");
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
      expected: "Scan failed",
      name: "unknown results prefer their error",
      result: { error: "Scan failed", message: "Ignored" },
    },
    {
      expected: "Try again",
      name: "unknown results fall back to their message",
      result: { message: "Try again" },
    },
    {
      expected: "Check-in failed",
      name: "unknown results use the configured error message",
      result: {},
    },
  ]) {
    test(scanError.name, async () => {
      const page = setup();
      page.tokenInput.value = "ada";
      using _fetch = stubFetch(Response.json(scanError.result));

      await page.submit();

      expect(page.status.textContent).toBe(scanError.expected);
      expect(page.status.className).toBe("checkin-status checkin-status-error");
    });
  }

  for (const fallback of [
    {
      expected: "Ada already checked in",
      key: "messageAlreadyCheckedIn",
      name: "already checked in results use their fallback message",
      result: { name: "Ada", status: "already_checked_in" },
    },
    {
      expected: "Ada has been refunded",
      key: "messageRefunded",
      name: "refunded results use their fallback message",
      result: { name: "Ada", status: "refunded" },
    },
    {
      expected: "Ticket not found",
      key: "messageNotFound",
      name: "not found results use their fallback message",
      result: { status: "not_found" },
    },
    {
      expected: "Error",
      key: "messageError",
      name: "unknown results use their fallback error message",
      result: {},
    },
  ]) {
    test(fallback.name, async () => {
      const page = setup();
      delete page.form.dataset[fallback.key];
      page.tokenInput.value = "ada";
      using _fetch = stubFetch(Response.json(fallback.result));

      await page.submit();

      expect(page.status.textContent).toBe(fallback.expected);
    });
  }

  test("an empty configured message stays empty", async () => {
    const page = setup();
    page.form.dataset.messageNotFound = "";
    page.tokenInput.value = "missing";
    using _fetch = stubFetch(Response.json({ status: "not_found" }));

    await page.submit();

    expect(page.status.textContent).toBe("");
  });

  test("network failures show an error and re-enable submission", async () => {
    const page = setup();
    page.tokenInput.value = "ada";
    using _fetch = stubFetch(new Error("offline"));

    await page.submit();

    expect(page.status.textContent).toBe("Could not reach server");
    expect(page.status.className).toBe("checkin-status checkin-status-error");
    expect(page.submitButton.disabled).toBe(false);
  });

  test("network failures use the fallback message when none is configured", async () => {
    const page = setup();
    delete page.form.dataset.messageNetworkError;
    page.tokenInput.value = "ada";
    using _fetch = stubFetch(new Error("offline"));

    await page.submit();

    expect(page.status.textContent).toBe("Network error");
  });
});
