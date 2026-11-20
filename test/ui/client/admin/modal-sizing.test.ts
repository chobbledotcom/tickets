import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { closeAdminModal } from "#src/ui/client/admin/modal.ts";
import {
  cleanupModals,
  dialogsIn,
  dragPage,
  fire,
  movePointer,
  open,
  page,
  placed,
  pressTitleBar,
  releasePointer,
  SETTINGS,
  setSize,
} from "#test-utils/modal-dom.ts";

describe("the admin modal size", () => {
  afterEach(cleanupModals);

  test("keeps a window on the screen after the viewport changes", () => {
    const ready = dragPage();
    const { dialog, window } = ready;
    pressTitleBar(ready);
    setSize(window, 200, 100);

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 400,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 300,
    });
    fire(window, window, "resize");

    movePointer(ready, 5000, 5000);
    expect(placed(dialog)).toEqual({ left: 200, top: 200 });
    releasePointer(ready);
    fire(window, window, "resize");
  });

  test("keeps the window on screen after its content grows and disconnects on close", () => {
    const window = page();
    let resize: () => void = () => {
      throw new Error("The window has no size observer");
    };
    let disconnected = 0;
    const NativeObserver = window.ResizeObserver;
    Object.defineProperty(window, "ResizeObserver", {
      value: class extends NativeObserver {
        constructor(callback: () => void) {
          super();
          resize = callback;
        }

        override disconnect(): void {
          super.disconnect();
          disconnected++;
        }
      },
    });
    const dialog = open(window);
    setSize(window, window.innerWidth, window.innerHeight);
    resize();
    expect(placed(dialog)).toEqual({ left: 0, top: 0 });
    closeAdminModal(SETTINGS.key);
    expect(disconnected).toBe(1);
    expect(dialogsIn(window)).toEqual([]);
  });
});
