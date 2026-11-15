import { useEffect, useSyncExternalStore } from 'react';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message: string;
}

interface ToastItemProps extends Toast {
  onClose: (id: string) => void;
  duration?: number;
}

const icons: Record<ToastType, string> = {
  success: 'OK',
  error: 'ERR',
  warning: 'WARN',
  info: 'INFO',
};

function ToastItem({ id, type, title, message, onClose, duration = 5000 }: ToastItemProps) {
  useEffect(() => {
    const timer = setTimeout(() => {
      onClose(id);
    }, duration);

    return () => clearTimeout(timer);
  }, [id, duration, onClose]);

  return (
    <div className={`toast toast-${type}`}>
      <span className="toast-icon">{icons[type]}</span>
      <div className="toast-content">
        <div className="toast-title">{title}</div>
        <div className="toast-message">{message}</div>
      </div>
      <button className="toast-close" onClick={() => onClose(id)} aria-label="Close">
        ×
      </button>
    </div>
  );
}

interface ToastContainerProps {
  toasts: Toast[];
  onClose: (id: string) => void;
}

export function ToastContainer({ toasts, onClose }: ToastContainerProps) {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-container" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} {...toast} onClose={onClose} />
      ))}
    </div>
  );
}

// Shared toast store (module level): every component that calls useToast()
// adds to, and reads from, the same list. Before (inherited code), each call
// had its own useState, so the toasts of Settings, Users and Add Template
// were never rendered by the container of App.
let current: Toast[] = [];
const listeners = new Set<() => void>();

function setToasts(next: Toast[]): void {
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = (): Toast[] => current;

function addToast(type: ToastType, title: string, message: string): string {
  const id = `${Date.now()}-${Math.random()}`;
  setToasts([...current, { id, type, title, message }]);
  return id;
}

function removeToast(id: string): void {
  setToasts(current.filter((t) => t.id !== id));
}

// Hook for managing toasts
export function useToast() {
  const toasts = useSyncExternalStore(subscribe, snapshot, snapshot);
  return {
    toasts,
    addToast,
    removeToast,
    success: (title: string, message: string) => addToast('success', title, message),
    error: (title: string, message: string) => addToast('error', title, message),
    warning: (title: string, message: string) => addToast('warning', title, message),
    info: (title: string, message: string) => addToast('info', title, message),
  };
}
