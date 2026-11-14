/**
 * Decides how the compiled management UI is served (pure, unit-tested).
 *
 * The UI is served whenever a compiled build exists (frontend/dist/index.html),
 * whatever NODE_ENV is. Without a build, UI navigations get an explicit 503
 * message instead of a silent 404. In development, Vite serves the UI on its
 * own port and proxies API calls; this module does not interfere.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

export type FrontendStatus =
  | { readonly available: true; readonly distDir: string; readonly indexFile: string }
  | { readonly available: false; readonly distDir: string; readonly indexFile: string };

export function detectFrontend(distDir: string, exists: (file: string) => boolean = existsSync): FrontendStatus {
  const indexFile = path.join(distDir, 'index.html');
  return { available: exists(indexFile), distDir, indexFile };
}

/** Path prefixes that never receive the UI (API, WebSocket, API documentation). */
const NON_UI_PREFIXES = ['/api', '/ws', '/api-docs'];

/**
 * True for a request that should receive the UI (single-page app fallback):
 * a GET or HEAD outside the API prefixes. Other methods on unknown paths fall
 * through to the JSON 404 handler instead of a misleading 200 HTML page.
 */
export function isUiNavigation(method: string, requestPath: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  return !NON_UI_PREFIXES.some((prefix) => requestPath === prefix || requestPath.startsWith(`${prefix}/`));
}

export const FRONTEND_NOT_BUILT_MESSAGE =
  "Interface non compilée : lancez « npm run build:frontend » (ou « npm run build »), puis rechargez la page. " +
  'En développement, utilisez « npm run dev » et ouvrez l\'adresse affichée par Vite.';
