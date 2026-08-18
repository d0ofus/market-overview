import assert from "node:assert/strict";
import test from "node:test";
import { shouldFocusPeerGroupsSearch } from "./peer-groups-search-shortcut";

const eligible = {
  key: "/",
  defaultPrevented: false,
  isComposing: false,
  repeat: false,
  editableTarget: false,
  blockedSurfaceOpen: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
};

test("peer groups search shortcut accepts plain slash", () => {
  assert.equal(shouldFocusPeerGroupsSearch(eligible), true);
});

test("peer groups search shortcut ignores unrelated keys", () => {
  assert.equal(shouldFocusPeerGroupsSearch({ ...eligible, key: "s" }), false);
  assert.equal(shouldFocusPeerGroupsSearch({ ...eligible, key: "?", shiftKey: true }), false);
});

test("peer groups search shortcut ignores blocked events", () => {
  const blockedInputs = [
    { defaultPrevented: true },
    { isComposing: true },
    { repeat: true },
    { editableTarget: true },
    { blockedSurfaceOpen: true },
    { altKey: true },
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
  ];

  for (const blockedInput of blockedInputs) {
    assert.equal(shouldFocusPeerGroupsSearch({ ...eligible, ...blockedInput }), false);
  }
});
