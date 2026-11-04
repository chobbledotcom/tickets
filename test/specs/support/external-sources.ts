/**
 * Noting that a record also appears in another system, and asking where it
 * appears. The owner's own tool carries a key, as another system's would.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { t } from "#i18n";
import { askedAsKey, jsonWrite } from "#test/specs/support/api-request.ts";
import {
  listingIdNamed,
  putsPlainThingOnSale,
} from "#test/specs/support/listings.ts";
import {
  type ActOnOneThing,
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { createTestApiKeyToken } from "#test-utils/session.ts";

// jscpd:ignore-end

/** The admin API's private list of other systems. */
const DIRECTORY = "/api/admin/external-sources";

/** The key the owner's own tool carries, as another system's would. */
const TOOL_KEY = "the owner's tool";

/** Where one diary keeps its own records. */
const DIARY_PATTERN = "https://diary.example/events/{external_id}";

/** What the tool was last told, kept for the step that reads it. */
const TOOL_ANSWER = "the answer";

/** One note: a listing, the id the diary knows it by, and the diary's name. */
export type Note = { diary: string; externalId: string; listing: string };

type SourceAnswer = { source: { id: number } };
type LinksAnswer = {
  links: {
    external_id: string | null;
    link_id: number;
    source_name?: string;
  }[];
};

/** The key the owner's tool carries. Made once per story. */
const toolKey = async (world: TicketsWorld): Promise<string> => {
  const known = world.things.recall("key", TOOL_KEY);
  if (known) return known;
  const key = await createTestApiKeyToken();
  world.things.remember("key", TOOL_KEY, key);
  return key;
};

/** Ask the site the way the owner's own tool asks it. */
const ask = async (
  world: TicketsWorld,
  path: string,
  init: RequestInit = {},
): Promise<Response> => askedAsKey(await toolKey(world), path, init);

const send = (
  world: TicketsWorld,
  method: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Response> => ask(world, path, { ...jsonWrite(body), method });

/** What the tool was told, parsed for the step that reads it. */
const keptAnswer = <T>(world: TicketsWorld): T =>
  JSON.parse(
    requiredWorldValue(
      world.things.recall("told", TOOL_ANSWER),
      "what the tool was told",
    ),
  ) as T;

/** Keep one answer for the step that reads it. */
const keepAnswer = async (
  world: TicketsWorld,
  response: Promise<Response>,
): Promise<void> => {
  world.things.remember("told", TOOL_ANSWER, await (await response).text());
};

/** A listing the story talks about, made the first time it is named. */
export const listingForStory: ActOnOneThing = async (world, name) => {
  if (world.things.recall("listing", name)) return;
  await putsPlainThingOnSale(world, name);
};

/** The organiser sets up one diary, kept by the name the story calls it. */
export const ownerHasDiary: ActOnOneThing = async (world, name) => {
  const body = await assertJson<SourceAnswer>(
    send(world, "POST", DIRECTORY, { name, url_pattern: DIARY_PATTERN }),
    201,
  );
  world.things.remember("diary", name, Number(body.source.id));
};

/** The request that notes one listing in one diary, under the diary's id. */
const noteRequest = (world: TicketsWorld, note: Note): Promise<Response> =>
  send(
    world,
    "POST",
    `${DIRECTORY}/${world.things.require("diary", note.diary)}/links`,
    {
      external_id: note.externalId,
      link_id: listingIdNamed(world, note.listing),
      link_type: "listing",
    },
  );

/** Note that one listing appears in one diary, as a story's own setup does. */
export const noteListing = async (
  world: TicketsWorld,
  note: Note,
): Promise<void> => {
  await assertJson(noteRequest(world, note), 201);
};

/** Note one listing as the owner's own tool would, keeping what it is told. */
export const toolNotesListing = (
  world: TicketsWorld,
  note: Note,
): Promise<void> => keepAnswer(world, noteRequest(world, note));

/** The links one diary holds, as the tool reads them. */
const linksInDiary = async (
  world: TicketsWorld,
  diary: string,
): Promise<LinksAnswer["links"]> => {
  const body = await assertJson<LinksAnswer>(
    ask(world, `${DIRECTORY}/${world.things.require("diary", diary)}/links`),
    200,
  );
  return body.links;
};

/** Whether one diary still holds a note for one listing. */
export const diaryNotesListing = async (
  world: TicketsWorld,
  diary: string,
  listing: string,
): Promise<boolean> =>
  (await linksInDiary(world, diary)).some(
    (link) => link.link_id === listingIdNamed(world, listing),
  );

/** The tool asks where one listing also appears, and keeps the answer. */
export const toolAsksWhereListingAppears = (
  world: TicketsWorld,
  listing: string,
): Promise<void> =>
  keepAnswer(
    world,
    ask(
      world,
      `${DIRECTORY}/links?link_type=listing&link_id=${listingIdNamed(world, listing)}`,
    ),
  );

/** Whether the kept answer names this diary's id for the record. */
export const answerNames = (
  world: TicketsWorld,
  externalId: string,
  diary: string,
): boolean =>
  keptAnswer<LinksAnswer>(world).links.some(
    (link) => link.source_name === diary && link.external_id === externalId,
  );

/** The tool was refused because External sources is off, in the site's words. */
export const expectToldToTurnItOn = (world: TicketsWorld): void => {
  expect(keptAnswer<{ error: string }>(world).error).toBe(
    t("features.external_sources.disabled"),
  );
};
