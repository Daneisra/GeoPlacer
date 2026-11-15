import { useCallback, useState } from 'react';
import { useToast } from '../ui';
import { errorText } from '../../lib/engine';

/**
 * Runs one engine command at a time (no double click), and reports the
 * server's answer: its stable code and readable message on a refusal.
 */
export function useCommand() {
  const toast = useToast();
  const [pending, setPending] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(name: string, fn: () => Promise<T>, success?: string): Promise<T | null> => {
      if (pending !== null) return null;
      setPending(name);
      try {
        const result = await fn();
        if (success !== undefined) toast.success(name, success);
        return result;
      } catch (error) {
        const { code, message } = errorText(error);
        toast.error(`${name} : refusé`, `${message} (${code})`);
        return null;
      } finally {
        setPending(null);
      }
    },
    [pending, toast]
  );
  return { pending, run };
}
