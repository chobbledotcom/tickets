/** Storage rules for invoices: the two seals, the number, and the status. */

import { assertRejects } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { decrypt } from "#crypto/encryption.ts";
import { decryptWithOwnerKey } from "#crypto/hybrid.ts";
import {
  cancelInvoice,
  createInvoice,
  deleteInvoice,
  getInvoice,
  getInvoiceByShareToken,
  getInvoices,
  getOpenInvoice,
  nextInvoiceNumber,
} from "#db/invoices.ts";
import { createReservedAttendee } from "#test-utils/balance.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const CREATED = "2026-11-03T09:00:00.000Z";

const storeInvoice = (
  attendeeId: number,
  id: number,
  bodyHtml = "<p>Frozen invoice</p>",
) => createInvoice({ attendeeId, bodyHtml, created: CREATED, id });

describeWithEnv("db > invoices", { db: true }, () => {
  test("stores both seals and finds the row by its share token", async () => {
    const privateKey = await getTestPrivateKey();
    const { attendeeId } = await createReservedAttendee(1500);
    const { invoice, shareToken } = await storeInvoice(attendeeId, 1);

    expect(invoice.id).toBe(1);
    expect(invoice.attendee_id).toBe(attendeeId);
    expect(invoice.status).toBe("new");
    expect(invoice.created).toBe(CREATED);
    expect(invoice.body.startsWith("hyb:1:")).toBe(true);
    expect(invoice.shared_body.startsWith("enc:1:")).toBe(true);
    expect(invoice.share_token.startsWith("hyb:1:")).toBe(true);

    expect(await decryptWithOwnerKey(invoice.body, privateKey)).toBe(
      "<p>Frozen invoice</p>",
    );
    expect(await decryptWithOwnerKey(invoice.share_token, privateKey)).toBe(
      shareToken,
    );
    expect(await decrypt(invoice.shared_body)).toBe("<p>Frozen invoice</p>");
    expect((await getInvoiceByShareToken(shareToken))?.id).toBe(1);
  });

  test("a token that never sealed a row matches no invoice", async () => {
    expect(await getInvoiceByShareToken("not-a-real-token")).toBe(null);
  });

  test("lists invoices newest first, without their bodies", async () => {
    const first = await createReservedAttendee(1500);
    const second = await createReservedAttendee(1500);
    await storeInvoice(first.attendeeId, 1);
    await storeInvoice(second.attendeeId, 2);

    const invoices = await getInvoices();
    expect(invoices.map((invoice) => invoice.id)).toEqual([2, 1]);
    expect(Object.hasOwn(invoices[0]!, "body")).toBe(false);
  });

  test("the next number follows the highest stored number", async () => {
    expect(await nextInvoiceNumber()).toBe(1);
    const { attendeeId } = await createReservedAttendee(1500);
    await storeInvoice(attendeeId, 1);
    expect(await nextInvoiceNumber()).toBe(2);
    const other = await createReservedAttendee(1500);
    await storeInvoice(other.attendeeId, 7);
    expect(await nextInvoiceNumber()).toBe(8);
  });

  test("stores a free number lower than the highest", async () => {
    const first = await createReservedAttendee(1500);
    const second = await createReservedAttendee(1500);
    await storeInvoice(first.attendeeId, 7);

    const { invoice } = await storeInvoice(second.attendeeId, 2);

    expect(invoice.id).toBe(2);
    expect((await getInvoice(2))?.id).toBe(2);
    expect((await getInvoices()).map((row) => row.id)).toEqual([7, 2]);
  });

  test("the open invoice is the new one, and cancelling closes it", async () => {
    const { attendeeId } = await createReservedAttendee(1500);
    await storeInvoice(attendeeId, 1);

    expect((await getOpenInvoice(attendeeId))?.id).toBe(1);
    expect(await getOpenInvoice(attendeeId + 1000)).toBe(null);

    expect(await cancelInvoice(1)).toBe(true);
    expect((await getInvoice(1))?.status).toBe("cancelled");
    expect(await getOpenInvoice(attendeeId)).toBe(null);
    expect(await cancelInvoice(1)).toBe(false);
  });

  test("a second new invoice for one attendee is refused", async () => {
    const { attendeeId } = await createReservedAttendee(1500);
    await storeInvoice(attendeeId, 1);

    await assertRejects(
      () => storeInvoice(attendeeId, 2),
      Error,
      "UNIQUE constraint failed",
    );
    expect((await getInvoices()).map((invoice) => invoice.id)).toEqual([1]);
  });

  test("deletes one invoice", async () => {
    const { attendeeId } = await createReservedAttendee(1500);
    await storeInvoice(attendeeId, 3);

    await deleteInvoice(3);
    expect(await getInvoice(3)).toBe(null);
    expect(await getInvoices()).toEqual([]);
  });
});
