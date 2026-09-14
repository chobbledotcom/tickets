/**
 * Opening a batch of sealed values in order. Both the owner-sealed note rows
 * and the contact's stored token lines open one entry at a time with the
 * same private key; this holds that "open each, keep the order" step in one
 * place so the two readers cannot drift.
 */

import { mapParallel } from "#fp";

/** Open every row with the shared buyer-of-decryption key, keeping order. */
export const openEach =
  <Row, Opened>(
    openOne: (row: Row, privateKey: CryptoKey) => Promise<Opened>,
  ) =>
  (rows: readonly Row[], privateKey: CryptoKey): Promise<Opened[]> =>
    mapParallel((row: Row) => openOne(row, privateKey))(rows);
