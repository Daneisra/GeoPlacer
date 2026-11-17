import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ConnectorPairing } from './pairing.js';
import type { GeoPixelsProvider } from './provider.js';
import { check, parseObservation, type BrowserObservation } from './protocol.js';

export const HTTP_IDLE_MS = 30_000;
export const HTTP_LIFETIME_MS = 10 * 60_000;
const secret = () => randomBytes(32).toString('hex');
const equal = (a: string, b: string) =>
  /^[a-f0-9]{64}$/.test(a) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
type Session = {
  id: string;
  capability: string;
  originClaim: string;
  fingerprint: string;
  approved: boolean;
  deadline: number;
  lastSeen: number;
  epoch: number;
  lastSequence: number;
  lastDigest: string | null;
  requests: number[];
  releasePoll?: () => void;
};

/** Privileged HTTP is capability-authenticated. Its Origin is NOT page attestation. */
export class ConnectorHttpChannel {
  private session: Session | null = null;
  private readonly controlKey: string | null;
  constructor(
    private readonly pairing: ConnectorPairing,
    private readonly provider: GeoPixelsProvider,
    approvalKey: string | undefined,
    private readonly now: () => number = Date.now
  ) {
    check(approvalKey === undefined || /^[a-f0-9]{64}$/.test(approvalKey), 'invalid local approval key');
    this.controlKey = approvalKey ?? null;
  }
  control(key: string): void {
    check(this.controlKey !== null && equal(key, this.controlKey), 'local approval key required');
  }
  issue(key: string, origin: string) {
    this.control(key);
    return this.pairing.issue('read-only', origin, 'http');
  }
  claim(origin: string, code: string) {
    this.tick();
    check(this.controlKey !== null, 'privileged reader is not enabled');
    this.pairing.redeem(origin, code, () => this.revoke('HTTP channel revoked'), 'http');
    const id = secret(),
      capability = secret();
    this.session = {
      id,
      capability,
      originClaim: origin,
      fingerprint: createHash('sha256').update(id).digest('hex').slice(0, 12),
      approved: false,
      deadline: this.now() + 60_000,
      lastSeen: this.now(),
      epoch: -1,
      lastSequence: 0,
      lastDigest: null,
      requests: [],
    };
    return { requestId: id, capability, fingerprint: this.session.fingerprint, expires: this.session.deadline };
  }
  approve(key: string, id: string) {
    this.control(key);
    this.tick();
    const s = this.session;
    check(s !== null && s.id === id && !s.approved, 'no pending HTTP request');
    this.provider.connect('read-only', () => {
      throw new Error('real writes are unavailable');
    });
    s.approved = true;
    s.deadline = this.now() + HTTP_LIFETIME_MS;
    s.lastSeen = this.now();
    s.epoch = this.provider.channelEpoch;
    s.releasePoll?.();
    return { approved: true };
  }
  verify(capability: string): void {
    this.tick();
    check(this.session !== null && equal(capability, this.session.capability), 'HTTP capability expired or refused');
  }
  authenticate(capability: string): Session {
    this.tick();
    const s = this.session;
    check(s !== null && equal(capability, s.capability), 'HTTP capability expired or refused');
    s.requests = s.requests.filter((t) => t > this.now() - 1_000);
    check(s.requests.length < 25, 'HTTP message frequency exceeded');
    s.requests.push(this.now());
    return s;
  }
  status(capability: string, readerVersion?: 3, ack?: { revision: number; state: 'running' | 'paused' | 'stopped' }) {
    const s = this.authenticate(capability);
    s.lastSeen = this.now();
    if (s.approved) {
      this.provider.heartbeat();
      this.provider.monitoring.capabilities(readerVersion === 3);
      if (ack) this.provider.monitoring.acknowledge(ack.revision, ack.state);
    }
    return { approved: s.approved, expires: s.deadline, lastSequence: s.lastSequence, fingerprint: s.fingerprint,
      ...(readerVersion === 3 ? { monitoring: this.provider.monitoring.control(), pacing: 'server-50ms' } : {}) };
  }
  /** One bounded held HTTP response. No browser timer, no permission renewal beyond deadline. */
  async poll(capability: string, readerVersion: 3, ack: { revision: number; state: 'running' | 'paused' | 'stopped' } | undefined, signal: AbortSignal) {
    this.status(capability, readerVersion, ack);
    const s = this.session!;
    check(!s.releasePoll, 'concurrent reader poll');
    await new Promise<void>(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        signal.removeEventListener('abort', finish);
        delete s.releasePoll;
        resolve();
      };
      const unsubscribe = this.provider.monitoring.subscribe(kind => { if (kind === 'state') finish(); });
      const timer = setTimeout(finish, 5000);
      s.releasePoll = finish;
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    });
    check(!signal.aborted, 'reader poll aborted');
    return this.status(capability, readerVersion);
  }
  batch(capability: string, values: readonly unknown[]) {
    const s = this.authenticate(capability);
    check(s.approved && s.epoch === this.provider.channelEpoch, 'HTTP request not approved or replaced');
    check(values.length >= 1 && values.length <= 2, 'invalid observation batch');
    // Validate the entire batch before accepting anything. No partial acknowledgement.
    const observations: BrowserObservation[] = values.map((v) => parseObservation(v, this.now()));
    check(observations.length === 1 || observations.every(o => o.capture === undefined), 'capture bands require individual acknowledgements');
    check(observations.reduce((sum, o) => sum + o.pixels.length, 0) <= 65_536, 'oversized HTTP batch');
    const digest = createHash('sha256').update(JSON.stringify(values)).digest('hex');
    const first = observations[0]!,
      last = observations.at(-1)!;
    if (last.sequence === s.lastSequence) {
      check(digest === s.lastDigest, 'conflicting duplicate batch');
      s.lastSeen = this.now();
      this.provider.heartbeat();
      return { accepted: true, sequence: last.sequence, duplicate: true };
    }
    check(
      first.sequence === s.lastSequence + 1 && observations.every((o, i) => o.sequence === first.sequence + i),
      'HTTP sequence gap or replay'
    );
    // A batch cannot combine different model/session identities.
    check(
      observations.every(
        (o) => o.session === first.session && JSON.stringify(o.project) === JSON.stringify(first.project)
      ),
      'mixed observation identities'
    );
    for (const o of observations) this.provider.observe(o);
    s.lastSequence = last.sequence;
    s.lastDigest = digest;
    s.lastSeen = this.now();
    return { accepted: true, sequence: last.sequence, duplicate: false };
  }
  disconnect(capability: string) {
    this.authenticate(capability);
    this.revoke('HTTP reader disconnected');
    return { disconnected: true };
  }
  revoke(reason = 'HTTP reader revoked'): void {
    const s = this.session;
    this.session = null;
    s?.releasePoll?.();
    if (s?.approved && s.epoch === this.provider.channelEpoch) this.provider.disconnect(reason);
  }
  tick(): void {
    const s = this.session;
    if (
      s &&
      (this.now() >= s.deadline ||
        (s.approved && (this.now() - s.lastSeen >= HTTP_IDLE_MS || s.epoch !== this.provider.channelEpoch)))
    )
      this.revoke('HTTP reader expired or replaced');
  }
  info() {
    this.tick();
    const s = this.session;
    return {
      enabled: this.controlKey !== null,
      pending:
        s && !s.approved
          ? { requestId: s.id, fingerprint: s.fingerprint, originClaim: s.originClaim, expires: s.deadline }
          : null,
      active: !!s?.approved,
    };
  }
}
