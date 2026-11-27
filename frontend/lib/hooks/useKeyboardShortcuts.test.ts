import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { useKeyboardShortcuts, type UseKeyboardShortcutsOptions } from "./useKeyboardShortcuts";

function dispatchKey(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
}

function useHarness(
  options: Partial<Omit<UseKeyboardShortcutsOptions, "activeIndex" | "setActiveIndex">> & {
    itemCount?: number;
    initialActive?: number;
  } = {},
) {
  const { itemCount = 3, initialActive = -1, ...rest } = options;
  const [activeIndex, setActiveIndex] = useState(initialActive);
  useKeyboardShortcuts({
    itemCount,
    activeIndex,
    setActiveIndex,
    ...rest,
  });
  return { activeIndex };
}

describe("useKeyboardShortcuts", () => {
  it("traverses items with j/k and ArrowDown/ArrowUp and clamps bounds", () => {
    const { result } = renderHook(() => useHarness({ itemCount: 3 }));
    expect(result.current.activeIndex).toBe(-1);

    act(() => dispatchKey(window, "j"));
    expect(result.current.activeIndex).toBe(0);

    act(() => dispatchKey(window, "j"));
    expect(result.current.activeIndex).toBe(1);

    act(() => dispatchKey(window, "ArrowDown"));
    expect(result.current.activeIndex).toBe(2);

    // Clamps at last item
    act(() => dispatchKey(window, "j"));
    expect(result.current.activeIndex).toBe(2);

    act(() => dispatchKey(window, "k"));
    expect(result.current.activeIndex).toBe(1);

    act(() => dispatchKey(window, "ArrowUp"));
    expect(result.current.activeIndex).toBe(0);

    // Clamps at first item
    act(() => dispatchKey(window, "k"));
    expect(result.current.activeIndex).toBe(0);
  });

  it("jumps to last item when pressing k from unselected state", () => {
    const { result } = renderHook(() => useHarness({ itemCount: 4 }));
    act(() => dispatchKey(window, "k"));
    expect(result.current.activeIndex).toBe(3);
  });

  it("fires action callbacks for active item and ignores them when activeIndex is -1", () => {
    const onFocusSearch = vi.fn();
    const onInspect = vi.fn();
    const onProve = vi.fn();
    const onToggleSelect = vi.fn();
    const onExport = vi.fn();
    const onOpenHelp = vi.fn();
    const onEscape = vi.fn();

    const { rerender } = renderHook(
      ({ enabled = true }: { enabled?: boolean }) =>
        useHarness({
          itemCount: 2,
          initialActive: -1,
          enabled,
          onFocusSearch,
          onInspect,
          onProve,
          onToggleSelect,
          onExport,
          onOpenHelp,
          onEscape,
        }),
      { initialProps: { enabled: true } },
    );

    // Item-scoped actions do nothing when activeIndex is -1
    act(() => {
      dispatchKey(window, "v");
      dispatchKey(window, "p");
      dispatchKey(window, "x");
    });
    expect(onInspect).not.toHaveBeenCalled();
    expect(onProve).not.toHaveBeenCalled();
    expect(onToggleSelect).not.toHaveBeenCalled();

    // Global actions still fire
    act(() => {
      dispatchKey(window, "/");
      dispatchKey(window, "?");
      dispatchKey(window, "e");
      dispatchKey(window, "Escape");
    });
    expect(onFocusSearch).toHaveBeenCalledTimes(1);
    expect(onOpenHelp).toHaveBeenCalledTimes(1);
    expect(onExport).toHaveBeenCalledTimes(1);
    expect(onEscape).toHaveBeenCalledTimes(1);

    // Move to item 0 and trigger item actions
    act(() => dispatchKey(window, "j"));
    act(() => {
      dispatchKey(window, "v");
      dispatchKey(window, "p");
      dispatchKey(window, "x");
    });
    expect(onInspect).toHaveBeenCalledWith(0);
    expect(onProve).toHaveBeenCalledWith(0);
    expect(onToggleSelect).toHaveBeenCalledWith(0);

    rerender({ enabled: false });
    act(() => {
      dispatchKey(window, "/");
      dispatchKey(window, "?");
    });
    expect(onFocusSearch).toHaveBeenCalledTimes(1);
    expect(onOpenHelp).toHaveBeenCalledTimes(1);
  });

  it("ignores shortcuts inside editable controls and with modifier keys", () => {
    const onFocusSearch = vi.fn();
    const onOpenHelp = vi.fn();
    const onInspect = vi.fn();

    renderHook(() =>
      useHarness({
        itemCount: 2,
        initialActive: 0,
        onFocusSearch,
        onOpenHelp,
        onInspect,
      }),
    );

    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const button = document.createElement("button");
    document.body.append(input, textarea, button);

    try {
      act(() => {
        dispatchKey(input, "/");
        dispatchKey(input, "v");
        dispatchKey(textarea, "?");
        dispatchKey(window, "/", { ctrlKey: true });
        dispatchKey(window, "v", { metaKey: true });
        dispatchKey(window, "e", { altKey: true });
        dispatchKey(button, "Enter");
      });

      expect(onFocusSearch).not.toHaveBeenCalled();
      expect(onOpenHelp).not.toHaveBeenCalled();
      expect(onInspect).not.toHaveBeenCalled();
    } finally {
      input.remove();
      textarea.remove();
      button.remove();
    }
  });
});
