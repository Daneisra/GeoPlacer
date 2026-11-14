/**
 * Serving of the compiled UI, independent of NODE_ENV
 */

import path from 'node:path';
import { detectFrontend, isUiNavigation, FRONTEND_NOT_BUILT_MESSAGE } from '../config/frontend.js';

describe('detectFrontend', () => {
  it('is available when index.html exists, whatever NODE_ENV is', () => {
    const status = detectFrontend('/app/frontend/dist', (file) => file === path.join('/app/frontend/dist', 'index.html'));
    expect(status.available).toBe(true);
    expect(status.indexFile).toBe(path.join('/app/frontend/dist', 'index.html'));
  });

  it('is unavailable when the build is missing', () => {
    expect(detectFrontend('/app/frontend/dist', () => false).available).toBe(false);
  });
});

describe('isUiNavigation', () => {
  it('serves the UI to GET and HEAD navigations, including page refreshes', () => {
    for (const p of ['/', '/logs', '/users', '/templates', '/templates/add', '/settings', '/unknown/page']) {
      expect(isUiNavigation('GET', p)).toBe(true);
      expect(isUiNavigation('HEAD', p)).toBe(true);
    }
  });

  it('never answers other methods with the UI (no misleading 200 HTML)', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      expect(isUiNavigation(method, '/templates/start-all')).toBe(false);
      expect(isUiNavigation(method, '/settings')).toBe(false);
    }
  });

  it('keeps API, WebSocket and API docs paths out of the fallback', () => {
    for (const p of ['/api', '/api/v1/settings', '/ws', '/ws/logs', '/api-docs', '/api-docs/swagger.json']) {
      expect(isUiNavigation('GET', p)).toBe(false);
    }
  });

  it('does not treat look-alike paths as API prefixes', () => {
    expect(isUiNavigation('GET', '/apis')).toBe(true);
    expect(isUiNavigation('GET', '/wsx')).toBe(true);
  });
});

describe('FRONTEND_NOT_BUILT_MESSAGE', () => {
  it('tells how to build the UI', () => {
    expect(FRONTEND_NOT_BUILT_MESSAGE).toMatch(/npm run build:frontend/);
    expect(FRONTEND_NOT_BUILT_MESSAGE).toMatch(/npm run dev/);
  });
});
