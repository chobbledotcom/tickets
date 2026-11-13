/**
 * The destinations every record area declares. It gives the list, the record
 * page, the edit and delete writes, and the create write. An area names each
 * page its record does not have, and that destination is then absent. The ids
 * and paths derive from the record's names, so a route and its gate cannot
 * name different paths.
 */

import type {
  AdminAreaBase,
  AdminAudience,
  AdminDestinationSpec,
} from "#shared/admin-surface/definitions.ts";

/** The names and switches one record area is built from. */
type AreaSpec = {
  readonly extraViews: Record<string, AdminDestinationSpec>;
  readonly extraWrites: Record<string, AdminDestinationSpec>;
  readonly listAfterSave: boolean;
  readonly name: string;
  /** The pages the record has: its own page, an edit form, a new page. */
  readonly pages: { detail: boolean; edit: boolean; new: boolean };
  readonly path: string;
  readonly prefix: string;
  readonly saveToRecord: boolean;
  readonly singular: string;
};

/** The entries, or nothing when the area's record has no such page. */
type WhenPage<Page extends boolean, Entries> = Page extends false
  ? unknown
  : Entries;

/** One record area's list, detail, and write destinations. */
type RecordArea<Spec extends AreaSpec> = AdminAreaBase &
  WhenPage<
    Spec["pages"]["detail"],
    {
      /** The ids the record that names this area reads its routes from. */
      readonly record: {
        readonly detail: Spec["singular"];
        readonly list: Spec["name"];
        /** False when the record is created on its list page. */
        readonly newPage: Spec["pages"]["new"];
        readonly remove: `${Spec["prefix"]}Delete`;
      };
    }
  > & {
    readonly view: {
      readonly [K in Spec["name"]]: Spec["listAfterSave"] extends true
        ? {
            readonly afterSave: Spec["singular"];
            readonly pattern: Spec["path"];
          }
        : Spec["path"];
    } & WhenPage<
      Spec["pages"]["detail"],
      { readonly [K in Spec["singular"]]: `${Spec["path"]}/:id` }
    > &
      Spec["extraViews"];
    readonly write: {
      readonly [K in `${Spec["prefix"]}Delete`]: {
        readonly audience?: AdminAudience;
        readonly pattern: `${Spec["path"]}/:id/delete`;
      };
    } & WhenPage<
      Spec["pages"]["edit"],
      {
        readonly [K in `${Spec["prefix"]}Edit`]: Spec["saveToRecord"] extends true
          ? {
              readonly afterSave: Spec["singular"];
              readonly pattern: `${Spec["path"]}/:id/edit`;
            }
          : `${Spec["path"]}/:id/edit`;
      }
    > &
      WhenPage<
        Spec["pages"]["new"],
        { readonly [K in `${Spec["prefix"]}New`]: `${Spec["path"]}/new` }
      > &
      Spec["extraWrites"];
  };

/** No extra destinations. */
type NoExtras = Record<never, never>;

/** The entries, or none when the switch is off. */
const whenPage = <Entries extends object>(
  page: boolean,
  entries: Entries,
): Entries | NoExtras => (page ? entries : {});

/**
 * Declare a record's destinations. The list path defaults to
 * `/admin/<name>`, the detail id to the singular name, and the write ids to
 * the singular name. A record whose paths or ids differ names them.
 */
export const recordArea = <
  const Name extends string,
  const Singular extends string,
  const Prefix extends string = Singular,
  const Path extends string = `/admin/${Name}`,
  const ExtraWrites extends Record<string, AdminDestinationSpec> = NoExtras,
  const SaveToRecord extends boolean = false,
  const ListAfterSave extends boolean = SaveToRecord,
  const NewPage extends boolean = true,
  const ExtraViews extends Record<string, AdminDestinationSpec> = NoExtras,
  const DetailPage extends boolean = true,
  const EditPage extends boolean = true,
