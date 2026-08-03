/** Deno Desktop entry point. */

import { validateBootChecks } from "#shared/boot-checks.ts";
import { createDesktopHandler } from "./desktop-handler.ts";
import {
  type DesktopWindowConstructor,
  enableDesktopWindows,
} from "./desktop-windows.ts";
import { serveHandler } from "./serve-app.ts";

const desktopDeno = Deno as unknown as {
  BrowserWindow: DesktopWindowConstructor;
};

validateBootChecks();
enableDesktopWindows(desktopDeno.BrowserWindow);
Deno.serve(createDesktopHandler(serveHandler));
