import { randomBytes, timingSafeEqual } from 'node:crypto';
import { check, type ConnectorMode } from './protocol.js';

export const GEOPIXELS_ORIGINS: readonly string[] = ['https://geopixels.net', 'https://www.geopixels.net'];
export function localOrigin(value: string): boolean {
  try {
    const u = new URL(value);
    return u.origin === value && u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

/** One-use 256-bit capability, memory only, exact Origin, 60 s redemption window. */
export class ConnectorPairing {
  private pending: { token: Buffer; origin: string; mode: ConnectorMode; expires: number; transport: 'websocket' | 'http' } | null = null;
  private closeChannel: (() => void) | null = null;
  constructor(private readonly now: () => number = Date.now) {}

  issue(mode: ConnectorMode, origin: string, transport: 'websocket' | 'http' = 'websocket') {
    check(mode === 'read-only' || mode === 'local-fake', 'unsupported channel mode');
    check(transport === 'websocket' || (transport === 'http' && mode === 'read-only'), 'HTTP transport is read-only');
    check(
      mode === 'local-fake' ? localOrigin(origin) : GEOPIXELS_ORIGINS.includes(origin),
      'channel origin is not allowed'
    );
    this.revoke();
    const token = randomBytes(32);
    const expires = this.now() + 60_000;
    this.pending = { token, mode, origin, expires, transport };
    return { protocol: 1, token: token.toString('hex'), origin, mode, expires };
  }

  acceptsOrigin(origin: string | undefined): boolean {
    return this.pending !== null && this.pending.transport === 'websocket' && this.now() < this.pending.expires && this.pending.origin === origin;
  }

  redeem(origin: string, token: string, close: () => void, transport: 'websocket' | 'http' = 'websocket'): ConnectorMode {
    const p = this.pending;
    check(
      p !== null && p.transport === transport && this.now() < p.expires && p.origin === origin && /^[0-9a-f]{64}$/.test(token),
      'pairing refused'
    );
    check(timingSafeEqual(Buffer.from(token, 'hex'), p.token), 'pairing refused');
    this.pending = null;
    this.closeChannel = close;
    return p.mode;
  }

  revoke(): void {
    this.pending = null;
    this.closeChannel?.();
    this.closeChannel = null;
  }
}
