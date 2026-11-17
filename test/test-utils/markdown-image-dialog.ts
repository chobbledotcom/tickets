/**
 * Shared harness for the image picker dialog suites
 * (`src/ui/client/admin/markdown-editor-images.ts`): reply builders, the
 * happy-dom editor mounts, the stubbed fetch holder, and the open/upload
 * flows the dialog's tests share.
 */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import type { Stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import type { Window } from "happy-dom";
import { type FetchReply, stubFetch } from "#test-utils/fetch-stub.ts";
import { requireElement } from "#test-utils/happy-dom.ts";
import { enhanced } from "#test-utils/markdown-editor-dom.ts";

/** The stub survives between the test body and the afterEach that restores
 * it; a const holder keeps the module free of a reassignable `let`. */
export const fetchStubHolder: { stub: Stub | undefined } = {
  stub: undefined,
};

/** Restore the held stub once: a test that restored its own stub must not
 * leave the hook a second restore to trip over. */
export const restoreHeldStub = (): void => {
  fetchStubHolder.stub?.restore();
  fetchStubHolder.stub = undefined;
};

export const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });

/** The two-image library the list and insert cases share, already in the
 * name order the options endpoint returns, with the thumbnail and full URLs
 * it now carries. */
export const twoImageList = (): Response =>
  json({
    images: [
      {
        id: 2,
        name: "Alpha",
        thumb: "/image/alpha-thumb.webp",
        url: "/image/alpha.webp",
      },
      {
        id: 9,
        name: "Zebra",
        thumb: "/image/zebra-thumb.webp",
        url: "/image/zebra.webp",
      },
    ],
  });

/** A library long enough to cross the lazy-thumbnail threshold. */
export const tenImageList = (): Response =>
  json({
    images: Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      name: `Image ${index + 1}`,
      thumb: `/image/image-${index + 1}-thumb.webp`,
      url: `/image/image-${index + 1}.webp`,
    })),
  });

/** Binds a selector to a reader for the dialog's window. */
const partReader =
  <TElement extends Element>(selector: string) =>
  (window: Window): TElement =>
    requireElement<TElement>(window.document, selector);

export const toolbarImageButton =
  partReader<HTMLButtonElement>(".md-toolbar-image");

export const imageDialog = partReader<HTMLDialogElement>(".md-image-dialog");

export const imageGrid = partReader<HTMLElement>(".md-image-grid");

export interface OpenDialogResult {
  dialog: HTMLDialogElement;
  grid: HTMLElement;
  handle: Awaited<ReturnType<typeof enhanced>>["handle"];
  textarea: HTMLTextAreaElement;
  window: Window;
}

/** A flow's work on the mounted dialog, with the flush to call before the
 * fake clock restores. */
type FlowAct = (
  opened: OpenDialogResult,
  flushSelection: () => Promise<void>,
) => Promise<void>;

/** Asserts the grid shows a plain message, then tears the dialog and the
 * view down the way every failed-load test ends. */
export const expectGridMessage = (
  { dialog, grid, handle }: OpenDialogResult,
  message: string,
): void => {
  assertStringIncludes(grid.textContent, message);
  handle.view.destroy();
  dialog.remove();
};

/** Opens the dialog on a fake clock: the flow's asserts run inside `act`,
 * the mount answers from `replies`, and the returned `flushSelection`
 * drains Prosemirror's focus handler before the clock restores. */
export const withDialogClock = async (
  replies: [FetchReply, ...FetchReply[]],
  options: { form?: boolean; value?: string },
  act: FlowAct,
): Promise<void> => {
  const time = new FakeTime();
  try {
    const opened = await openDialog(replies, options);
    await act(opened, () => time.tickAsync(30));
  } finally {
    time.restore();
  }
};

/** What the browser hands the code after fetch follows the upload's
 * redirect: a 200 whose url is the redirect target. */
export const redirected = (path: string): Response => {
  const response = new Response("", { status: 200 });
  Object.defineProperty(response, "url", {
    value: `http://localhost${path}`,
  });
  return response;
};

/** A flow over the standard two-image library, on a fake clock: the
 * library answers first, then the flow's own calls take the later
 * replies. */
const withFlow =
  (
    extraReplies: [FetchReply, ...FetchReply[]],
    options: { form?: boolean; value?: string },
  ): ((act: FlowAct) => Promise<void>) =>
  (act) =>
    withDialogClock([twoImageList(), ...extraReplies], options, act);

/** The successful-upload flow: the dialog over an empty editor sitting in
 * a form with a CSRF token, the upload redirecting to the new image's
 * edit page. */
export const withUploadFlow = withFlow([redirected("/admin/images/12/edit")], {
  form: true,
  value: "",
});

/** Ends a successful upload: the tag landed, the dialog shut, the view
 * dies, and the selection flush drains. */
export const finishUpload = async (
  handle: { view: { destroy: () => void } },
  textarea: HTMLTextAreaElement,
  dialog: HTMLDialogElement,
  flushSelection: () => Promise<void>,
): Promise<void> => {
  expect(textarea.value).toBe("![Harbour](img#12)");
  expect(dialog.open).toBe(false);
  handle.view.destroy();
  await flushSelection();
};

