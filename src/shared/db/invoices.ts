/** Invoice storage: the frozen body, the status, and the share token. */

import type { InValue } from "@libsql/client";
import { encryptWithKey } from "#crypto/encryption.ts";
import { hmacHash } from "#crypto/hashing.ts";
import { encryptWithOwnerKey } from "#crypto/hybrid.ts";
import type {
  BlindIndex,
  KeyEncrypted,
  OwnerKeyEncrypted,
} from "#crypto/sealed.ts";
import { generateSecureToken } from "#crypto/utils.ts";
import { execute } from "#db/client.ts";
import { settings } from "#db/settings.ts";
import { type SqlStatement, sql } from "#db/sql.ts";
import { col, defineTable } from "#db/table.ts";
import { type RowFilter, readById } from "#db/table-reader.ts";
import { invoiceBodyKey } from "#shared/invoices/seal.ts";
import type { InvoiceStatus } from "#shared/invoices/status.ts";

/** A stored invoice row. The keys are the table's own column names. */
export type InvoiceRow = {
  attendee_id: number;
  /** The rendered body, sealed under the share token's derived key. */
  body: KeyEncrypted;
  created: string;
  id: number;
  /** The capability in the share link, sealed under the owner public key. */
  share_token: OwnerKeyEncrypted;
  share_token_index: BlindIndex;
  status: InvoiceStatus;
};

/** The columns a list page needs: no sealed body, and no token. */
export type InvoiceSummary = Pick<
  InvoiceRow,
  "attendee_id" | "created" | "id" | "status"
>;

/** The columns every invoice summary read asks for. */
const SUMMARY_COLUMNS = ["attendee_id", "created", "id", "status"] as const;

/** A new invoice to store, in the domain's own words. */
export type NewInvoice = {
  attendeeId: number;
  bodyHtml: string;
  created: string;
  id: number;
};

type InvoiceInput = {
  attendeeId: number;
  body: KeyEncrypted;
  created: string;
  id: number;
  shareToken: OwnerKeyEncrypted;
  shareTokenIndex: BlindIndex;
  status: InvoiceStatus;
};

const invoicesTable = defineTable<InvoiceRow, InvoiceInput>({
  name: "invoices",
  primaryKey: "id",
  schema: {
    attendee_id: col.simple<number>(),
    body: col.simple<KeyEncrypted>(),
    created: col.simple<string>(),
    id: col.simple<number>(),
    share_token: col.simple<OwnerKeyEncrypted>(),
    share_token_index: col.simple<BlindIndex>(),
    status: col.simple<InvoiceStatus>(),
  },
});

/** One row by its invoice number, or null. */
export const getInvoice = readById(invoicesTable);

/** Every invoice the filter keeps, newest first, without its sealed body. */
const summariesNewestFirst = (
  filter: RowFilter<InvoiceSummary>,
): Promise<InvoiceSummary[]> =>
  invoicesTable.read.pick(SUMMARY_COLUMNS).many(filter, { order: sql`id DESC` });

/** Every invoice, newest first, without its sealed body. */
export const getInvoices = (): Promise<InvoiceSummary[]> =>
  summariesNewestFirst({});

/** The open (new) invoice for one attendee, or null. */
export const getOpenInvoice = (
  attendeeId: number,
): Promise<InvoiceRow | null> =>
  invoicesTable.read.one({ attendee_id: attendeeId, status: "new" });

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
  invoicesTable.read.one({ share_token_index: await hmacHash(token) });

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
  const invoice = await invoicesTable.insert({
    attendeeId,
    body,
    created,
    id,
    shareToken: sealedToken,
    shareTokenIndex,
    status: "new",
  });
  return { invoice, shareToken };
};

/** The statement that moves one new invoice to cancelled, and no other
 *  row. */
export const cancelInvoiceStatement = (id: number): SqlStatement =>
  sql`UPDATE invoices SET status = 'cancelled' WHERE id = ${id} AND status = 'new'`;

/** Move one new invoice to cancelled. False when it was not new. */
export const cancelInvoice = async (id: number): Promise<boolean> => {
  const result = await execute(cancelInvoiceStatement(id));
  return result.rowsAffected > 0;
};

/** Remove one invoice. */
export const deleteInvoice: (id: number) => Promise<void> = (id) =>
  invoicesTable.deleteById(id);

/**
 * The statement that marks an attendee's open invoices paid, guarded on the
 * ledger balance this settle is clearing. The settle runs it in the same
 * transaction, so an invoice never stays new after the balance it billed.
 */
export const markOpenInvoicesPaidStatement = (
  attendeeId: number,
  owedSql: SqlStatement,
  expectedAmount: InValue,
): SqlStatement => sql`UPDATE invoices SET status = 'paid'
         WHERE attendee_id = ${attendeeId} AND status = 'new' AND ${owedSql} = ${expectedAmount}`;
