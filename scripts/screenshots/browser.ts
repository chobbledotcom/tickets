import { rethrowUnlessNotFound } from "#scripts/not-found.ts";

export const chromiumExecutable = async (): Promise<string | undefined> => {
  const configured = Deno.env.get("CHROMIUM_EXECUTABLE");
  if (configured) return configured;
  const nixBrowser = "/etc/profiles/per-user/user/bin/chromium";
  try {
    await Deno.stat(nixBrowser);
    return nixBrowser;
  } catch (error) {
    rethrowUnlessNotFound(error);
    return;
  }
};
