import { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';

export type ConnectionStatus = 'connected' | 'disconnected' | 'checking';

interface ServerStatus {
  status: ConnectionStatus;
  lastChecked: Date | null;
  error: string | null;
}

export function useServerStatus(pollInterval = 5000) {
  const [serverStatus, setServerStatus] = useState<ServerStatus>({
    status: 'checking',
    lastChecked: null,
    error: null,
  });
  const mounted = useRef(true);

  // The last known status stays shown until the answer (the initial one is 'checking'); the state is
  // only set in the promise callbacks.
  const checkConnection = useCallback(
    () =>
      axios.get('/settings', { timeout: 3000 }).then(
        () => {
          if (mounted.current) setServerStatus({ status: 'connected', lastChecked: new Date(), error: null });
        },
        (err: unknown) => {
          if (mounted.current) setServerStatus({ status: 'disconnected', lastChecked: new Date(), error: err instanceof Error ? err.message : 'Server unreachable' });
        }
      ),
    []
  );

  useEffect(() => {
    mounted.current = true;

    void checkConnection();

    const interval = setInterval(checkConnection, pollInterval);

    return () => {
      mounted.current = false;
      clearInterval(interval);
    };
  }, [checkConnection, pollInterval]);

  return {
    ...serverStatus,
    isConnected: serverStatus.status === 'connected',
    isChecking: serverStatus.status === 'checking',
    checkConnection,
  };
}
