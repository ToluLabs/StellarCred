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
import { useFocusTrap } from "@/lib/hooks/useFocusTrap";

export interface ModalProps {
  /** Optional HTML id prefix for ARIA attributes */
  id?: string;
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
  id,
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
  const titleId = id
    ? `${id}-title`
    : `modal-title-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  // Move focus into the dialog on open, trap Tab within it while open, close
  // on Escape, and restore focus to whatever had it beforehand on close —
  // aria-modal alone doesn't get any of this for free.
  useFocusTrap(dialogRef, { onEscape: onClose, initialFocusRef: dialogRef, active: mounted });

  if (!mounted) return null;

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className={`modal card ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
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
          <h2
            id={titleId}
            className="eyebrow"
            style={{ margin: 0, fontSize: "inherit", fontWeight: "inherit" }}
          >
            {title}
          </h2>
          <button
            className="btn btn-ghost btn-sm modal-close-btn"
            onClick={onClose}
            aria-label="Close"
          >
            <IconX size={15} aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
