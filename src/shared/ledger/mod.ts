/**
 * The pure, context-free transfer-ledger library.
 *
 * Phase 0 (this module set) is all pure logic: account identity, validation,
 * projections, reversal construction, and reconciliation. The persistence
 * boundary (SQL statement descriptors + a `LedgerStore` port) lands with Phase 1,
 * where it is exercised by integration tests against a real database.
 */

export * from "./account.ts";
export * from "./project.ts";
export * from "./reconcile.ts";
export * from "./reverse.ts";
export * from "./types.ts";
export * from "./validate.ts";
