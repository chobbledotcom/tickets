/**
 * Reading and writing the external sources directory.
 *
 * Every read opens its rows with the request's owner key, and every write seals
 * them first (see ./sealing.ts). A link also carries a blind index of its
 * external id, so a lookup finds the row without decrypting any.
 */

import { blindIndexFor } from "#crypto/hashing.ts";
import type { BlindIndex } from "#crypto/sealed.ts";
import { inOneBatch, removalWithChildren } from "#db/child-rows.ts";
import { resultRows, type TxScope, withTransaction } from "#db/client.ts";
import { encoded } from "#db/codecs/decode.ts";
import { readRows } from "#db/read.ts";
import { deleteRow, findRow, findRowWhere } from "#db/record-table.ts";
import { among } from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import type { Matching, Node } from "#db/select/shape.ts";
import { tables } from "#db/select/tables.ts";
import { type SqlStatement, sql } from "#db/sql.ts";
import { insertInto, update } from "#db/write.ts";
import { snakeCaseKeys } from "#shared/column-names.ts";
/* jscpd:ignore-start -- imports */
import { bindFirst } from "#shared/fp-bind.ts";
import { nowIso } from "#shared/now.ts";
import { requireValue } from "#shared/required-value.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import { type ExternalLinkTarget, externalLinkTargets } from "./target.ts";
import type {
  ExternalLinkFilter,
  ExternalLinkInput,
  ExternalLinkWrite,
  ExternalSource,
  ExternalSourceLink,
} from "./types.ts";

/* jscpd:ignore-end */

/** The blind index that finds one link without decrypting. The source is part
 *  of the hashed input, so two sources can hold the same external id. */
const linkIndexFor = blindIndexFor("external-source-link:");

export const externalLinkIndex = (
  sourceId: number,
  externalId: string,
): Promise<BlindIndex> => linkIndexFor(String(sourceId), externalId);

/** Every source, in the order they were added. */
export const getAllExternalSources = (): Promise<ExternalSource[]> =>
  readRows(from(tables.external_sources).sortedBy("id").everyColumn());

export const getExternalSource = bindFirst(findRow)(tables.external_sources);

/** Delete one source and its links in one batch, so no link outlives the
 *  source that names its place. */
export const deleteExternalSource = inOneBatch(
  removalWithChildren(tables.external_sources, [
    [tables.external_source_links, "source_id"],
  ]),
);

/** The links that `where` keeps, oldest first. */
const linksIdOrder = (where: Matching<Node<"external_source_links">>) =>
  from(tables.external_source_links).where(where).sortedBy("id").everyColumn();

/** The filter one links read keeps, written as the row's own shape. */
const linkFilter = async (
  sourceId: number,
  filter: ExternalLinkFilter,
): Promise<Matching<Node<"external_source_links">>> => {
  if (filter.kind === "external") {
    return {
      external_id_index: await externalLinkIndex(sourceId, filter.externalId),
      source_id: sourceId,
    };
  }
  if (filter.kind === "target") {
    return {
      link_id: filter.linkId,
      link_type: filter.linkType,
      source_id: sourceId,
    };
  }
  return { source_id: sourceId };
};

/** One source's links, oldest first. */
export const listExternalSourceLinks = async (
  sourceId: number,
  filter: ExternalLinkFilter,
): Promise<ExternalSourceLink[]> =>
  readRows(linksIdOrder(await linkFilter(sourceId, filter)));

/** Every source's links that name one record, oldest first. The record page
 *  reads this once instead of asking each source in turn. */
export const listExternalLinksForTarget = (
  target: ExternalLinkTarget,
): Promise<ExternalSourceLink[]> =>
  readRows(linksIdOrder({ link_id: target.id, link_type: target.kind }));

/** One link found by its external id, with the source that holds it. */
export type ExternalLinkMatch = {
  link: ExternalSourceLink;
  source: ExternalSource;
};

/** The sources under their ids, for pairing a row with the source that holds
 *  it. */
export const sourcesById = (
  sources: readonly ExternalSource[],
): ReadonlyMap<number, ExternalSource> =>
  new Map(sources.map((source) => [source.id, source]));

/** One record's links found by its external id, in every source that holds it.
 *  The blind index binds the id to its source, so the query hashes the id once
 *  per source and matches them all in one statement. */
export const lookupExternalLinks = async (
  externalId: string,
): Promise<ExternalLinkMatch[]> => {
  const sources = await getAllExternalSources();
  if (sources.length === 0) return [];
  const indexes = await Promise.all(
    sources.map((source) => externalLinkIndex(source.id, externalId)),
  );
  const stored = await readRows(
    from(tables.external_source_links)
      .where((link) => among(link.external_id_index, indexes))
      .sortedBy("id")
      .everyColumn(),
  );
  const byId = sourcesById(sources);
  return stored.map((link) => ({
    link,
    source: requireValue(
      byId.get(link.source_id),
      `External source ${link.source_id} is missing`,
    ),
  }));
};

