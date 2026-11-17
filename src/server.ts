import { ConnectorHttpChannel } from '@geoplacer/engine-service';
import { createPrivilegedReaderRouter } from './api/v1/connector-http.js';
/**
 * Main server entry point
 * WPlace auto-drawing bot
 */

import express, { Router } from 'express';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { WebSocketServer, type WebSocket } from 'ws';
import type http from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import gradient from 'gradient-string';
import { fileURLToPath } from 'node:url';

// ES module equivalent of __dirname
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Version of GeoPlacer: package.json is the only source (6.0.0-rc.1: the first release candidate). */
const APP_VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version?: string }).version ?? 'inconnue';
  } catch {
    return 'inconnue';
  }
})();

// Import routes
import logsRouter from './routes/logs.js';
import tokensRouter from './routes/tokens.js';
import usersRouter from './routes/users.js';
import settingsRouter from './routes/settings.js';
import proxyRouter from './routes/proxy.js';
import paletteRouter from './routes/palette.js';
import colorOrderingRouter from './routes/color-ordering.js';
import templatesRouter from './routes/templates.js';
import bridgeRouter, { setBroadcastFunction } from './routes/bridge.js';
import overlayRouter from './routes/overlay.js';

// Import middleware
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { applyBaseProtections } from './app-base.js';
import { legacyGuard } from './middleware/legacy-guard.js';
// New engine (Phase 1B.9): local simulation only
import { createEngineRouter, isEngineOriginAllowed } from './api/v1/engine-router.js';
import { CONNECTOR_WS_PATH, createConnectorRouter, isLoopbackChannel } from './api/v1/connector-router.js';
import { attachConnectorSocket } from './api/v1/connector-socket.js';
import { ENGINE_WS_PATH, attachEngineSocket } from './api/v1/engine-socket.js';
import { EngineLockedError, engineDataDir, openEngine, type OpenedEngine } from './engine/bootstrap.js';

// Import services and utilities
import { networkInterfaces } from 'node:os';
import { isWildcardHost } from './config/network.js';
import { detectFrontend, isUiNavigation, uiDocumentMiddleware, FRONTEND_NOT_BUILT_MESSAGE } from './config/frontend.js';
import {
  buildAllowedHostnames,
  compileOriginPatterns,
  createWebSocketVerifier,
  type LocalAccessPolicy,
} from './middleware/local-access.js';
import { APP_HOST, SERVER_CONFIG, APP_PRIMARY_PORT, APP_FALLBACK_PORTS, DATA_DIR, USERS_FILE, SETTINGS_FILE, TEMPLATES_PATH, ALLOWED_ORIGINS, ALLOWED_HOSTS, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX, MAX_WS_CONNECTIONS, WS_PING_INTERVAL_MS, GRACEFUL_SHUTDOWN_TIMEOUT_MS, KEEP_ALIVE_INTERVAL_MS, MS, JSON_LIMIT } from './config/constants.js';
import { loadSettings } from './config/settings.js';
import { log, logger, wsLogClients, wsErrorClients } from './utils/logger.js';
import { loadJSON, saveJSON } from './utils/helpers.js';
import type { User, TemplateData } from './types/index.js';
import { setActiveBrowserUsers, setActiveTemplateUsers, setTemplateQueue, setActivePaintingTasks, processQueue, TemplateManager } from './services/template-manager.js';

// Import route state setters
import {
  setUsersState as setUsersRouteState,
  setTemplatesState as setTemplatesRouteState,
  setSettingsState as setSettingsRouteState,
  setSaveTemplates as setTemplatesSaveTemplates,
  setTemplateQueue as setTemplatesTemplateQueue,
  setProcessQueueFn as setTemplatesProcessQueueFn,
  getTemplates as getTemplatesFromRoutes,
} from './routes/templates.js';
import { setUsersState as setUsersRouteState2, setTemplatesState as setUsersTemplatesState, setSaveUsers, setSaveTemplates as setUsersSaveTemplates, setActiveBrowserUsers as setUsersActiveBrowserUsers } from './routes/users.js';
import { setSettingsState as setSettingsRouteState2, setSaveSettings, setLoadedProxies as setSettingsLoadedProxies } from './routes/settings.js';
import { setProxyFunctions, updateLoadedProxies } from './routes/proxy.js';

