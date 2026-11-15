import { useSyncExternalStore } from 'react';
import type { Toast, ToastType } from './Toast';

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
