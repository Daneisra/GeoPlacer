/**
 * Server configuration from the environment: missing, partial and invalid .env
 */

import {
  resolveServerConfig,
  DEFAULT_PORT,
  DEFAULT_ALLOWED_ORIGINS,
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  DEFAULT_JSON_BODY_LIMIT,
  DEFAULT_KEEP_ALIVE_INTERVAL_MS,
} from '../config/server-config.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('resolveServerConfig', () => {
  it('uses safe defaults when no variable is set (no .env file)', () => {
    const config = resolveServerConfig({});
    expect(config.host).toEqual({ host: '127.0.0.1' });
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.allowedOrigins).toEqual(DEFAULT_ALLOWED_ORIGINS);
    expect(config.allowedHosts).toEqual([]);
    expect(config.rateLimitWindowMs).toBe(DEFAULT_RATE_LIMIT_WINDOW_MS);
    expect(config.rateLimitMax).toBe(DEFAULT_RATE_LIMIT_MAX);
    expect(config.jsonBodyLimit).toBe(DEFAULT_JSON_BODY_LIMIT);
    expect(config.keepAliveIntervalMs).toBe(DEFAULT_KEEP_ALIVE_INTERVAL_MS);
    expect(config.warnings).toEqual([]);
  });

  it('treats empty values like missing ones', () => {
    const config = resolveServerConfig({ HOST: '', PORT: ' ', ALLOWED_ORIGINS: '', JSON_BODY_LIMIT: '' });
    expect(config.host.host).toBe('127.0.0.1');
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.allowedOrigins).toEqual(DEFAULT_ALLOWED_ORIGINS);
    expect(config.jsonBodyLimit).toBe(DEFAULT_JSON_BODY_LIMIT);
    expect(config.warnings).toEqual([]);
  });

  it('applies a partial configuration and keeps defaults for the rest', () => {
    const config = resolveServerConfig({ PORT: '4100', RATE_LIMIT_MAX: '50', ALLOWED_HOSTS: 'geoplacer.lan, other.lan' });
    expect(config.port).toBe(4100);
    expect(config.rateLimitMax).toBe(50);
    expect(config.allowedHosts).toEqual(['geoplacer.lan', 'other.lan']);
    expect(config.rateLimitWindowMs).toBe(DEFAULT_RATE_LIMIT_WINDOW_MS);
    expect(config.host.host).toBe('127.0.0.1');
  });

  it('replaces invalid values by defaults and reports them', () => {
    const config = resolveServerConfig({
      HOST: 'example.com',
      PORT: '99999',
      RATE_LIMIT_MAX: '-5',
      RATE_LIMIT_WINDOW_MS: 'fast',
      JSON_BODY_LIMIT: 'lots',
      MAX_WS_CONNECTIONS: '1.5',
    });
    expect(config.host.host).toBe('127.0.0.1');
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.rateLimitMax).toBe(DEFAULT_RATE_LIMIT_MAX);
    expect(config.rateLimitWindowMs).toBe(DEFAULT_RATE_LIMIT_WINDOW_MS);
    expect(config.jsonBodyLimit).toBe(DEFAULT_JSON_BODY_LIMIT);
    expect(config.warnings).toHaveLength(6);
    expect(config.warnings.join('\n')).toMatch(/HOST.*PORT.*RATE_LIMIT_WINDOW_MS.*RATE_LIMIT_MAX.*MAX_WS_CONNECTIONS.*JSON_BODY_LIMIT/s);
  });

  it('accepts size suffixes for JSON_BODY_LIMIT', () => {
    expect(resolveServerConfig({ JSON_BODY_LIMIT: '20MB' }).jsonBodyLimit).toBe('20mb');
    expect(resolveServerConfig({ JSON_BODY_LIMIT: '500kb' }).jsonBodyLimit).toBe('500kb');
    expect(resolveServerConfig({ JSON_BODY_LIMIT: '1048576' }).jsonBodyLimit).toBe('1048576');
  });
});

describe('.env.example', () => {
  const example = readFileSync(path.resolve(__dirname, '..', '..', '.env.example'), 'utf8');
  const parse = (text: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      out[match[1]] = match[2].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '');
    }
    return out;
  };

  it('produces a configuration without any warning', () => {
    expect(resolveServerConfig(parse(example)).warnings).toEqual([]);
  });

  it('keeps the server on the loopback interface', () => {
    expect(resolveServerConfig(parse(example)).host.host).toBe('127.0.0.1');
  });

  it('documents every variable read by the server configuration', () => {
    for (const name of [
      'HOST',
      'PORT',
      'ALLOWED_HOSTS',
      'ALLOWED_ORIGINS',
      'JSON_BODY_LIMIT',
      'RATE_LIMIT_WINDOW_MS',
      'RATE_LIMIT_MAX',
      'MAX_WS_CONNECTIONS',
      'WS_PING_INTERVAL_MS',
      'GRACEFUL_SHUTDOWN_TIMEOUT_MS',
      'KEEP_ALIVE_INTERVAL_MS',
      'NODE_ENV',
      'LOG_LEVEL',
    ]) {
      expect({ name, documented: example.includes(name) }).toEqual({ name, documented: true });
    }
  });
});
