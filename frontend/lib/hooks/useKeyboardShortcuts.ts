"use client";

import { useEffect, useRef } from "react";

export interface UseKeyboardShortcutsOptions {
  /** Whether shortcuts are active (e.g. false when a modal is open). */
  enabled?: boolean;
  /** Number of items in the navigable list. */
  itemCount: number;
  /** Currently highlighted item index (-1 when none). */
  activeIndex: number;
  /** Update the highlighted item index. */
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>;
  /** Focus the search/filter input ('/'). */
  onFocusSearch?: () => void;
  /** Inspect / view details of the active item ('v' or Enter). */
  onInspect?: (index: number) => void;
  /** Prove / re-prove the active item ('p'). */
  onProve?: (index: number) => void;
  /** Toggle batch selection on the active item ('x'). */
  onToggleSelect?: (index: number) => void;
  /** Open the export modal ('e'). */
  onExport?: () => void;
  /** Open the keyboard shortcut cheat sheet ('?'). */
  onOpenHelp?: () => void;
  /** Clear active selection or search ('Escape'). */
  onEscape?: () => void;
}

/**
 * Returns true if the event target is an editable form control where single-key
 * shortcuts should not hijack typing.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return Boolean(
    target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']"),
  );
}

/** Returns true if the target is an interactive control that handles Enter itself. */
function isInteractiveControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("button, a[href], summary, [role='button'], [role='link']"));
}

/**
 * Keyboard navigation and triage hotkeys for credential lists.
 *
 * Supports:
 * - `/` to focus search
 * - `j` / `ArrowDown` and `k` / `ArrowUp` to traverse items
 * - `v` (or `Enter` on non-interactive focus) to view details
 * - `p` to prove / re-prove
 * - `x` to toggle batch selection
 * - `e` to open export
 * - `?` to open the shortcut cheat sheet
 * - `Escape` to clear active state
 */
export function useKeyboardShortcuts(options: UseKeyboardShortcutsOptions): void {
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const opts = optionsRef.current;
      if (opts.enabled === false) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.key === "Escape") {
        if (!isEditableTarget(e.target) && opts.onEscape) {
          opts.onEscape();
        }
        return;
      }

      if (isEditableTarget(e.target)) return;

      const { itemCount, activeIndex, setActiveIndex } = opts;

      switch (e.key) {
        case "/": {
          if (opts.onFocusSearch) {
            e.preventDefault();
            opts.onFocusSearch();
          }
          break;
        }
        case "?": {
          if (opts.onOpenHelp) {
            e.preventDefault();
            opts.onOpenHelp();
          }
          break;
        }
        case "j":
        case "ArrowDown": {
          if (itemCount <= 0) return;
          e.preventDefault();
          setActiveIndex((prev) => (prev < 0 ? 0 : Math.min(prev + 1, itemCount - 1)));
          break;
        }
        case "k":
        case "ArrowUp": {
          if (itemCount <= 0) return;
          e.preventDefault();
          setActiveIndex((prev) => (prev < 0 ? itemCount - 1 : Math.max(prev - 1, 0)));
          break;
        }
        case "v": {
          if (activeIndex >= 0 && activeIndex < itemCount && opts.onInspect) {
            e.preventDefault();
            opts.onInspect(activeIndex);
          }
          break;
        }
        case "Enter": {
          if (
            activeIndex >= 0 &&
            activeIndex < itemCount &&
            opts.onInspect &&
            !isInteractiveControl(e.target)
          ) {
            e.preventDefault();
            opts.onInspect(activeIndex);
          }
          break;
        }
        case "p": {
          if (activeIndex >= 0 && activeIndex < itemCount && opts.onProve) {
            e.preventDefault();
            opts.onProve(activeIndex);
          }
          break;
        }
        case "x": {
          if (activeIndex >= 0 && activeIndex < itemCount && opts.onToggleSelect) {
            e.preventDefault();
            opts.onToggleSelect(activeIndex);
          }
          break;
        }
        case "e": {
          if (opts.onExport) {
            e.preventDefault();
            opts.onExport();
          }
          break;
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
