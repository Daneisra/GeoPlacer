/**
 * Bind address resolution tests
 */

import { resolveBindHost, isWildcardHost, isLoopbackHost, DEFAULT_BIND_HOST } from '../config/network.js';

describe('resolveBindHost', () => {
  it('defaults to 127.0.0.1 when HOST is unset or empty', () => {
    expect(resolveBindHost(undefined)).toEqual({ host: DEFAULT_BIND_HOST });
    expect(resolveBindHost('')).toEqual({ host: DEFAULT_BIND_HOST });
    expect(resolveBindHost('   ')).toEqual({ host: DEFAULT_BIND_HOST });
  });

  it('accepts IPv4 and IPv6 literals', () => {
    expect(resolveBindHost('127.0.0.1').host).toBe('127.0.0.1');
    expect(resolveBindHost('192.168.1.20').host).toBe('192.168.1.20');
    expect(resolveBindHost('::1').host).toBe('::1');
    expect(resolveBindHost('[::1]').host).toBe('::1');
  });

  it('keeps an explicit wildcard (opt-in network exposure)', () => {
    const r = resolveBindHost('0.0.0.0');
    expect(r.host).toBe('0.0.0.0');
    expect(r.warning).toBeUndefined();
  });

  it('strips quotes left by hand-written environment values', () => {
    expect(resolveBindHost('"127.0.0.1"').host).toBe('127.0.0.1');
    expect(resolveBindHost("'0.0.0.0'").host).toBe('0.0.0.0');
  });

  it('maps localhost to 127.0.0.1', () => {
    expect(resolveBindHost('localhost').host).toBe('127.0.0.1');
    expect(resolveBindHost('LOCALHOST').host).toBe('127.0.0.1');
  });

  it('falls back to 127.0.0.1 with a warning on invalid values', () => {
    for (const bad of ['example.com', '127.0.0.1 # comment', '999.1.1.1', 'true']) {
      const r = resolveBindHost(bad);
      expect(r.host).toBe(DEFAULT_BIND_HOST);
      expect(r.warning).toMatch(/Invalid HOST/);
    }
  });
});

describe('host classification', () => {
  it('detects wildcard addresses', () => {
    expect(isWildcardHost('0.0.0.0')).toBe(true);
    expect(isWildcardHost('::')).toBe(true);
    expect(isWildcardHost('127.0.0.1')).toBe(false);
  });

  it('detects loopback addresses', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.10.0.3')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('192.168.1.2')).toBe(false);
  });
});
