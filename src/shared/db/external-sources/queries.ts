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
import { records } from "#db/record-table.ts";
import { among } from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import type { Matching, Node } from "#db/select/shape.ts";
import { tables } from "#db/select/tables.ts";
import { type SqlStatement, sql } from "#db/sql.ts";
import { insertInto, update } from "#db/write.ts";
import { nowIso } from "#shared/now.ts";
import { requireValue } from "#shared/required-value.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import { type ExternalLinkTarget, externalLinkTargets } from "./target.ts";
import type {
  ExternalLinkFilter,
  ExternalLinkInput,
  ExternalLinkKind,
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
      externalIdIndex: await externalLinkIndex(sourceId, filter.externalId),
      sourceId,
    };
  }
  if (filter.kind === "target") {
    return {
      linkId: filter.linkId,
      linkType: filter.linkType,
      sourceId,
    };
  }
  return { sourceId };
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
  readRows(linksIdOrder({ linkId: target.id, linkType: target.kind }));

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
      .where((link) => among(link.externalIdIndex, indexes))
      .sortedBy("id")
      .everyColumn(),
  );
  const byId = sourcesById(sources);
  return stored.map((link) => ({
    link,
    source: requireValue(
      byId.get(link.sourceId),
      `External source ${link.sourceId} is missing`,
    ),
  }));
};

export const getExternalSourceLink = (
  sourceId: number,
  linkId: number,
): Promise<ExternalSourceLink | null> =>
  records.external_source_links.findWhere({
    id: linkId,
    sourceId,
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

/** Why a link write is refused, and the status the API answers with. */
export type LinkRefusal = { message: string; status: 400 | 409 };

/** The stored facts that refuse a link write, read in one round trip. The
 *  conflict is the oldest other link at this source that holds the same
 *  external id. A write with no external id has none: the index is empty. */
type LinkWriteFacts = {
  conflict_id: number | null;
  conflict_type: ExternalLinkKind | null;
  target_missing: number;
};

/** The oldest other link at the source that holds the write's external id. A
 *  create passes 0 for the row it does not replace. No stored id is 0. */
const holderOfExternalId = (
  input: ExternalLinkInput,
  excludingId: number,
): SqlStatement => sql`FROM external_source_links AS existingLink
         WHERE existingLink.source_id = ${input.sourceId}
           AND existingLink.external_id_index = ${input.externalIdIndex}
           AND existingLink.id != ${excludingId}
         ORDER BY existingLink.id
         LIMIT 1`;

const linkWriteFactsStatement = (
  input: ExternalLinkInput,
  excludingId: number,
): SqlStatement => {
  const holder =
    input.externalIdIndex === null
      ? null
      : holderOfExternalId(input, excludingId);
  const conflictType =
    holder === null
      ? sql`NULL`
      : sql`(SELECT existingLink.link_type ${holder})`;
  const conflictId =
    holder === null ? sql`NULL` : sql`(SELECT existingLink.link_id ${holder})`;
  return sql`SELECT
      ${conflictType} AS conflict_type,
      ${conflictId} AS conflict_id,
      NOT ${externalLinkTargets.existsSql(input.linkType, input.linkId)} AS target_missing`;
};

/** The columns to store for a link write, or the reason it cannot be stored.
 *  The reason names a missing target record, or the record that the source
 *  already links to that external id. One source holds one external id for one
 *  record. The facts read runs inside the write transaction, so no other write
 *  can land between the check and the store. */
const prepareLinkWrite = async (
  tx: TxScope,
  sourceId: number,
  write: ExternalLinkWrite,
  excludingId: number,
): Promise<Result<ExternalLinkInput, LinkRefusal>> => {
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
    return errorResult({
      message: `No ${write.linkType} has id ${write.linkId}`,
      status: 400,
    });
  }
  if (stored.conflict_id !== null) {
    return errorResult({
      message: `This source already links that external id to ${stored.conflict_type} ${stored.conflict_id}`,
      status: 409,
    });
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
): Promise<Result<T, LinkRefusal>> =>
  withTransaction(async (tx) => {
    const prepared = await prepareLinkWrite(tx, sourceId, write, excludingId);
    if (!prepared.ok) return errorResult(prepared.error);
    return okResult(await store(tx, prepared.value));
  });

export const createExternalSourceLink = (
  sourceId: number,
  write: ExternalLinkWrite,
): Promise<Result<ExternalSourceLink, LinkRefusal>> =>
  withPreparedLinkWrite(sourceId, write, 0, async (tx, input) => {
    // A write needs no session, so it must not open the value it sealed.
    // The row is the input, plus the keys that SQLite made.
    const statement = insertInto(
      tables.external_source_links,
      await encoded(tables.external_source_links, {
        ...input,
        created: nowIso(),
      }),
    ).returning("created", "id");
    const row = requireValue(
      resultRows(await tx.execute(statement))[0],
      "The external source link insert returned no row",
    );
    return { ...input, ...row };
  });

/** Store a changed link. The caller re-reads the row it answers with. Like
 *  the create, the write needs no session, so it reads back no sealed value. */
export const updateExternalSourceLink = (
  link: ExternalSourceLink,
  write: ExternalLinkWrite,
): Promise<Result<true, LinkRefusal>> =>
  withPreparedLinkWrite<true>(
    link.sourceId,
    write,
    link.id,
    async (tx, input) => {
      await tx.execute(
        update(
          tables.external_source_links,
          await encoded(tables.external_source_links, input),
        ).where({ id: link.id }),
      );
      return true;
    },
  );

export const deleteExternalSourceLink = (
  link: ExternalSourceLink,
): Promise<void> => records.external_source_links.delete(link.id);
