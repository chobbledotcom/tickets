/**
 * The five destinations every record area declares: the list, the record
 * page, and the create, edit, and delete writes. The ids and paths derive from
 * the record's names, so a route and its gate cannot name different paths.
 */

import type {
  AdminAudience,
  AdminDestinationSpec,
} from "#shared/admin-surface/definitions.ts";

/** One record area's list, detail, and write destinations. */
export type RecordArea<
  Name extends string,
  Singular extends string,
  Prefix extends string,
  Path extends string,
  ExtraWrites extends Record<string, AdminDestinationSpec>,
  SaveToRecord extends boolean,
  ListAfterSave extends boolean,
> = {
  readonly audience: AdminAudience;
  readonly segments?: readonly string[];
  readonly view: {
    readonly [K in Name]: ListAfterSave extends true
      ? {
          readonly afterSave: Singular;
          readonly pattern: Path;
        }
      : Path;
  } & {
    readonly [K in Singular]: `${Path}/:id`;
  };
  readonly write: {
    readonly [K in `${Prefix}Delete`]: {
      readonly audience?: AdminAudience;
      readonly pattern: `${Path}/:id/delete`;
    };
  } & {
    readonly [K in `${Prefix}Edit`]: SaveToRecord extends true
      ? {
          readonly afterSave: Singular;
          readonly pattern: `${Path}/:id/edit`;
        }
      : `${Path}/:id/edit`;
  } & {
    readonly [K in `${Prefix}New`]: `${Path}/new`;
  } & ExtraWrites;
};

/**
 * Declare a record's five destinations. The list path defaults to
 * `/admin/<name>`, the detail id to the singular name, and the write ids to
 * the singular name. A record whose paths or ids differ names them.
 */
export const recordArea = <
  const Name extends string,
  const Singular extends string,
  const Prefix extends string = Singular,
  const Path extends string = `/admin/${Name}`,
  const ExtraWrites extends Record<string, AdminDestinationSpec> = {},
  const SaveToRecord extends boolean = false,
  const ListAfterSave extends boolean = SaveToRecord,
>(config: {
  readonly audience: AdminAudience;
  readonly basePath?: Path;
  readonly deleteAudience?: AdminAudience;
  readonly extraWrites?: ExtraWrites;
  readonly listAfterSave?: ListAfterSave;
  readonly name: Name;
  readonly prefix?: Prefix;
  readonly saveToRecord?: SaveToRecord;
  readonly segments?: readonly string[];
  readonly singular: Singular;
}): RecordArea<
  Name,
  Singular,
  Prefix,
  Path,
  ExtraWrites,
  SaveToRecord,
  ListAfterSave
> => {
  const path = (config.basePath ?? `/admin/${config.name}`) as Path;
  const prefix = (config.prefix ?? config.singular) as Prefix;
  const listAfterSave = config.listAfterSave ?? config.saveToRecord;
  const listSpec = listAfterSave
    ? { afterSave: config.singular, pattern: path }
    : path;
  const editSpec = config.saveToRecord
    ? { afterSave: config.singular, pattern: `${path}/:id/edit` }
    : `${path}/:id/edit`;
  return {
    audience: config.audience,
    ...(config.segments === undefined ? {} : { segments: config.segments }),
    view: {
      [config.name]: listSpec,
      [config.singular]: `${path}/:id`,
    },
    write: {
      [`${prefix}Delete`]: {
        ...(config.deleteAudience === undefined
          ? {}
          : { audience: config.deleteAudience }),
        pattern: `${path}/:id/delete`,
      },
      [`${prefix}Edit`]: editSpec,
      [`${prefix}New`]: `${path}/new`,
      ...config.extraWrites,
    },
  } as RecordArea<
    Name,
    Singular,
    Prefix,
    Path,
    ExtraWrites,
    SaveToRecord,
    ListAfterSave
  >;
};
