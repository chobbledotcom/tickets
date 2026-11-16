/** Invoice storage: the frozen body, the status, and the share token. */

import { encryptWithKey } from "#crypto/encryption.ts";
import { hmacHash } from "#crypto/hashing.ts";
import { encryptWithOwnerKey } from "#crypto/hybrid.ts";
import { generateSecureToken } from "#crypto/utils.ts";
import { execute } from "#db/client.ts";
import { executeChangedRow } from "#db/guarded-writes.ts";
import { readRows } from "#db/read.ts";

import { records } from "#db/record-table.ts";
import { type Counted, desc, type Expr, equal } from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import type { Matching, Node } from "#db/select/shape.ts";
import { type DecodedRowOf, tables } from "#db/select/tables.ts";
import { settings } from "#db/settings.ts";
import { type SqlStatement, sql } from "#db/sql.ts";
import { update } from "#db/write.ts";
import { invoiceBodyKey } from "#shared/invoices/seal.ts";

/** A stored invoice row. The body is sealed under the share token's derived
 * key, and the share token under the owner public key. */
export type InvoiceRow = DecodedRowOf<"invoices">;

/** The columns a list page needs: no sealed body, and no token. */
export type InvoiceSummary = Pick<
  InvoiceRow,
  "attendee_id" | "created" | "id" | "status"
>;

/** A new invoice to store, in the domain's own words. */
export type NewInvoice = {
  attendeeId: number;
  bodyHtml: string;
  created: string;
  id: number;
};

/** One row by its invoice number, or null. */

/** Every invoice the filter keeps, newest first, without its sealed body. */
const summariesNewestFirst = (
  where: Matching<Node<"invoices">>,
): Promise<InvoiceSummary[]> =>
  readRows(
    from(tables.invoices)
      .where(where)
      .orderBy((invoice) => [desc(invoice.id)])
      .pick("attendee_id", "created", "id", "status"),
  );

/** Every invoice, newest first, without its sealed body. */
export const getInvoices = (): Promise<InvoiceSummary[]> =>
  summariesNewestFirst({});

/** The open (new) invoice for one attendee, or null. */
export const getOpenInvoice = (
  attendeeId: number,
): Promise<InvoiceRow | null> =>
  records.invoices.findWhere({ attendee_id: attendeeId, status: "new" });

/** The attendee's invoices, newest first, without their sealed bodies. The
 *  booking's info table reads the newest one. */
export const getAttendeeInvoices = (
  attendeeId: number,
): Promise<InvoiceSummary[]> =>
  summariesNewestFirst({ attendee_id: attendeeId });

/** The invoice a share link names, or null when the token matches none. */
export const getInvoiceByShareToken = async (
  token: string,
): Promise<InvoiceRow | null> =>
  records.invoices.findWhere({ share_token_index: await hmacHash(token) });

/** The next free invoice number, which the create form prefills. */
export const nextInvoiceNumber = async (): Promise<number> => {
  const result = await execute(
    sql`SELECT COALESCE(MAX(id), 0) + 1 AS next_number FROM invoices`,
  );
  return Number(result.rows[0]!.next_number);
};

export type CreatedInvoice = { invoice: InvoiceRow; shareToken: string };

/** Seal the rendered body under the share token's key, and store the row with
 *  that token sealed under the owner key. */
export const createInvoice = async ({
  attendeeId,
  bodyHtml,
  created,
  id,
}: NewInvoice): Promise<CreatedInvoice> => {
  const shareToken = generateSecureToken();
  const bodyKey = await invoiceBodyKey(shareToken);
  const [body, sealedToken, shareTokenIndex] = await Promise.all([
    encryptWithKey(bodyHtml, bodyKey),
    encryptWithOwnerKey(shareToken, settings.publicKey),
    hmacHash(shareToken),
  ]);
  const invoice = await records.invoices.insert({
    attendee_id: attendeeId,
    body,
    created,
    id,
    share_token: sealedToken,
    share_token_index: shareTokenIndex,
    status: "new",
  });
  return { invoice, shareToken };
};

/** The statement that moves one new invoice to cancelled, and no other
 *  row. */
export const cancelInvoiceStatement = (id: number): SqlStatement =>
  update(tables.invoices, { status: "cancelled" }).where({ id, status: "new" });

/** Move one new invoice to cancelled. False when it was not new. */
export const cancelInvoice = async (id: number): Promise<boolean> =>
  executeChangedRow(cancelInvoiceStatement(id));

/** Remove one invoice. */

/**
 * The statement that marks an attendee's open invoices paid, guarded on the
 * ledger balance this settle is clearing. The settle runs it in the same
 * transaction, so an invoice never stays new after the balance it billed.
 */
export const markOpenInvoicesPaidStatement = (
  attendeeId: number,
  owed: Expr<Counted>,
  expectedAmount: number,
): SqlStatement =>
  update(tables.invoices, { status: "paid" }).where((invoice) => [
    equal(invoice.attendee_id, attendeeId),
    equal(invoice.status, "new"),
    equal(owed, expectedAmount),
  ]);
