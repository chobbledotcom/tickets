import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { MANUAL_ATTENDEE_CHARGE } from "#shared/accounting/manual-entries.ts";
import { allTransfers } from "#shared/accounting/queries.ts";
import { formatCurrency } from "#shared/currency.ts";
import {
  postAttendeePayment,
  seededAttendee,
  seededSale,
} from "#test/integration/server/ledger/helpers.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

describeWithEnv("server (admin ledger edit and delete)", { db: true }, () => {
  test("renders the edit page with the editable amount, timestamp, and delete confirmation", async () => {
    const { attendeeId } = await seededAttendee();
    await postAttendeePayment(attendeeId);
    const [entry] = await allTransfers();
    const response = await adminGet(
      `/admin/ledger/entries/${entry!.id}/edit?return_url=%2Fadmin%2Fattendees%2F${attendeeId}`,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Edit money change");
    expect(html).toContain('name="amount"');
    expect(html).toContain('value="12.34"');
    expect(html).toContain('name="occurred_at"');
    expect(html).toContain('value="2026-06-22T09:30"');
    expect(html).toContain("Delete money change");
    expect(html).toContain(
      "Warning: This permanently deletes this money change.",
    );
    expect(html).toContain(
      `Type the exact amount &quot;${formatCurrency(1234)}&quot; to confirm.`,
    );
    expect(html).toContain(formatCurrency(1234));
    expect(html).toContain('name="confirm_identifier"');
  });

  test("edit pages without a return_url fall back to the ledger", async () => {
    const { attendeeId } = await seededAttendee();
    await postAttendeePayment(attendeeId);
    const [entry] = await allTransfers();
    const response = await adminGet(`/admin/ledger/entries/${entry!.id}/edit`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(
      'name="return_url" type="hidden" value="/admin/ledger"',
    );
    expect(html).not.toContain('value="/null"');
  });

  test("404s edit and delete maintenance routes for checkout-event transfers", async () => {
    await seededSale("Immutable sale", 2500);
    const sale = (await allTransfers()).find(
      (transfer) => transfer.kind === "sale",
    );
    expect(sale).toBeDefined();

    const edit = await adminGet(`/admin/ledger/entries/${sale!.id}/edit`);
    expect(edit.status).toBe(404);

    const postEdit = await adminFormPost(
      `/admin/ledger/entries/${sale!.id}/edit`,
      {
        amount: "99.99",
        occurred_at: "2026-06-23T10:15",
        return_url: "/admin/ledger?view=dual",
      },
    );
    expect(postEdit.response.status).toBe(404);

    const postDelete = await adminFormPost(
      `/admin/ledger/entries/${sale!.id}/delete`,
      {
        confirm_identifier: formatCurrency(sale!.amount),
        return_url: "/admin/ledger?view=dual",
      },
    );
    expect(postDelete.response.status).toBe(404);

    const unchanged = (await allTransfers()).find(
      (transfer) => transfer.id === sale!.id,
    );
    expect(unchanged?.amount).toBe(sale!.amount);
    expect(unchanged?.occurredAt).toBe(sale!.occurredAt);
  });

  test("updates a ledger entry amount and business timestamp", async () => {
    const { attendeeId } = await seededAttendee();
    await postAttendeePayment(attendeeId);
    const [entry] = await allTransfers();
    const { response } = await adminFormPost(
      `/admin/ledger/entries/${entry!.id}/edit`,
      {
        amount: "7.89",
        occurred_at: "2026-06-23T10:15",
        return_url: "/admin/ledger?view=dual",
      },
    );
    await expectFlashRedirect(
      "/admin/ledger?view=dual",
      "Money change updated.",
    )(response);
    const [updated] = await allTransfers();
    expect(updated?.amount).toBe(789);
    expect(updated?.occurredAt).toBe("2026-06-23T10:15:00.000Z");
    expect(updated?.source).toEqual(entry?.source);
    expect(updated?.destination).toEqual(entry?.destination);
    const [log] = await getAllActivityLog(1);
    expect(log?.message).toBe(`Ledger entry #${entry!.id} updated`);
  });

  test("rejects invalid edit-entry forms without changing the transfer", async () => {
    const { attendeeId } = await seededAttendee();
    await postAttendeePayment(attendeeId);
    const [entry] = await allTransfers();
    for (const amount of ["0", "12abc", "1,000", "1e2", "12.345"]) {
      const { response } = await adminFormPost(
        `/admin/ledger/entries/${entry!.id}/edit`,
        {
          amount,
          occurred_at: "2026-06-23T10:15",
          return_url: "/admin/ledger",
        },
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain(
        `/admin/ledger/entries/${entry!.id}/edit`,
      );
      const [unchanged] = await allTransfers();
      expect(unchanged?.amount).toBe(entry?.amount);
      expect(unchanged?.occurredAt).toBe(entry?.occurredAt);
    }
  });

  test("404s edit and delete routes for a missing transfer", async () => {
    const edit = await adminGet("/admin/ledger/entries/999999/edit");
    expect(edit.status).toBe(404);

    const postEdit = await adminFormPost("/admin/ledger/entries/999999/edit", {
      amount: "1.00",
      occurred_at: "2026-06-23T10:15",
      return_url: "/admin/ledger",
    });
    expect(postEdit.response.status).toBe(404);

    const postDelete = await adminFormPost(
      "/admin/ledger/entries/999999/delete",
      {
        confirm_identifier: "£1.00",
        return_url: "/admin/ledger",
      },
    );
    expect(postDelete.response.status).toBe(404);
  });

  test("deletes a ledger entry only after the exact formatted amount is confirmed", async () => {
    const { attendeeId } = await seededAttendee();
    await postAttendeePayment(attendeeId);
    const [entry] = await allTransfers();
    const deletePath = `/admin/ledger/entries/${entry!.id}/delete`;
    const wrong = await adminFormPost(deletePath, {
      confirm_identifier: "£0.01",
      return_url: `/admin/attendees/${attendeeId}`,
    });
    expect(wrong.response.headers.get("location")).toContain(
      `/admin/ledger/entries/${entry!.id}/edit`,
    );
    expect(await allTransfers()).toHaveLength(1);

    const correct = await adminFormPost(deletePath, {
      confirm_identifier: formatCurrency(entry!.amount),
      return_url: `/admin/attendees/${attendeeId}`,
    });
    await expectFlashRedirect(
      `/admin/attendees/${attendeeId}`,
      "Money change deleted.",
    )(correct.response);
    expect(await allTransfers()).toEqual([]);
    const [log] = await getAllActivityLog(1);
    expect(log?.message).toBe(`Ledger entry #${entry!.id} deleted`);
  });

  test("ledger row edit links preserve the full filtered return URL", async () => {
    const { attendeeId } = await seededAttendee();
    const { response: postResponse } = await adminFormPost(
      `/admin/ledger/attendee/${attendeeId}/add`,
      {
        amount: "5.00",
        entry_type: MANUAL_ATTENDEE_CHARGE,
        occurred_at: "2026-06-22T09:30",
        return_url: "/admin/ledger",
      },
    );
    await expectFlashRedirect(
      "/admin/ledger",
      "Money change added.",
    )(postResponse);
    const [entry] = await allTransfers();
    const filteredPath =
      "/admin/ledger?view=dual&from=2026-06-01&fromCal=2026-05";
    const response = await adminGet(filteredPath);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(
      `/admin/ledger/entries/${entry!.id}/edit?return_url=${encodeURIComponent(
        filteredPath,
      )}`,
    );
    expect(html).not.toContain("return_url=NaN");
  });
});
