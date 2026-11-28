/** Read the timeline a recorded session wrote. The pure schema stays in
 * timeline.ts, so the browser renderer never pulls in filesystem code. */

import { join } from "@std/path";
import { type GuideTimeline, parseGuideTimeline } from "./timeline.ts";

export const readGuideTimeline = async (
  sessionDir: string,
): Promise<GuideTimeline> =>
  parseGuideTimeline(
    JSON.parse(await Deno.readTextFile(join(sessionDir, "timeline.json"))),
  );
