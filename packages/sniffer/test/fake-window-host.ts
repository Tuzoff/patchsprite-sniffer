// A fake window host for tests: every method fails unless the test gives it.
import type { WindowHost } from "../src/walk/host.ts";

export function fakeWindowHost(over: Partial<WindowHost>): WindowHost {
  const no = (name: string) => async () => {
    throw new Error(`the fake host has no ${name}`);
  };
  return {
    find: no("find"),
    front: async () => ({ front: true }),
    shot: no("shot"),
    click: no("click"),
    wheel: no("wheel"),
    drag: no("drag"),
    keys: no("keys"),
    type: no("type"),
    element: no("element"),
    focused: async () => ({ found: false }),
    dialogs: no("dialogs"),
    fill: no("fill"),
    close() {},
    ...over,
  };
}
