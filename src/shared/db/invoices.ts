/** Invoice storage: the frozen body, the status, and the share token. */

/* jscpd:ignore-start */
import type { InValue } from "@libsql/client";
import { encrypt } from "#crypto/encryption.ts";
import { hmacHash } from "#crypto/hashing.ts";
import { encryptWithOwnerKey } from "#crypto/hybrid.ts";
import type {
  BlindIndex,
  EnvKeyEncrypted,
  OwnerKeyEncrypted,
} from "#crypto/sealed.ts";
import { generateSecureToken } from "#crypto/utils.ts";
import { execute, type SqlStatement } from "#db/client.ts";
import { settings } from "#db/settings.ts";
import { col, defineTable } from "#db/table.ts";
import { readById } from "#db/table-reader.ts";
import type { InvoiceStatus } from "#shared/invoices/status.ts";
/* jscpd:ignore-end */

/** A stored invoice row. The keys are the table's own column names. */
export type InvoiceRow = {
  attendee_id: number;
  /** The rendered body, sealed under the owner public key. */
  body: OwnerKeyEncrypted;
  created: string;
  id: number;
  /** The same body, sealed under the site key for the share page. */
  shared_body: EnvKeyEncrypted;
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

/** A new invoice to store, in the domain's own words. */
export type NewInvoice = {
  attendeeId: number;
  bodyHtml: string;
  created: string;
  id: number;
};

type InvoiceInput = {
  attendeeId: number;
  body: OwnerKeyEncrypted;
  created: string;
  id: number;
  sharedBody: EnvKeyEncrypted;
  shareToken: OwnerKeyEncrypted;
  shareTokenIndex: BlindIndex;
  status: InvoiceStatus;
};

const invoicesTable = defineTable<InvoiceRow, InvoiceInput>({
  name: "invoices",
  primaryKey: "id",
  schema: {
    attendee_id: col.simple<number>(),
    body: col.simple<OwnerKeyEncrypted>(),
    created: col.simple<string>(),
    id: col.simple<number>(),
    share_token: col.simple<OwnerKeyEncrypted>(),
    share_token_index: col.simple<BlindIndex>(),
    shared_body: col.simple<EnvKeyEncrypted>(),
    status: col.simple<InvoiceStatus>(),
  },
});

/** One row by its invoice number, or null. */
export const getInvoice = readById(invoicesTable);

/** Every invoice, newest first, without its sealed body. */
export const getInvoices = (): Promise<InvoiceSummary[]> =>
  invoicesTable.read
    .pick(["attendee_id", "created", "id", "status"])
    .many({}, { order: "id DESC" });

/** The open (new) invoice for one attendee, or null. */
export const getOpenInvoice = (
  attendeeId: number,
): Promise<InvoiceRow | null> =>
  invoicesTable.read.one({ attendee_id: attendeeId, status: "new" });

/** The invoice a share link names, or null when the token matches none. */
export const getInvoiceByShareToken = async (
  token: string,
): Promise<InvoiceRow | null> =>
  invoicesTable.read.one({ share_token_index: await hmacHash(token) });

/** The next free invoice number, which the create form prefills. */
export const nextInvoiceNumber = async (): Promise<number> => {
  const result = await execute(
    "SELECT COALESCE(MAX(id), 0) + 1 AS next_number FROM invoices",
  );
  return Number(result.rows[0]!.next_number);
};

export type CreatedInvoice = { invoice: InvoiceRow; shareToken: string };

/** Seal the rendered body under both keys, mint the share token, and store the
 *  row. `body` serves an owner session. `sharedBody` serves the share link. */
export const createInvoice = async ({
  attendeeId,
  bodyHtml,
  created,
  id,
}: NewInvoice): Promise<CreatedInvoice> => {
  const shareToken = generateSecureToken();
  const [body, sharedBody, sealedToken, shareTokenIndex] = await Promise.all([
    encryptWithOwnerKey(bodyHtml, settings.publicKey),
    encrypt(bodyHtml),
    encryptWithOwnerKey(shareToken, settings.publicKey),
    hmacHash(shareToken),
  ]);
  const invoice = await invoicesTable.insert({
    attendeeId,
    body,
    created,
    id,
    sharedBody,
    shareToken: sealedToken,
    shareTokenIndex,
    status: "new",
  });
  return { invoice, shareToken };
};

/** Move one new invoice to cancelled. False when it was not new. */
export const cancelInvoice = async (id: number): Promise<boolean> => {
  const result = await execute(
    "UPDATE invoices SET status = 'cancelled' WHERE id = ? AND status = 'new'",
    [id],
  );
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
  owedSql: string,
  expectedAmount: InValue,
): SqlStatement => ({
  args: [attendeeId, expectedAmount],
  sql: `UPDATE invoices SET status = 'paid'
         WHERE attendee_id = ? AND status = 'new' AND ${owedSql} = ?`,
});
