import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardHeader, CardTitle, CardContent } from './ui';

export default function LogsViewer() {
  const navigate = useNavigate();
  const [logs, setLogs] = useState<string[]>([]);
  const [filterText, setFilterText] = useState('');
  const [filterType, setFilterType] = useState('');
  const [logsMode, setLogsMode] = useState<'logs' | 'errors'>('logs');
  const [isConnected, setIsConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let isActive = true;

    const connect = () => {
      if (!isActive) return;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

      // Close any existing connection first
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }

      const host = import.meta.env.DEV ? `${window.location.hostname}:3000` : window.location.host;
      const ws = new WebSocket(`${protocol}//${host}`);
      wsRef.current = ws;
      setConnectionError(null);

      ws.onopen = () => {
        if (!isActive) {
          ws.close();
          return;
        }
        setIsConnected(true);
        ws.send(JSON.stringify({ type: logsMode }));
      };

      ws.onmessage = (event) => {
        if (!isActive) return;
        setLogs((prev) => {
          const newLogs = [...prev, event.data];
          return newLogs.slice(-2000);
        });
      };

      ws.onerror = () => {
        if (!isActive) return;
        setIsConnected(false);
        setConnectionError('Connexion au journal interrompue');
      };

      ws.onclose = () => {
        if (!isActive) return;
        setIsConnected(false);
        // Auto-reconnect after 2 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          if (isActive) connect();
        }, 2000);
      };
    };

    connect();

    return () => {
      isActive = false;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [logsMode]);

  const handleClearLogs = () => {
    setLogs([]);
  };

  const handleExportLogs = () => {
    const filteredLogs = logs.filter((log) => {
      if (filterText && !log.toLowerCase().includes(filterText.toLowerCase())) {
        return false;
      }
      if (filterType && !log.toLowerCase().includes(filterType.toLowerCase())) {
        return false;
      }
      return true;
    });

    const blob = new Blob([filteredLogs.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `geoplacer-${logsMode}-${new Date().toISOString()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const filteredLogs = logs.filter((log) => {
    if (filterText && !log.toLowerCase().includes(filterText.toLowerCase())) {
      return false;
    }
    if (filterType && !log.toLowerCase().includes(filterType.toLowerCase())) {
      return false;
    }
    return true;
  });

  return (
    <div id="logsViewer" className="space-y-6">
      <div className="studio-page-heading"><div><h1>Journal</h1><p>Messages et erreurs du serveur local.</p></div></div>
      
      <Card>
        <CardHeader>
          <CardTitle>Filtres et export</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <input
              className="flex-1 p-2 border rounded-md"
              type="text"
              aria-label="Rechercher dans le journal"
              placeholder="Rechercher un message"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
            />
            <select
              className="p-2 border rounded-md"
              aria-label="Niveau du message"
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
            >
              <option value="">Tous</option>
              <option value="error">Erreur</option>
              <option value="warn">Avertissement</option>
              <option value="success">Succès</option>
              <option value="info">Info</option>
            </select>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className={`px-4 py-2 rounded-md ${logsMode === 'logs' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground'} hover:opacity-80`}
              onClick={() => setLogsMode('logs')}
            >
              Messages
            </button>
            <button
              className={`px-4 py-2 rounded-md ${logsMode === 'errors' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground'} hover:opacity-80`}
              onClick={() => setLogsMode('errors')}
            >
              Erreurs
            </button>
            <button className="bg-secondary text-secondary-foreground px-4 py-2 rounded-md hover:bg-secondary/80" onClick={handleClearLogs}>
              Vider l’affichage
            </button>
            <button className="bg-secondary text-secondary-foreground px-4 py-2 rounded-md hover:bg-secondary/80" onClick={handleExportLogs}>
              Exporter
            </button>
            <button className="bg-secondary text-secondary-foreground px-4 py-2 rounded-md hover:bg-secondary/80" onClick={() => navigate('/')}>
              Retour au tableau de bord
            </button>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                isConnected ? 'bg-green-500' : connectionError ? 'bg-red-500' : 'bg-yellow-500'
              }`}
            />
            <span className="text-muted-foreground">
              {isConnected ? 'Connecté' : connectionError ? connectionError : 'Connexion…'}
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <div className="logs-container bg-muted p-4 rounded-lg min-h-96 max-h-96 overflow-y-auto font-mono text-sm">
            {filteredLogs.length === 0 ? (
              <span className="text-muted-foreground">
                {isConnected ? 'En attente de messages…' : connectionError ? 'Reconnexion au journal…' : 'Connexion au serveur…'}
              </span>
            ) : (
              filteredLogs.map((log, index) => (
                <div key={index} className="py-1 border-b border-border last:border-0">{log}</div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
