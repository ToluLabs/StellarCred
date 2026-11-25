"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * Elements a keyboard user can Tab to. Disabled controls and anything taken
 * out of the tab order with tabindex="-1" are filtered out in
 * `getFocusableElements`, so the trap's first/last stops match where the
 * browser will actually land.
 */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button",
  "input",
  "select",
  "textarea",
  "iframe",
  "summary",
  "[contenteditable='true']",
  "[tabindex]",
].join(", ");

/** Focusable descendants of `root`, in DOM (tab) order. */
export function getFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) =>
      !el.hasAttribute("disabled") &&
      el.getAttribute("tabindex") !== "-1" &&
      el.getAttribute("aria-hidden") !== "true" &&
      !el.closest("[hidden], [inert]"),
  );
}

export interface FocusTrapOptions {
  /** Called on Escape. Omit to leave Escape alone. */
  onEscape?: () => void;
  /**
   * Element to focus when the trap opens. Defaults to the first focusable
   * descendant, falling back to the container itself (give it tabIndex={-1}).
   */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Restore focus to the element focused before opening. Default true. */
  restoreFocus?: boolean;
  /** Turn the trap on or off without unmounting. Default true. */
  active?: boolean;
}

/**
 * Keyboard focus management for a modal dialog (WCAG 2.1 SC 2.1.2, 2.4.3):
 * moves focus into the dialog on open, keeps Tab / Shift+Tab cycling inside
 * it, closes on Escape, and returns focus to the trigger on close.
 */
export function useFocusTrap<T extends HTMLElement>(
  containerRef: RefObject<T | null>,
  { onEscape, initialFocusRef, restoreFocus = true, active = true }: FocusTrapOptions = {},
) {
  // Latest callback in a ref so the listener registers once per activation
  // even when callers pass a fresh inline function every render.
  const onEscapeRef = useRef(onEscape);
  useEffect(() => {
    onEscapeRef.current = onEscape;
  });

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const initial = initialFocusRef?.current ?? getFocusableElements(container)[0] ?? container;
    initial.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && onEscapeRef.current) {
        e.stopPropagation();
        onEscapeRef.current();
        return;
      }
      if (e.key !== "Tab" || !container) return;
      const focusable = getFocusableElements(container);
      if (focusable.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;
      const outside = !container.contains(current);
      if (e.shiftKey && (current === first || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || outside)) {
        e.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (restoreFocus) previouslyFocused?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
