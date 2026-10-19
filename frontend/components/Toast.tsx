"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  IconCheck,
  IconX,
  IconAlertTriangle,
  IconExternalLink,
  IconLoader2,
} from "@tabler/icons-react";
import { EXPLORER_TX } from "@/lib/stellar";
import { truncateTxHash } from "@/lib/format";

type ToastVariant = "info" | "success" | "error";

type ToastOptions = { txHash?: string };

type ToastEntry = {
  id: number;
  variant: ToastVariant;
  message: string;
  txHash?: string;
  count: number;
};

type ToastContextValue = {
  info: (message: string, opts?: ToastOptions) => number;
  success: (message: string, opts?: ToastOptions) => number;
  error: (message: string, opts?: ToastOptions) => number;
  dismiss: (id: number) => void;
};

const AUTO_DISMISS_MS = 5000;
const MAX_VISIBLE_TOASTS = 3;

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const [mounted, setMounted] = useState(false);
  const nextId = useRef(0);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    setMounted(true);
    const activeTimers = timers.current;
    return () => {
      activeTimers.forEach((timer) => clearTimeout(timer));
      activeTimers.clear();
    };
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (variant: ToastVariant, message: string, opts?: ToastOptions) => {
      let resultId = nextId.current++;
      setToasts((prev) => {
        const last = prev[prev.length - 1];
        if (
          last &&
          last.variant === variant &&
          last.message === message &&
          last.txHash === opts?.txHash
        ) {
          resultId = last.id;
          const timer = timers.current.get(last.id);
          if (timer) clearTimeout(timer);
          timers.current.set(last.id, setTimeout(() => dismiss(last.id), AUTO_DISMISS_MS));
          return [...prev.slice(0, -1), { ...last, count: last.count + 1 }];
        }

        const entry: ToastEntry = { id: resultId, variant, message, txHash: opts?.txHash, count: 1 };
        const next = [...prev, entry];
        const removed = next.length > MAX_VISIBLE_TOASTS ? next.slice(0, -MAX_VISIBLE_TOASTS) : [];
        removed.forEach((toast) => {
          const timer = timers.current.get(toast.id);
          if (timer) clearTimeout(timer);
          timers.current.delete(toast.id);
        });
        timers.current.set(resultId, setTimeout(() => dismiss(resultId), AUTO_DISMISS_MS));
        return next.slice(-MAX_VISIBLE_TOASTS);
      });
      return resultId;
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      info: (message, opts) => push("info", message, opts),
      success: (message, opts) => push("success", message, opts),
      error: (message, opts) => push("error", message, opts),
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {mounted &&
        createPortal(<ToastStack toasts={toasts} onDismiss={dismiss} />, document.body)}
    </ToastContext.Provider>
  );
}

function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastEntry[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div
      className="toast-stack"
      role="status"
      aria-live={toasts.some((toast) => toast.variant === "error") ? "assertive" : "polite"}
      aria-atomic="false"
      aria-label="Notifications"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: ToastEntry; onDismiss: () => void }) {
  const icon =
    toast.variant === "success" ? (
      <IconCheck size={13} stroke={2.5} />
    ) : toast.variant === "error" ? (
      <IconAlertTriangle size={13} stroke={2} />
    ) : (
      <IconLoader2 size={13} stroke={2} className="spin" />
    );

  return (
    <div className={`toast toast-${toast.variant}`}>
      <span className="toast-icon">{icon}</span>
      <div className="toast-body">
        <span className="toast-message">
          {toast.message}
          {toast.count > 1 && <span className="toast-count"> ({toast.count})</span>}
        </span>
        {toast.txHash && (
          <a
            href={EXPLORER_TX(toast.txHash)}
            target="_blank"
            rel="noreferrer"
            className="toast-link"
          >
            {truncateTxHash(toast.txHash)}
            <IconExternalLink size={11} />
          </a>
        )}
      </div>
      <button className="toast-close" onClick={onDismiss} aria-label="Dismiss notification">
        <IconX size={13} />
      </button>
    </div>
  );
}