// Ensure data directory exists
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// Load settings
const currentSettings = loadSettings();

// Load users
const users = loadJSON<Record<string, User>>(USERS_FILE);

// Load templates
const templates = loadJSON<Record<string, TemplateData>>(TEMPLATES_PATH);

// Server state
const activeBrowserUsers = new Set<string>();
const activeTemplateUsers = new Set<string>();
const templateQueue: string[] = [];
const activePaintingTasks = { count: 0 };

// Initialize global state for services
setActiveBrowserUsers(activeBrowserUsers);
setActiveTemplateUsers(activeTemplateUsers);
setTemplateQueue(templateQueue);
setActivePaintingTasks(activePaintingTasks.count);

// Initialize route state
setUsersRouteState(users);
setTemplatesRouteState({} as Record<string, TemplateManager>); // Will be populated after migration
setSettingsRouteState(currentSettings);
setUsersRouteState2(users);
setUsersTemplatesState({} as Record<string, TemplateManager>);
setSettingsRouteState2(currentSettings);
setUsersActiveBrowserUsers(activeBrowserUsers);

// Proxy loading
const PROXIES_FILE = path.join(DATA_DIR, 'proxies.txt');
let loadedProxies: string[] = [];

function loadProxies(): void {
  if (existsSync(PROXIES_FILE)) {
    const data = readFileSync(PROXIES_FILE, 'utf8');
    loadedProxies = data.split('\n').filter((line: string) => line.trim());
    log('SYSTEM', 'wplacer', `Loaded ${loadedProxies.length} proxies.`);
  } else {
    loadedProxies = [];
    log('SYSTEM', 'wplacer', `No proxies file found.`);
  }
  updateLoadedProxies(loadedProxies);
  setSettingsLoadedProxies(loadedProxies);
}

// Initialize proxy functions
setProxyFunctions(loadProxies, loadedProxies);

// Save functions
function saveUsers(): void {
  saveJSON(USERS_FILE, users);
}

function saveTemplates(): void {
  saveJSON(TEMPLATES_PATH, templates);
}

function saveSettingsFn(): void {
  saveJSON(SETTINGS_FILE, currentSettings);
}

// Set save functions in routes
setSaveUsers(saveUsers);
setUsersSaveTemplates(saveTemplates);
setSaveSettings(saveSettingsFn);
setTemplatesSaveTemplates(saveTemplates);
setTemplatesTemplateQueue(templateQueue);
setTemplatesProcessQueueFn(() => processQueue(getTemplatesFromRoutes()));

// Express setup
const app = express();

// Local access policy: Host (anti DNS rebinding) and Origin (anti cross-site) checks
const interfaceAddresses = Object.values(networkInterfaces())
  .flat()
  .filter((iface): iface is NonNullable<typeof iface> => Boolean(iface))
  .map((iface) => iface.address);
const accessPolicy: LocalAccessPolicy = {
  allowedHostnames: buildAllowedHostnames(APP_HOST, ALLOWED_HOSTS, interfaceAddresses),
  originPatterns: compileOriginPatterns(ALLOWED_ORIGINS),
};

// Management Host/Origin, CORS, rate and body protections remain unchanged.
// The closed privileged ingress below has its own loopback/capability checks.
const privilegedReaderIngress = Router();
app.use('/api/v1/connector/privileged', privilegedReaderIngress);
applyBaseProtections(app, {
  policy: accessPolicy,
  rateLimitWindowMs: RATE_LIMIT_WINDOW_MS,
  rateLimitMax: RATE_LIMIT_MAX,
  jsonLimit: JSON_LIMIT,
  onBlocked: (reason, req) => {
    logger.warn(`Blocked request (${reason}): ${req.method} ${req.path}`);
  },
});
app.use(express.static(path.join(__dirname, '../public')));

