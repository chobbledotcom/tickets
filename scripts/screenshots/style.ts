import type { Page } from "playwright";
import { failAfterCleanups, runCleanups } from "#scripts/cleanup.ts";

const removeScreenshotStyles = (styleMarker: string): void => {
  const removeFromOpenRoots = (root: Document | ShadowRoot): void => {
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) removeFromOpenRoots(element.shadowRoot);
    }
    for (const link of root.querySelectorAll(
      `link[data-screenshot-style="${styleMarker}"]`,
    )) {
      link.remove();
    }
  };
  removeFromOpenRoots(document);
};

export const addScreenshotStyle = async (
  page: Page,
  css: string,
): Promise<() => Promise<void>> => {
  const marker = crypto.randomUUID();
  const url = new URL("/custom.css", page.url());
  url.searchParams.set("screenshot-style", marker);
  const href = url.toString();
  await page.route(href, (route) =>
    route.fulfill({ body: css, contentType: "text/css" }),
  );
  const unroute = () => page.unroute(href);
  const style = await page
    .addStyleTag({ url: href })
    .catch((error) => failAfterCleanups(error, [unroute]));
  const cleanUp = async (): Promise<void> => {
    await runCleanups([
      () => page.evaluate(removeScreenshotStyles, marker),
      async () => {
        await style.evaluate((node) => node.parentNode?.removeChild(node));
      },
      unroute,
    ]);
  };
  try {
    await page.evaluate(
      async ({ href, marker }) => {
        const addToOpenRoots = async (
          root: Document | ShadowRoot,
        ): Promise<void> => {
          const shadowRoots = Array.from(
            root.querySelectorAll("*"),
            (element) => element.shadowRoot,
          ).filter(
            (shadowRoot): shadowRoot is ShadowRoot => shadowRoot !== null,
          );
          await Promise.all(
            shadowRoots.map(async (shadowRoot) => {
              const link = document.createElement("link");
              link.dataset.screenshotStyle = marker;
              link.rel = "stylesheet";
              link.href = href;
              await new Promise<void>((resolve, reject) => {
                link.addEventListener("load", () => resolve(), { once: true });
                link.addEventListener(
                  "error",
                  () => reject(new Error("Could not load screenshot style.")),
                  { once: true },
                );
                shadowRoot.appendChild(link);
              });
              await addToOpenRoots(shadowRoot);
            }),
          );
        };
        await addToOpenRoots(document);
      },
      { href, marker },
    );
  } catch (error) {
    return failAfterCleanups(error, [cleanUp]);
  }
  return cleanUp;
};
