export type PeerGroupsSearchShortcutInput = {
  key: string;
  defaultPrevented: boolean;
  isComposing: boolean;
  repeat: boolean;
  editableTarget: boolean;
  blockedSurfaceOpen: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
};

export function shouldFocusPeerGroupsSearch(input: PeerGroupsSearchShortcutInput): boolean {
  if (input.key !== "/") return false;
  return !(
    input.defaultPrevented
    || input.isComposing
    || input.repeat
    || input.editableTarget
    || input.blockedSurfaceOpen
    || input.altKey
    || input.ctrlKey
    || input.metaKey
    || input.shiftKey
  );
}
