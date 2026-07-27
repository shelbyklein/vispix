import { useSyncExternalStore } from "react";

// Desktop Create panel state (#167 UX): the Create workspace slides out of the
// right side of the app instead of taking a full page, so the library stays
// visible while generating. Tiny module store — no provider needed, and the
// sidebar nav + panel can both reach it.

let open = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export const createPanel = {
  isOpen: () => open,
  set(next: boolean) {
    if (open === next) return;
    open = next;
    emit();
  },
  toggle() {
    open = !open;
    emit();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export function useCreatePanelOpen(): boolean {
  return useSyncExternalStore(createPanel.subscribe, createPanel.isOpen);
}
