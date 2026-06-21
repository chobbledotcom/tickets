#!/usr/bin/env -S deno run --allow-env --allow-read --allow-run
import { loadConfig } from "./config.ts";
import { type CurlOptions, curlJson } from "./curl.ts";
import { clearScreen, writeOut } from "./io.ts";
import {
  parseResource,
  type ResourceName,
  resourcePath,
  resources,
} from "./resources.ts";

type State = { resource: ResourceName; last: unknown };

const config = await loadConfig(Deno.cwd());
const state: State = { last: null, resource: "listings" };

const helpText = `\nTickets CLI (Rezi-style Deno TUI, curl-backed)\nCommands:\n  resource <${resources.join("|")}>\n  list\n  get <id>\n  create <json>\n  update <id> <json>\n  delete <id> <json-confirmation>\n  help\n  quit\n`;

const render = async () => {
  await clearScreen();
  const last =
    state.last === null ? "(none)" : JSON.stringify(state.last, null, 2);
  await writeOut(
    `Tickets CLI — ${config.apiHostname}\nResource: ${state.resource}\nLast response:\n${last}\n${helpText}`,
  );
};

const requestFor = (line: string): CurlOptions | "quit" | null => {
  const [command = "", first = "", ...rest] = line.trim().split(/\s+/);
  if (["quit", "q", "exit"].includes(command)) return "quit";
  if (command === "help" || command === "") return null;
  if (command === "resource") {
    state.resource = parseResource(first);
    return null;
  }
  if (command === "list") return { path: resourcePath(state.resource) };
  if (command === "get") return { path: resourcePath(state.resource, first) };
  if (command === "create") {
    return {
      body: JSON.parse([first, ...rest].join(" ")),
      method: "POST",
      path: resourcePath(state.resource),
    };
  }
  const body = JSON.parse(rest.join(" "));
  if (command === "update") {
    return { body, method: "PUT", path: resourcePath(state.resource, first) };
  }
  if (command === "delete") {
    return {
      body,
      method: "DELETE",
      path: resourcePath(state.resource, first),
    };
  }
  throw new Error(`Unknown command: ${command}`);
};

const run = async (line: string): Promise<boolean> => {
  const request = requestFor(line);
  if (request === "quit") return false;
  if (request) state.last = await curlJson(config, request);
  return true;
};

for (let active = true; active; ) {
  await render();
  const line = prompt("> ") ?? "quit";
  try {
    active = await run(line);
  } catch (error) {
    state.last = {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