>(config: {
  readonly audience: AdminAudience;
  readonly basePath?: Path;
  readonly deleteAudience?: AdminAudience;
  /** False for a record with no page of its own. No record can then name
   *  the area as its home. */
  readonly detailPage?: DetailPage;
  /** False for a record that no form edits. */
  readonly editPage?: EditPage;
  readonly extraViews?: ExtraViews;
  readonly extraWrites?: ExtraWrites;
  readonly listAfterSave?: ListAfterSave;
  readonly name: Name;
  /** False for a record that is created on its list page. */
  readonly newPage?: NewPage;
  readonly prefix?: Prefix;
  readonly saveToRecord?: SaveToRecord;
  readonly segments?: readonly string[];
  readonly singular: Singular;
}) => {
  const path = (config.basePath ?? `/admin/${config.name}`) as Path;
  const prefix = (config.prefix ?? config.singular) as Prefix;
  const newPage = (config.newPage !== false) as NewPage;
  const detailPage = config.detailPage !== false;
  const listAfterSave = (config.listAfterSave ??
    config.saveToRecord) as ListAfterSave;
  const listSpec = listAfterSave
    ? { afterSave: config.singular, pattern: path }
    : path;
  const editSpec = config.saveToRecord
    ? { afterSave: config.singular, pattern: `${path}/:id/edit` }
    : `${path}/:id/edit`;
  return {
    audience: config.audience,
    ...whenPage(detailPage, {
      record: {
        detail: config.singular,
        list: config.name,
        newPage,
        remove: `${prefix}Delete`,
      },
    }),
    ...(config.segments === undefined ? {} : { segments: config.segments }),
    view: {
      [config.name]: listSpec,
      ...whenPage(detailPage, { [config.singular]: `${path}/:id` }),
      ...config.extraViews,
    },
    write: {
      [`${prefix}Delete`]: {
        ...(config.deleteAudience === undefined
          ? {}
          : { audience: config.deleteAudience }),
        pattern: `${path}/:id/delete`,
      },
      ...whenPage(config.editPage !== false, { [`${prefix}Edit`]: editSpec }),
      ...whenPage(newPage, { [`${prefix}New`]: `${path}/new` }),
      ...config.extraWrites,
    },
  } as RecordArea<{
    extraViews: ExtraViews;
    extraWrites: ExtraWrites;
    listAfterSave: ListAfterSave;
    name: Name;
    pages: { detail: DetailPage; edit: EditPage; new: NewPage };
    path: Path;
    prefix: Prefix;
    saveToRecord: SaveToRecord;
    singular: Singular;
  }>;
};

/** The path tail of each write, keyed by the suffix its id ends with. */
type Tails = Readonly<Record<string, string>>;

/** Writes that share one id prefix and one path. Each id is the prefix with a
 * suffix. Each path is the shared path with that suffix's tail. */
export type SuffixWrites<
  Prefix extends string,
  Path extends string,
  Suffixes extends Tails,
> = {
  readonly [Suffix in keyof Suffixes &
    string as `${Prefix}${Suffix}`]: `${Path}/${Suffixes[Suffix]}`;
};

/** Bind one set of tails, so an area names only its prefix and its path. */
const writesWith =
  <const Suffixes extends Tails>(tails: Suffixes) =>
  <const Prefix extends string, const Path extends string>(
    prefix: Prefix,
    path: Path,
  ): SuffixWrites<Prefix, Path, Suffixes> =>
    Object.fromEntries(
      Object.entries(tails).map(([suffix, tail]) => [
        `${prefix}${suffix}`,
        `${path}/${tail}`,
      ]),
    ) as SuffixWrites<Prefix, Path, Suffixes>;

const MOVE_TAILS = { MoveDown: "move-down", MoveUp: "move-up" } as const;
const IMAGE_TAILS = {
  Images: "images",
  ImagesUpload: "images/upload",
} as const;

/** The move-down and move-up writes of one ordered row, under its path. */
export const moveWrites = writesWith(MOVE_TAILS);

/** The image set and image upload writes of one record with an Images tab. */
export const imageWrites = writesWith(IMAGE_TAILS);

/** The writes of one Site content record: its Actions tab and its images. */
export const contentWrites = writesWith({ Actions: "actions", ...IMAGE_TAILS });

/** The writes on one child row: edit, delete, and move. */
const childRowWrites = writesWith({
  Delete: "delete",
  Edit: "edit",
  ...MOVE_TAILS,
});

/** The five writes of one ordered child collection: add a child under the
 * collection path, then edit, delete, and move one child under its own. */
export const childWrites = <
  const Prefix extends string,
  const Path extends string,
  const Param extends string,
>(
  prefix: Prefix,
  path: Path,
  param: Param,
) => ({
  ...({ [`${prefix}Add`]: path } as { readonly [K in `${Prefix}Add`]: Path }),
  ...childRowWrites(prefix, `${path}/:${param}`),
});