export const getExternalSourceLink = (
  sourceId: number,
  linkId: number,
): Promise<ExternalSourceLink | null> =>
  findRowWhere(tables.external_source_links, {
    id: linkId,
    source_id: sourceId,
  });

/** One link a caller just asked to read or write. Its absence is a broken
 *  read-your-writes path, so the caller fails loudly. */
export const requireExternalSourceLink = async (
  sourceId: number,
  linkId: number,
): Promise<ExternalSourceLink> =>
  requireValue(
    await getExternalSourceLink(sourceId, linkId),
    `External source link ${linkId} is missing from source ${sourceId}`,
  );

/** The two stored facts that refuse a link write, read in one round trip. A
 *  write with no external id skips the duplicate check: the index is empty. */
type LinkWriteFacts = { duplicate: number; target_missing: number };

/** A create passes 0 for the row it does not replace. No stored id is 0. */
const linkWriteFactsStatement = (
  input: ExternalLinkInput,
  excludingId: number,
): SqlStatement => {
  const duplicate =
    input.externalIdIndex === null
      ? sql`0`
      : sql`EXISTS (
        SELECT 1 FROM external_source_links AS existingLink
         WHERE existingLink.source_id = ${input.sourceId}
           AND existingLink.external_id_index = ${input.externalIdIndex}
           AND existingLink.link_type = ${input.linkType}
           AND existingLink.link_id = ${input.linkId}
           AND existingLink.id != ${excludingId}
      )`;
  return sql`SELECT
      ${duplicate} AS duplicate,
      NOT ${externalLinkTargets.existsSql(input.linkType, input.linkId)} AS target_missing`;
};

/** The columns to store for a link write, or the reason it cannot be stored.
 *  The reason names a missing target record, or an external id the source
 *  already holds. The facts read runs inside the write transaction, so a delete
 *  cannot land between the check and the write. */
const prepareLinkWrite = async (
  tx: TxScope,
  sourceId: number,
  write: ExternalLinkWrite,
  excludingId: number,
): Promise<Result<ExternalLinkInput>> => {
  const input: ExternalLinkInput = {
    externalId: write.externalId,
    externalIdIndex:
      write.externalId === null
        ? null
        : await externalLinkIndex(sourceId, write.externalId),
    linkId: write.linkId,
    linkType: write.linkType,
    sourceId,
  };
  const facts = linkWriteFactsStatement(input, excludingId);
  const stored = requireValue(
    resultRows<LinkWriteFacts>(await tx.execute(facts))[0],
    "The external link write facts query returned no row",
  );
  if (stored.target_missing === 1) {
    return errorResult(`No ${write.linkType} has id ${write.linkId}`);
  }
  if (stored.duplicate === 1) {
    return errorResult(
      "This source already links that record to that external id",
    );
  }
  return okResult(input);
};

/** Run one link write inside the transaction that checks it. The callback
 *  stores the prepared columns and answers with the value to return. */
const withPreparedLinkWrite = <T>(
  sourceId: number,
  write: ExternalLinkWrite,
  excludingId: number,
  store: (tx: TxScope, input: ExternalLinkInput) => Promise<T>,
): Promise<Result<T>> =>
  withTransaction(async (tx) => {
    const prepared = await prepareLinkWrite(tx, sourceId, write, excludingId);
    if (!prepared.ok) return errorResult(prepared.error);
    return okResult(await store(tx, prepared.value));
  });

export const createExternalSourceLink = (
  sourceId: number,
  write: ExternalLinkWrite,
): Promise<Result<ExternalSourceLink>> =>
  withPreparedLinkWrite(sourceId, write, 0, async (tx, input) => {
    // A write needs no session, so it must not open the value it sealed.
    // The row is the input, plus the keys that SQLite made.
    const statement = insertInto(
      tables.external_source_links,
      await encoded(tables.external_source_links, {
        ...snakeCaseKeys(input),
        created: nowIso(),
      }),
    ).returning("created", "id");
    const row = requireValue(
      resultRows(await tx.execute(statement))[0],
      "The external source link insert returned no row",
    );
    return { ...snakeCaseKeys(input), ...row };
  });

/** Store a changed link. The caller re-reads the row it answers with. Like
 *  the create, the write needs no session, so it reads back no sealed value. */
export const updateExternalSourceLink = (
  link: ExternalSourceLink,
  write: ExternalLinkWrite,
): Promise<Result<true>> =>
  withPreparedLinkWrite<true>(
    link.source_id,
    write,
    link.id,
    async (tx, input) => {
      await tx.execute(
        update(
          tables.external_source_links,
          await encoded(tables.external_source_links, snakeCaseKeys(input)),
        ).where({ id: link.id }),
      );
      return true;
    },
  );

export const deleteExternalSourceLink = (
  link: ExternalSourceLink,
): Promise<void> => deleteRow(tables.external_source_links, link.id);