// Phase 1B.10: the inherited routes that could reach Wplace or run the inherited engine are
// refused before their handlers (local simulation only).
app.use(
  legacyGuard((route, req) => {
    logger.warn(`Refused inherited route (${route.feature}): ${req.method} ${req.path}`);
  })
);

// New engine API (Phase 1B.9), filled once the engine is open (before listening).
const apiV1 = Router();
app.use('/api/v1', apiV1);
let engine: OpenedEngine | null = null;

// Mount routes
// F13: browser navigations (address bar, F5) to a UI page get the UI, even
// when the address is also an API route; API calls are unaffected.
const frontend = detectFrontend(path.join(__dirname, '../frontend/dist'));
app.use(uiDocumentMiddleware(frontend));

app.use(logsRouter);
app.use(tokensRouter);
app.use(usersRouter);
app.use(settingsRouter);
app.use(proxyRouter);
app.use(paletteRouter);
app.use(colorOrderingRouter);
app.use(templatesRouter);
app.use(bridgeRouter);
app.use(overlayRouter);

// Swagger API documentation
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'WPlace API',
      version: APP_VERSION,
      description: 'API for WPlace auto-drawing bot',
      contact: {
        name: 'JinxTheCatto and luluwaffless',
      },
    },
    servers: [
      {
        url: `http://${APP_HOST}:${APP_PRIMARY_PORT}`,
        description: 'Development server',
      },
    ],
  },
  apis: ['./src/routes/*.ts'],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Serve the compiled UI whenever it exists (independent of NODE_ENV)
if (frontend.available) {
  app.use(express.static(frontend.distDir));
}

// SPA fallback: GET/HEAD navigations outside the API get the UI, or an
// explicit message when it is not built. Other methods reach the 404 handler.
app.use((req, res, next) => {
  if (!isUiNavigation(req.method, req.path)) {
    next();
    return;
  }
  if (frontend.available) {
    res.sendFile(frontend.indexFile);
  } else {
    res.status(503).type('text/plain; charset=utf-8').send(FRONTEND_NOT_BUILT_MESSAGE);
  }
});

// Error handling middleware (must be after routes)
app.use(notFoundHandler);
app.use(errorHandler);

// WebSocket connections tracking (isAlive: answered the last ping)
type TrackedSocket = WebSocket & { isAlive?: boolean };
const wsConnections = new Set<TrackedSocket>();

function cleanupWebSocket(ws: TrackedSocket): void {
  wsLogClients.delete(ws);
  wsErrorClients.delete(ws);
  wsConnections.delete(ws);
}

// Cached WPlacer class to avoid dynamic imports in loop
let WPlacerCache: typeof import('./services/wplacer-client.js').WPlacer | null = null;

async function getWPlacerClass(): Promise<typeof import('./services/wplacer-client.js').WPlacer> {
  if (!WPlacerCache) {
    const { WPlacer } = await import('./services/wplacer-client.js');
    WPlacerCache = WPlacer;
  }
  return WPlacerCache;
}

// Keep-alive function with cached import and improved error handling
async function runKeepAlive(): Promise<void> {
  const now = Date.now();
  const WPlacerClass = await getWPlacerClass();

  for (const userId in users) {
    if (activeBrowserUsers.has(userId)) continue;
    const lastActivity = users[userId].lastActivity || 0;
    if (now - lastActivity > MS.ONE_HOUR) {
      try {
        const w = new WPlacerClass({});
        await w.login(users[userId].cookies);
        users[userId].lastActivity = now;
        saveUsers();
      } catch (error: any) {
        log(userId, users[userId].name, 'Keep-alive failed', error);
        // Enhanced error handling: flag potentially expired sessions
        if (error?.status === 401 || error?.message?.includes('unauthorized') || error?.message?.includes('Invalid session')) {
          logger.warn(`User ${userId} (${users[userId].name}) session may be expired - authentication failed`);
        }
      }
    }
  }
}

// Server state for graceful shutdown
const serverState = {
  wss: null as WebSocketServer | null,
  httpServer: null as http.Server | null,
  shutdownInProgress: false,
  intervals: [] as NodeJS.Timeout[],
};

