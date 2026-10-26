/**
 * Shared bundle-boot tail for fresh-process benchmark and smoke children:
 * imports the given bundle fresh, optionally serves /robots.txt once through
 * its handler, and reports the timings. The caller owns validation extras;
 * the request mode enforces the shared boot contract (a 200 robots.txt with
 * the benchmark body and content type) so a boot or routing error never
 * passes as a timing. Keeps stdout clean for the JSON result the driver
 * parses, restoring the loggers before it returns.
 */

import { toFileUrl } from "@std/path";
import {
  BENCHMARK_ROBOTS_BODY,
  BENCHMARK_ROBOTS_CONTENT_TYPE,
} from "./support.ts";

export type BootTimings = {
  importMs: number;
  firstRequestMs: number | null;
};

/** Return an error message when the served response breaks the boot
 *  contract; null when it passes. */
export type BootResponseCheck = (
  response: Response,
  body: string,
) => string | null;

/** The shared contract check: a 200 robots.txt with the exact benchmark
 *  body and content type. */
export const benchmarkRobotsCheck: BootResponseCheck = (
  response,
  body,
): string | null => {
  if (response.status !== 200) {
    return `first request failed with status ${response.status}`;
  }
  if (body !== BENCHMARK_ROBOTS_BODY) {
    return "first request did not return the exact robots.txt body";
  }
  if (response.headers.get("content-type") !== BENCHMARK_ROBOTS_CONTENT_TYPE) {
    return "first request did not return the robots.txt content type";
  }
  return null;
};

export const bootBundle = async (
  target: string,
  mode: "import" | "request",
  check: BootResponseCheck = benchmarkRobotsCheck,
): Promise<BootTimings> => {
  // The bundle logs its own startup lines (console.log/debug both go to
  // stdout); keep stdout clean for the JSON result the driver parses.
  const realLog = console.log.bind(console);
  const realDebug = console.debug.bind(console);
  console.log = () => {};
  console.debug = () => {};
  try {
    const importStart = performance.now();
    const module = await import(toFileUrl(await Deno.realPath(target)).href);
    const importMs = performance.now() - importStart;

    let firstRequestMs: number | null = null;
    if (mode === "request") {
      const requestStart = performance.now();
      const response: Response = await module.bunnyServeHandler(
        new Request("http://localhost/robots.txt", {
          headers: { "x-real-ip": "127.0.0.1" },
        }),
      );
      const body = await response.text();
      firstRequestMs = performance.now() - requestStart;
      const failure = check(response, body);
      if (failure !== null) {
        console.error(failure);
        Deno.exit(1);
      }
    }
    return { firstRequestMs, importMs };
  } finally {
    console.log = realLog;
    console.debug = realDebug;
  }
};
