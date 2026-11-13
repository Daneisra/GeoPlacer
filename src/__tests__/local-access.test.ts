/**
 * Local access protection tests (Host / Origin / Sec-Fetch-Site)
 */

import {
  hostnameFromHostHeader,
  buildAllowedHostnames,
  compileOriginPatterns,
  isAllowedOrigin,
  checkAccess,
  createWebSocketVerifier,
  type LocalAccessPolicy,
} from '../middleware/local-access.js';
import type { IncomingMessage } from 'node:http';

const DEFAULT_ORIGINS = ['http://localhost:*', 'http://127.0.0.1:*', 'chrome-extension://*'];

function policyFor(bindHost = '127.0.0.1', extra: string[] = [], ifaces: string[] = []): LocalAccessPolicy {
  return {
    allowedHostnames: buildAllowedHostnames(bindHost, extra, ifaces),
    originPatterns: compileOriginPatterns(DEFAULT_ORIGINS),
  };
}

describe('hostnameFromHostHeader', () => {
  it('extracts host names with and without port', () => {
    expect(hostnameFromHostHeader('localhost:3000')).toBe('localhost');
    expect(hostnameFromHostHeader('127.0.0.1')).toBe('127.0.0.1');
    expect(hostnameFromHostHeader('LocalHost:80')).toBe('localhost');
  });

  it('handles bracketed IPv6', () => {
    expect(hostnameFromHostHeader('[::1]:3000')).toBe('::1');
    expect(hostnameFromHostHeader('[::1]')).toBe('::1');
  });

  it('rejects malformed values', () => {
    for (const bad of [undefined, '', '[::1', '[::1]x', 'local host', 'a:b:c', 'x/y', 'host:99999999']) {
      expect(hostnameFromHostHeader(bad)).toBeNull();
    }
  });
});

describe('buildAllowedHostnames', () => {
  it('allows loopback names and the bind address', () => {
    const names = buildAllowedHostnames('127.0.0.1');
    expect([...names].sort()).toEqual(['127.0.0.1', '::1', 'localhost'].sort());
  });

  it('adds interface addresses only for a wildcard bind', () => {
    expect(buildAllowedHostnames('127.0.0.1', [], ['192.168.1.20']).has('192.168.1.20')).toBe(false);
    expect(buildAllowedHostnames('0.0.0.0', [], ['192.168.1.20']).has('192.168.1.20')).toBe(true);
  });

  it('adds explicit extra host names', () => {
    expect(buildAllowedHostnames('127.0.0.1', ['geoplacer.lan:3000']).has('geoplacer.lan')).toBe(true);
  });
});

describe('compileOriginPatterns / isAllowedOrigin', () => {
  const policy = policyFor();

  it('accepts the local UI and the extension', () => {
    expect(isAllowedOrigin('http://127.0.0.1:3000', policy)).toBe(true);
    expect(isAllowedOrigin('http://localhost:5173', policy)).toBe(true);
    expect(isAllowedOrigin('http://[::1]:3000', policy)).toBe(true);
    expect(isAllowedOrigin('chrome-extension://abcdefghijklmnopabcdefghijklmnop', policy)).toBe(true);
  });

  it('rejects foreign and look-alike origins', () => {
    for (const bad of [
      'https://evil.com',
      'http://localhost:3000.evil.com',
      'http://127.0.0.1.evil.com',
      'http://evil.com?http://localhost:3000',
      'http://localhostXevil.com:80',
      'null',
      'file://',
      'chrome-extension://abc/../x',
    ]) {
      expect(isAllowedOrigin(bad, policy)).toBe(false);
    }
  });

  it('escapes regular expression characters in patterns', () => {
    const p: LocalAccessPolicy = {
      allowedHostnames: new Set(),
      originPatterns: compileOriginPatterns(['http://127.0.0.1:3000']),
    };
    expect(isAllowedOrigin('http://127.0.0.1:3000', p)).toBe(true);
    expect(isAllowedOrigin('http://127a0b0c1:3000', p)).toBe(false);
  });
});

describe('checkAccess', () => {
  const policy = policyFor();

  it('allows same-origin and non-browser requests', () => {
    expect(checkAccess({ host: '127.0.0.1:3000' }, policy)).toEqual({ ok: true });
    expect(checkAccess({ host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' }, policy)).toEqual({ ok: true });
    expect(checkAccess({ host: 'localhost:3000', secFetchSite: 'same-origin' }, policy)).toEqual({ ok: true });
  });

  it('allows a request on a fallback port (host names only are compared)', () => {
    expect(checkAccess({ host: '127.0.0.1:3007', origin: 'http://127.0.0.1:3007' }, policy)).toEqual({ ok: true });
  });

  it('blocks DNS rebinding (unknown Host header)', () => {
    expect(checkAccess({ host: 'attacker.example:3000' }, policy)).toEqual({ ok: false, reason: 'forbidden-host' });
  });

  it('blocks missing or malformed Host headers', () => {
    expect(checkAccess({}, policy)).toEqual({ ok: false, reason: 'invalid-host' });
    expect(checkAccess({ host: 'a b' }, policy)).toEqual({ ok: false, reason: 'invalid-host' });
  });

  it('blocks a foreign Origin even with a valid Host', () => {
    expect(checkAccess({ host: '127.0.0.1:3000', origin: 'https://evil.com' }, policy)).toEqual({
      ok: false,
      reason: 'forbidden-origin',
    });
  });

  it('blocks cross-site browser requests without Origin', () => {
    expect(checkAccess({ host: '127.0.0.1:3000', secFetchSite: 'cross-site' }, policy)).toEqual({
      ok: false,
      reason: 'cross-site',
    });
  });

  it('accepts LAN access only when explicitly bound to a wildcard', () => {
    const lan = policyFor('0.0.0.0', [], ['192.168.1.20']);
    expect(checkAccess({ host: '192.168.1.20:3000', origin: 'http://192.168.1.20:3000' }, lan)).toEqual({ ok: true });
    expect(checkAccess({ host: '192.168.1.20:3000' }, policy)).toEqual({ ok: false, reason: 'forbidden-host' });
  });
});

describe('createWebSocketVerifier', () => {
  const verify = createWebSocketVerifier(policyFor());
  const req = (headers: Record<string, string>) => ({ req: { headers } as unknown as IncomingMessage });

  it('accepts the local UI', () => {
    expect(verify(req({ host: '127.0.0.1:3000', origin: 'http://localhost:5173' }))).toBe(true);
  });

  it('rejects a foreign page (cross-site WebSocket hijacking)', () => {
    expect(verify(req({ host: '127.0.0.1:3000', origin: 'https://evil.com' }))).toBe(false);
  });

  it('rejects a rebinding host', () => {
    expect(verify(req({ host: 'attacker.example:3000', origin: 'http://attacker.example:3000' }))).toBe(false);
  });
});
