/**
 * Modal — focus-trapped dialog with Escape-close and backdrop click-out.
 * Portal rendered to document.body to avoid SSR/hydration mismatch.
 *
 * Design tokens used: color.*, radius.lg, type.base, spacing.*
 */

"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconX } from "@tabler/icons-react";

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  /** Dialog title shown in the header */
  title: string;
  /** Called when the user dismisses the modal (Escape, backdrop click) */
  onClose: () => void;
  /** Dialog content */
  children: React.ReactNode;
  /** Optional className for the dialog body */
  className?: string;
  /** Override the default max-width */
  maxWidth?: string;
}

export function Modal({
  title,
  onClose,
  children,
  className = "",
  maxWidth = "360px",
}: ModalProps) {
  // Portal to document.body only once mounted client-side, same as Toast.tsx —
  // avoids an SSR/hydration mismatch on document.body.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Keep the latest onClose in a ref so the keydown listener below can stay
  // registered once instead of tearing down/re-adding on every render (most
  // callers pass a fresh inline arrow function each time).
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Move focus into the dialog on open, trap Tab within it while open, and
  // restore focus to whatever had it beforehand on close — aria-modal alone
  // doesn't get any of this for free.
  useEffect(() => {
    if (!mounted) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      // Disabled elements match the selector but are skipped by real Tab
      // navigation — excluding them keeps first/last aligned with where the
      // browser will actually land (e.g. a submit button disabled until a
      // form field is filled shouldn't be treated as the last stop).
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => !el.hasAttribute("disabled"));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused.current?.focus?.();
    };
  }, [mounted]);

  if (!mounted) return null;

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className={`modal card ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth,
          maxHeight: "calc(100vh - 2.5rem)",
        }}
      >
        <div
          className="modal-header"
          style={{
            marginBottom: "var(--spacing-lg, 1rem)",
          }}
        >
          <span className="eyebrow">{title}</span>
          <button
            className="btn btn-ghost btn-sm modal-close-btn"
            onClick={onClose}
            aria-label="Close"
          >
            <IconX size={15} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
