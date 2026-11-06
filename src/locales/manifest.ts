import system from "./en/system.json" with { type: "json" };
import {
  MESSAGE_GROUPS,
  type MessageGroup,
} from "./message-groups.generated.ts";

export type Messages = Readonly<Record<string, string>>;
export type MessageLoader = () => Promise<Messages>;

type GuideMessageGroup = Extract<MessageGroup, "guide" | `guide-${string}`>;

export const GUIDE_MESSAGE_GROUPS: readonly GuideMessageGroup[] =
  MESSAGE_GROUPS.filter(
    (group): group is GuideMessageGroup =>
      group === "guide" || group.startsWith("guide-"),
  );

type MessageModule = { default: Messages };

const messagesFrom =
  (load: () => Promise<MessageModule>): MessageLoader =>
  async () =>
    (await load()).default;

// esbuild bundles this template import as a glob: every JSON file gets its own
// lazy initializer. `system` is imported eagerly above.
const loaderFor = (group: MessageGroup): MessageLoader =>
  group === "system"
    ? async () => system
    : messagesFrom(
        () => import(`./en/${group}.json`, { with: { type: "json" } }),
      );

export const ENGLISH_MESSAGE_LOADERS = Object.fromEntries(
  MESSAGE_GROUPS.map((group) => [group, loaderFor(group)]),
) as Record<MessageGroup, MessageLoader>;

export const SYSTEM_MESSAGES: Messages = system;
