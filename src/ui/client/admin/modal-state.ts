// effects: pure
import { requiredMapValue } from "#fp";
import {
  clampModalPosition,
  type ModalSize,
  type Point,
} from "./modal-position.ts";

/** Bottom-first window order. A saved point marks a minimised window. */
export type ModalState = {
  readonly key: string;
  readonly point: Point;
  readonly expandedPoint: Point | null;
};

export type ModalEvent =
  | { type: "open"; key: string; point: Point }
  | { type: "raise"; key: string }
  | { type: "close"; key: string }
  | { type: "minimise"; key: string }
  | { type: "restore"; key: string; size: ModalSize; viewport: ModalSize }
  | {
      type: "move";
      key: string;
      point: Point;
      size: ModalSize;
      viewport: ModalSize;
    }
  | {
      type: "resize";
      sizes: ReadonlyMap<string, ModalSize>;
      viewport: ModalSize;
    };

const resizeModals = (
  states: readonly ModalState[],
  event: Extract<ModalEvent, { type: "resize" }>,
): readonly ModalState[] => {
  let resized: ModalState[] | undefined;
  for (const [index, state] of states.entries()) {
    const size = requiredMapValue(event.sizes, state.key);
    const point = clampModalPosition(state.point, size, event.viewport);
    if (point.left !== state.point.left || point.top !== state.point.top) {
      resized ??= [...states];
      resized[index] = { ...state, point };
    }
  }
  return resized ?? states;
};

const positionModal = (
  state: ModalState,
  event: Extract<ModalEvent, { type: "minimise" | "restore" | "move" }>,
): ModalState => {
  if (event.type === "minimise") {
    if (state.expandedPoint !== null) return state;
    return { ...state, expandedPoint: state.point };
  }
  const point = event.type === "move" ? event.point : state.expandedPoint;
  if (point === null) return state;
  const updated = {
    ...state,
    expandedPoint: event.type === "restore" ? null : state.expandedPoint,
    point: clampModalPosition(point, event.size, event.viewport),
  };
  if (
    updated.expandedPoint === state.expandedPoint &&
    updated.point.left === state.point.left &&
    updated.point.top === state.point.top
  )
    return state;
  return updated;
};

/** Pure lifecycle core. Missing keys include queued events after close.
 * Callers supply measured sizes and finite pixel coordinates. Open is already
 * positioned. Resize requires every live window's size and keeps saved points. */
export const transitionModals = (
  states: readonly ModalState[],
  event: ModalEvent,
): readonly ModalState[] => {
  if (event.type === "resize") return resizeModals(states, event);
  const index = states.findIndex((state) => state.key === event.key);
  if (index < 0) {
    return event.type === "open"
      ? [...states, { expandedPoint: null, key: event.key, point: event.point }]
      : states;
  }
  const state = states[index]!;
  if (event.type === "open" || event.type === "raise") {
    return index === states.length - 1
      ? states
      : [...states.slice(0, index), ...states.slice(index + 1), state];
  }
  if (event.type === "close") {
    return [...states.slice(0, index), ...states.slice(index + 1)];
  }
  const updated = positionModal(state, event);
  if (updated === state) return states;
  return states.map((current, at) => (at === index ? updated : current));
};