// Graceful shutdown handler
async function gracefulShutdown(signal: string): Promise<void> {
  if (serverState.shutdownInProgress) {
    logger.warn(`Shutdown already in progress, forcing exit...`);
    process.exit(1);
  }

  serverState.shutdownInProgress = true;
  logger.warn(`Received ${signal}. Starting graceful shutdown...`);
  console.log(gradient('yellow', 'red')(`\nReceived ${signal}. Starting graceful shutdown...`));

  // Clear all intervals
  serverState.intervals.forEach(clearInterval);

  // Stop the simulation after the operation in progress (aborted after the
  // grace period), close the simulated world and the journal, release the lock.
  if (engine !== null) {
    try {
      await engine.close(GRACEFUL_SHUTDOWN_TIMEOUT_MS);
      log('SYSTEM', 'wplacer', 'Engine stopped and data directory released');
    } catch (error) {
      logger.error('Failed to stop the engine cleanly:', error);
    }
  }

  // Persist state
  try {
    saveUsers();
    saveTemplates();
    saveSettingsFn();
    log('SYSTEM', 'wplacer', 'State persisted before shutdown');
  } catch (error) {
    logger.error('Failed to persist state during shutdown:', error);
  }

  // Close WebSocket connections gracefully
  if (serverState.wss) {
    const closePromises: Promise<void>[] = [];
    serverState.wss.clients.forEach((ws: WebSocket) => {
      const closePromise = new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          ws.terminate();
          resolve();
        }, 2000);
        ws.once('close', () => {
          clearTimeout(timeout);
          resolve();
        });
        ws.close(1001, 'Server shutting down');
      });
      closePromises.push(closePromise);
    });

    await Promise.race([
      Promise.allSettled(closePromises),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('WebSocket close timeout')), GRACEFUL_SHUTDOWN_TIMEOUT_MS)
      ),
    ]).catch((err) => {
      logger.warn('Some WebSocket connections force-closed:', err);
    });

    log('SYSTEM', 'wplacer', `Closed ${closePromises.length} WebSocket connections`);
  }

  // Close HTTP server
  if (serverState.httpServer) {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        logger.warn('Force closing HTTP server after timeout');
        resolve();
      }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);

      serverState.httpServer!.close(() => {
        clearTimeout(timeout);
        log('SYSTEM', 'wplacer', 'HTTP server closed');
        resolve();
      });
    });
  }

  logger.info('Graceful shutdown completed');
  console.log(gradient('green', 'cyan')('Graceful shutdown completed'));
  process.exit(0);
}

