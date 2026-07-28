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

type ToastVariant = "info" | "success" | "error";

type ToastOptions = { txHash?: string };

type ToastEntry = {
  id: number;
  variant: ToastVariant;
  message: string;
  txHash?: string;
};

type ToastContextValue = {
  info: (message: string, opts?: ToastOptions) => number;
  success: (message: string, opts?: ToastOptions) => number;
  error: (message: string, opts?: ToastOptions) => number;
  dismiss: (id: number) => void;
};

const AUTO_DISMISS_MS = 5000;

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
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, variant, message, txHash: opts?.txHash }]);
      timers.current.set(id, setTimeout(() => dismiss(id), AUTO_DISMISS_MS));
      return id;
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
    <div className="toast-stack" role="region" aria-label="Notifications">
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
    <div className={`toast toast-${toast.variant}`} role="status">
      <span className="toast-icon">{icon}</span>
      <div className="toast-body">
        <span className="toast-message">{toast.message}</span>
        {toast.txHash && (
          <a
            href={EXPLORER_TX(toast.txHash)}
            target="_blank"
            rel="noreferrer"
            className="toast-link"
          >
            {toast.txHash.slice(0, 8)}...{toast.txHash.slice(-6)}
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