/** Mounts the editor against a stubbed options endpoint, opens the dialog,
 * and returns its window, dialog, grid, and handle once the grid settles.
 * The first reply answers the options list; any further replies answer the
 * calls the test's own flow makes (an upload, a refetch). `stylesheet`
 * installs the compiled cascade, for tests that assert computed styles;
 * `value` seeds the textarea (default "hello"). */
export const openDialog = async (
  replies: [FetchReply, ...FetchReply[]],
  {
    stylesheet,
    value = "hello",
    form,
  }: {
    stylesheet?: string;
    value?: string;
    form?: boolean;
  } = {},
): Promise<OpenDialogResult> => {
  fetchStubHolder.stub = stubFetch(...replies);
  const { window, handle, textarea } = enhanced(value, {
    ...(stylesheet === undefined ? {} : { stylesheet }),
    ...(form === undefined ? {} : { form }),
  });
  toolbarImageButton(window).click();
  const dialog = imageDialog(window);
  const grid = imageGrid(window);
  await untilReady(grid);
  return { dialog, grid, handle, textarea, window };
};

/** Lets the stubbed fetch and the grid render settle (microtasks only). */
export async function untilReady(grid: HTMLElement): Promise<void> {
  for (let i = 0; i < 100 && grid.dataset.state !== "ready"; i += 1) {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  }
}

/** Finds the thumbnail button whose visible name matches. */
export const optionByName = (
  window: Window,
  name: string,
): HTMLButtonElement => {
  const option = [...imageGrid(window).querySelectorAll("button")].find(
    (item) => item.textContent === name,
  );
  if (option === undefined) {
    throw new Error(`the dialog carries no ${name} thumbnail`);
  }
  return option;
};

/** Fills the dialog's upload form with a name and submits it. */
export const submitUpload = async (
  dialog: HTMLDialogElement,
  name: string,
  file?: { bytes: number[]; name: string; type: string },
): Promise<void> => {
  const form = dialog.querySelector<HTMLFormElement>(".md-image-upload")!;
  form.querySelector<HTMLInputElement>('input[name="name"]')!.value = name;
  if (file) {
    const input = form.querySelector<HTMLInputElement>('input[name="image"]')!;
    Object.defineProperty(input, "files", {
      value: [
        new File([new Uint8Array(file.bytes)], file.name, { type: file.type }),
      ],
    });
  }
  form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
  await flush();
};

/** Runs a few microtask hops so a stubbed fetch promise settles. */
export const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  }
};

/** Opens the dialog with `reply` queued and closes it before the answer
 * arrives, on a fake clock so the focus handler's flush drains. Asserts
 * the close-before-answer invariant holds (the dialog is shut) and
 * returns the grid and the handle. */
export const closeDialogBeforeAnswer = async (
  reply: FetchReply,
): Promise<{
  grid: HTMLElement;
  handle: Awaited<ReturnType<typeof enhanced>>["handle"];
}> => {
  const time = new FakeTime();
  try {
    fetchStubHolder.stub = stubFetch(reply);
    const { window, handle } = enhanced("hello");
    toolbarImageButton(window).click();
    const dialog = imageDialog(window);
    const grid = imageGrid(window);
    dialog.close();
    await flush();

    // The shut dialog is the invariant both close-early tests share; the
    // grid's state is each test's own observable.
    expect(dialog.open).toBe(false);
    return { grid, handle };
  } finally {
    // Drain the close-triggered focus flush, then put the real clock back.
    await time.tickAsync(30);
    time.restore();
  }
};

/** Opens the dialog and dismisses it with `dismiss`, asserting it shut,
 * tearing the dialog and view down, and draining the focus flush. */
export const expectDialogCloses = (
  dismiss: (opened: OpenDialogResult) => void,
): Promise<void> =>
  withDialogClock([twoImageList()], {}, async (opened, flushSelection) => {
    dismiss(opened);
    expect(opened.dialog.open).toBe(false);
    opened.handle.view.destroy();
    opened.dialog.remove();
    await flushSelection();
  });

/** The dialog over the standard two-image library with an empty refetch
 * queued, on a fake clock: the mount the caret-insert tests share. */
export const withInsertFlow = withFlow([json({ images: [] })], {});

/** Mounts the editor over `markdown` against a stubbed library and returns
 * the rendered image element once its lookup settles. Later calls in one
 * test replace the earlier stub, so a case table can share this. */
export const renderEditorImage = async (
  markdown: string,
  reply: FetchReply = twoImageList(),
): Promise<{
  image: HTMLImageElement;
  handle: Awaited<ReturnType<typeof enhanced>>["handle"];
}> => {
  restoreHeldStub();
  fetchStubHolder.stub = stubFetch(reply);
  const { window, handle } = enhanced(markdown);
  const image = requireElement<HTMLImageElement>(
    window.document,
    ".ProseMirror img",
  );
  await flush();
  return { handle, image };
};