// Server startup
async function startServer(): Promise<void> {
  const boxLine = (text: string): string => `    ║${text.padStart(Math.floor((58 + text.length) / 2)).padEnd(58)}║`;
  console.log(
    gradient('cyan', 'magenta')(
      [
        '',
        '    ╔════════════════════════════════════════════════════════════╗',
        boxLine(''),
        boxLine(`GeoPlacer ${APP_VERSION} : simulation locale`),
        boxLine('fork de wplacer 5.6.2 (AGPL-3.0-only)'),
        boxLine(''),
        '    ╚════════════════════════════════════════════════════════════╝',
        '',
      ].join('\n')
    )
  );
  logger.info(`GeoPlacer ${APP_VERSION} (local simulation)`);

  try {
    // Load proxies
    loadProxies();

    // Validate settings
    if (!currentSettings) {
      throw new Error('Failed to load settings');
    }

    // Validate users data
    if (!users || typeof users !== 'object') {
      throw new Error('Failed to load users data');
    }

    // Validate templates data
    if (!templates || typeof templates !== 'object') {
      throw new Error('Failed to load templates data');
    }

    // Report configuration values that were invalid and replaced by defaults
    for (const warning of SERVER_CONFIG.warnings) {
      logger.warn(warning);
    }
    if (frontend.available) {
      logger.info('Management UI: serving the compiled build (frontend/dist).');
    } else {
      logger.warn('Management UI: not built (frontend/dist/index.html missing); navigations get a 503 message.');
    }
    if (isWildcardHost(APP_HOST)) {
      logger.warn(`HOST=${APP_HOST}: the server is reachable from the local network. Use 127.0.0.1 unless this is intended.`);
    }

    // The engine is opened BEFORE listening: a data directory used by another
    // instance is refused here, explicitly, without any write.
    const engineDir = engineDataDir(process.env, DATA_DIR, process.argv.slice(2));
    if (process.argv.includes('--demo')) logger.info(`Demonstration mode: engine directory ${path.basename(engineDir)} (your project is not used).`);
    try {
      engine = await openEngine(engineDir, (level, message) => {
        if (level === 'error') logger.error(`[engine] ${message}`);
        else if (level === 'warn') logger.warn(`[engine] ${message}`);
        else logger.info(`[engine] ${message}`);
      });
    } catch (error) {
      if (error instanceof EngineLockedError) {
        logger.error(`Refused to start: ${error.message}`);
        console.error(gradient('red', 'yellow')(`\nGeoPlacer cannot start on this data directory: ${error.message}\n`));
        process.exit(2);
      }
      throw error;
    }
    const httpReader = new ConnectorHttpChannel(engine.api.pairing!, engine.api.connector!, process.env.GEOPLACER_READER_APPROVAL_KEY);
    privilegedReaderIngress.use(createPrivilegedReaderRouter(httpReader));
    const httpExpiry = setInterval(() => httpReader.tick(), 1000);
    httpExpiry.unref();
    serverState.intervals.push(httpExpiry);
    apiV1.use('/connector', createConnectorRouter(engine.api, httpReader));
    apiV1.use(createEngineRouter(engine.api));
    logger.info('Engine ready: simulation and opt-in browser observer; real placement and purchases disabled.');

    // Attempt to bind to available ports
    const ports = [APP_PRIMARY_PORT, ...APP_FALLBACK_PORTS];
    let server: http.Server | null = null;
    let boundPort: number | null = null;

    for (const port of ports) {
      try {
        server = await new Promise<http.Server>((resolve, reject) => {
          const s = app.listen(port, APP_HOST, () => {
            logger.info(`Server listening on http://${APP_HOST}:${port}`);
            console.log(gradient('green', 'cyan')(`Server listening on http://${APP_HOST}:${port}`));
            resolve(s);
          });
          s.on('error', reject);
        });
        serverState.httpServer = server;
        boundPort = port;
        break;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException | null)?.code === 'EADDRINUSE') {
          logger.info(`Port ${port} is in use, trying next port...`);
        } else {
          logger.error(`Failed to bind to port ${port}:`, error);
          throw error;
        }
      }
    }

    if (!server || boundPort === null) {
      logger.error('Failed to bind to any port');
      process.exit(1);
    }

    // WebSocket server
    const wss = new WebSocketServer({
      server,
      maxPayload: 1_000_000,
      verifyClient: (info, callback) => {
        if (info.req.url === CONNECTOR_WS_PATH) {
          callback(wss.clients.size < MAX_WS_CONNECTIONS && isLoopbackChannel(info.req) && !!engine?.api.pairing?.acceptsOrigin(info.origin), 403, 'connector pairing required');
          return;
        }
        callback(createWebSocketVerifier(accessPolicy, (reason) => logger.warn(`Blocked WebSocket handshake (${reason})`))(info), 403);
      },
    });
    serverState.wss = wss;

    // Set up broadcast function for extension messages
    setBroadcastFunction((type: string, data?: Record<string, unknown>) => {
      const message = JSON.stringify({ type, ...data });
      wsConnections.forEach((ws) => {
        if (ws.readyState === 1) {
          try {
            ws.send(message);
          } catch {
            // Ignore send errors for disconnected clients
          }
        }
      });
    });

    wss.on('connection', (ws: TrackedSocket, req) => {
      if (req.url === CONNECTOR_WS_PATH && engine !== null) {
        attachConnectorSocket(ws, req.headers.origin ?? '', engine.api);
        return;
      }
      // Check connection limit
      if (wsConnections.size >= MAX_WS_CONNECTIONS) {
        ws.close(1013, 'Server overloaded');
        return;
      }

      // Engine channel (Phase 1B.9): its own messages, no log stream.
      if (engine !== null && (req.url ?? '').split('?')[0] === ENGINE_WS_PATH) {
        // Same origin rule as the /api/v1 routes: never a browser extension.
        if (!isEngineOriginAllowed(req.headers.origin)) {
          ws.close(1008, 'origin not allowed');
          return;
        }
        wsConnections.add(ws);
        attachEngineSocket(ws, engine.api);
        ws.isAlive = true;
        ws.on('pong', () => {
          ws.isAlive = true;
        });
        ws.on('close', () => cleanupWebSocket(ws));
        ws.on('error', () => cleanupWebSocket(ws));
        return;
      }

      wsConnections.add(ws);
      logger.info(`WebSocket client connected (${wsConnections.size} total)`);

      ws.on('message', (message: string) => {
        try {
          const data = JSON.parse(message);
          if (data.type === 'logs') {
            wsLogClients.add(ws);
            logger.info(`WebSocket client subscribed to logs (${wsLogClients.size} log clients)`);
            ws.send(JSON.stringify({ type: 'system', message: 'Connected to log stream' }));
          } else if (data.type === 'errors') {
            wsErrorClients.add(ws);
            logger.info(`WebSocket client subscribed to errors (${wsErrorClients.size} error clients)`);
            ws.send(JSON.stringify({ type: 'system', message: 'Connected to error stream' }));
          }
        } catch (err) {
          logger.error('Failed to parse WebSocket message', err);
        }
      });
      ws.on('close', () => {
        cleanupWebSocket(ws);
      });
      ws.on('error', (err: Error) => {
        logger.error('WebSocket error', err);
        cleanupWebSocket(ws);
      });

      // Send ping every 30 seconds to keep connection alive
      ws.isAlive = true;
      ws.on('pong', () => {
        ws.isAlive = true;
      });
    });

    // Clean up dead connections on configured interval
    setInterval(() => {
      if (serverState.shutdownInProgress) {
        return;
      }
      wss.clients.forEach((ws: TrackedSocket) => {
        if (!ws.isAlive) {
          ws.terminate();
          cleanupWebSocket(ws);
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, WS_PING_INTERVAL_MS);

    // GeoPlacer V1: the inherited keep-alive (it logged every stored account into Wplace on a timer)
    // is never scheduled, whatever the configuration (Phase 1B.10 removed the LEGACY_KEEPALIVE
    // opt-in); its client refuses any request anyway (services/http-client.ts).
    void runKeepAlive;
    void KEEP_ALIVE_INTERVAL_MS;
    if (process.env.LEGACY_KEEPALIVE !== undefined) logger.warn('LEGACY_KEEPALIVE is ignored: the inherited keep-alive does not exist in GeoPlacer V1.');
    logger.info('Inherited keep-alive disabled (no automated access to a real service).');

    // Register graceful shutdown handlers
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    // A parent process (tests, a supervisor) can ask for the same controlled
    // shutdown over IPC: Windows cannot send SIGINT to a child process.
    if (typeof process.send === 'function') {
      process.on('message', (message) => {
        if (message === 'shutdown') void gracefulShutdown('IPC shutdown');
      });
      process.send({ type: 'listening', port: boundPort });
    }

    logger.info('Server started successfully');
    console.log(gradient('green', 'yellow')('Server started successfully'));
  } catch (error) {
    logger.error('Failed to start server:', error);
    log('SYSTEM', 'wplacer', 'Server startup failed', error as Error);
    process.exit(1);
  }
}

// Handle uncaught errors with graceful shutdown
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
  log('SYSTEM', 'wplacer', 'Uncaught exception', error);
  gracefulShutdown('uncaughtException').catch(() => process.exit(1));
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection at:', promise, 'reason:', reason);
  log('SYSTEM', 'wplacer', 'Unhandled rejection', reason as Error);
  // Don't shutdown on unhandled rejections, just log them
});

// Start server
startServer().catch((error) => {
  logger.error('Failed to start server:', error);
  process.exit(1);
});
