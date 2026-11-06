import { test } from "node:test";
import assert from "node:assert/strict";

import { registerSearchShortcut } from "./search-shortcut";

type KeyOptions = Partial<
  Pick<
    KeyboardEvent,
    "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing"
  >
>;

function keydown(options: KeyOptions = {}) {
  return Object.assign(new Event("keydown", { cancelable: true }), {
    key: "k",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    ...options,
  });
}

function setup(platform: string) {
  const document = Object.assign(new EventTarget(), {
    defaultView: { navigator: { platform } },
  });
  const calls: string[] = [];
  const input = {
    ownerDocument: document,
    value: "node",
    focus: () => calls.push("focus"),
    select: () => calls.push("select"),
  };
  const cleanup = registerSearchShortcut(input as unknown as HTMLInputElement);
  return { document, input, calls, cleanup };
}

for (const [platform, modifier, otherModifier] of [
  ["Linux x86_64", { ctrlKey: true }, { metaKey: true }],
  ["Win32", { ctrlKey: true }, { metaKey: true }],
  ["MacIntel", { metaKey: true }, { ctrlKey: true }],
] as const) {
  test(`${platform}: the search shortcut focuses and selects the current query`, (t) => {
    const { document, input, calls, cleanup } = setup(platform);
    t.after(cleanup);

    for (const key of ["k", "K"]) {
      const event = keydown({ ...modifier, key });
      document.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true);
    }

    assert.deepEqual(calls, ["focus", "select", "focus", "select"]);
    assert.equal(input.value, "node");
  });

  test(`${platform}: unrelated keys, modifiers and composition are untouched`, (t) => {
    const { document, calls, cleanup } = setup(platform);
    t.after(cleanup);

    for (const options of [
      {},
      otherModifier,
      { ...modifier, key: "j" },
      { ...modifier, altKey: true },
      { ...modifier, shiftKey: true },
      { ctrlKey: true, metaKey: true },
      { ...modifier, isComposing: true },
    ]) {
      const event = keydown(options);
      document.dispatchEvent(event);
      assert.equal(event.defaultPrevented, false, JSON.stringify(options));
    }

    assert.deepEqual(calls, []);
  });
}

test("an already handled shortcut does not move focus", (t) => {
  const { document, calls, cleanup } = setup("Linux x86_64");
  t.after(cleanup);
  const event = keydown({ ctrlKey: true });
  event.preventDefault();
  document.dispatchEvent(event);
  assert.deepEqual(calls, []);
});

test("cleanup removes the global shortcut listener", () => {
  const { document, calls, cleanup } = setup("Linux x86_64");
  cleanup();

  const event = keydown({ ctrlKey: true });
  document.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(calls, []);
});
