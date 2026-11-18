import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ConnectorPairing } from './pairing.js';
import type { GeoPixelsProvider } from './provider.js';
import { check, parseObservation, type BrowserObservation } from './protocol.js';
import type { SinglePixelWriter } from './single-pixel-writer.js';

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
    private readonly now: () => number = Date.now,
    private readonly writer?: SinglePixelWriter
  ) {
    check(approvalKey === undefined || /^[a-f0-9]{64}$/.test(approvalKey), 'invalid local approval key');
    this.controlKey = approvalKey ?? null;
    this.writer?.batch.subscribe(()=>this.session?.releasePoll?.());
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
  private writerAccess(capability: string) {
    const s = this.authenticate(capability);
    check(s.approved && s.epoch === this.provider.channelEpoch && this.writer !== undefined,
      'approved writer channel required');
    s.lastSeen = this.now();
    return this.writer;
  }
  claimBatch(capability:string){return this.writerAccess(capability).batch.claim();}
  batchAllowed(capability:string,batchId:string,attemptId:string){const b=this.writerAccess(capability).batch;return {allowed:b.view().id===batchId && b.allowed(attemptId)};}
  batchResult(capability:string,batchId:string,attemptId:string,result:'confirmed'|'not-sent'|'uncertain'){
    const b=this.writerAccess(capability).batch;check(b.view().id===batchId,'batch result mismatch');return b.result(attemptId,result);
  }
  claimPixel(capability: string) { return this.writerAccess(capability).claim(); }
  pixelAllowed(capability: string, attemptId: string) {
    const view = this.writerAccess(capability).view();
    return {allowed:view.mode === 'real' && view.state === 'started' && view.destination?.attemptId === attemptId
      && this.now() < view.destination.deadline};
  }
  pixelResult(capability: string, attemptId: string, result: 'confirmed'|'not-sent'|'uncertain') {
    return this.writerAccess(capability).result(attemptId,result);
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
    status(
        capability: string,
        readerVersion?: 3 | 4 | 5,
        ack?: { revision: number; state: 'running' | 'paused' | 'stopped' },
        abortedCapture?: string
    ) {
        const s = this.authenticate(capability);
        s.lastSeen = this.now();
        if (s.approved) {
            this.provider.heartbeat();
            this.provider.monitoring.capabilities(readerVersion === 3 || readerVersion === 4 || readerVersion === 5, readerVersion === 4 || readerVersion === 5);
            if (abortedCapture) {
                check(readerVersion === 4 || readerVersion === 5, 'regional reader required');
                this.provider.monitoring.abortCapture(abortedCapture);
            }
            if (ack) this.provider.monitoring.acknowledge(ack.revision, ack.state);
        }
        return {
            approved: s.approved,
            expires: s.deadline,
            lastSequence: s.lastSequence,
            fingerprint: s.fingerprint,
            ...([4,5].includes(readerVersion??0) ? { regionalProtocol: 1 } : {}),
            ...(readerVersion===5?{batchProtocol:1,batch:this.writer?{...this.writer.batch.view(),grant:this.writer.batch.grant()}:null}:{}),
            ...(readerVersion === 3 || readerVersion === 4 || readerVersion === 5
                ? { monitoring: this.provider.monitoring.control(), pacing: 'server-50ms' }
                : {}),
        };
    }
    /** One bounded held HTTP response. No browser timer, no permission renewal beyond deadline. */
    async poll(
        capability: string,
        readerVersion: 3 | 4 | 5,
        ack: { revision: number; state: 'running' | 'paused' | 'stopped' } | undefined,
        signal: AbortSignal,
        abortedCapture?: string
    ) {
        const initial=this.status(capability, readerVersion, ack, abortedCapture);
        if(initial.batch?.commandReady)return initial;
        const s = this.session!;
        check(!s.releasePoll, 'concurrent reader poll');
        await new Promise<void>((resolve) => {
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
            const unsubscribe = this.provider.monitoring.subscribe((kind) => {
                if (kind === 'state') finish();
            });
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
        check(
            observations.length === 1 || observations.every((o) => o.capture === undefined),
            'capture bands require individual acknowledgements'
        );
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
        this.provider.monitoring.noteWire(
            Buffer.byteLength(JSON.stringify({ protocol: 1, observations: values })),
            observations.length
        );
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
