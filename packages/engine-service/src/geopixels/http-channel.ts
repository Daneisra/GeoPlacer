import { CONNECTOR_COMMAND_BYTES, CONNECTOR_MAX_GROUP_PIXELS } from './batch-limits.js';
import { MAX_MODEL_PIXELS, MODEL_MEMORY_BYTES } from './capacity.js';
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
export type ChannelDiagnostic = {
  code: 'HTTP_APPROVED' | 'HTTP_RENEWED' | 'HTTP_LIFETIME_EXPIRED' | 'HTTP_IDLE_EXPIRED' | 'HTTP_PENDING_EXPIRED' | 'HTTP_CONTEXT_CHANGED' | 'HTTP_CHANNEL_REPLACED' | 'HTTP_READER_DISCONNECTED' | 'HTTP_REVOKED';
  at: number;
  reason: string;
  approvedAt: number | null;
  expiresAt: number;
  lastSeen: number;
};
type Session = {
  id: string;
  capability: string;
  originClaim: string;
  fingerprint: string;
  approved: boolean;
  approvedAt: number | null;
  deadline: number;
  lastSeen: number;
  epoch: number;
  lastSequence: number;
  lastDigest: string | null;
  requests: number[];
  releasePoll?: () => void;
  batchProtocol?: 1 | 2 | 3 | 4 | 5 | 6;
  rotation?: {nonce:string;capability:string;until:number};
};

/** Privileged HTTP is capability-authenticated. Its Origin is NOT page attestation. */
export class ConnectorHttpChannel {
  private session: Session | null = null;
  private readonly controlKey: string | null;
  private lastTermination: ChannelDiagnostic | null = null;
  constructor(
    private readonly pairing: ConnectorPairing,
    private readonly provider: GeoPixelsProvider,
    approvalKey: string | undefined,
    private readonly now: () => number = Date.now,
    private readonly writer?: SinglePixelWriter,
    private readonly onDiagnostic?: (event: ChannelDiagnostic) => void
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
    this.pairing.redeem(origin, code, () => this.revoke('Couplage HTTP révoqué ou remplacé ; nouveau couplage requis.'), 'http');
    const id = secret(),
      capability = secret();
    this.session = {
      id,
      capability,
      originClaim: origin,
      fingerprint: createHash('sha256').update(id).digest('hex').slice(0, 12),
      approved: false,
      approvedAt: null,
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
    s.approvedAt = this.now();
    this.lastTermination = null;
    s.deadline = this.now() + HTTP_LIFETIME_MS;
    s.lastSeen = this.now();
    s.epoch = this.provider.channelEpoch;
    this.diagnostic(s, 'HTTP_APPROVED', 'Couplage HTTP approuvé ; durée absolue de dix minutes.');
    s.releasePoll?.();
    return { approved: true };
  }
  verify(capability: string,countMessage=false): void {
    this.authenticate(capability,countMessage);
  }
  private activateRotation(capability:string) {
    const s=this.session,r=s?.rotation;
    if(!s||!r||!equal(capability,r.capability))return;
    check(this.now()<s.deadline && this.now()<r.until && s.approved && s.epoch===this.provider.channelEpoch && !!this.writer?.batch.transportRenewable(),'rotation no longer authorized');
    s.capability=r.capability;delete s.rotation;
    s.approvedAt=this.now();s.deadline=this.now()+HTTP_LIFETIME_MS;s.lastSeen=this.now();
    this.diagnostic(s,'HTTP_RENEWED','Capacité du transport renouvelée ; autorisation de travail inchangée.');
  }
  renew(capability:string,nonce:string) {
    const s=this.authenticate(capability);
    check(/^[a-f0-9-]{36}$/.test(nonce) && s.approved && (s.batchProtocol??0)>=5 && s.epoch===this.provider.channelEpoch && !!this.writer?.batch.transportRenewable(),'renewal requires an active, explicitly authorized autonomous drawing');
    s.lastSeen=this.now();
    if(s.rotation && this.now()>=s.rotation.until)delete s.rotation;
    if(s.rotation)check(s.rotation.nonce===nonce,'another rotation is pending');
    else s.rotation={nonce,capability:secret(),until:Math.min(s.deadline,this.now()+10000)};
    // Main capability/deadline remain unchanged until possession of the new capability is proved.
    return {nonce,capability:s.rotation.capability,expires:s.rotation.until};
  }
  private writerAccess(capability: string) {
    const s = this.authenticate(capability);
    check(s.approved && s.epoch === this.provider.channelEpoch && this.writer !== undefined,
      'approved writer channel required');
    s.lastSeen = this.now();
    return this.writer;
  }
  claimBatch(capability:string){
    const batch=this.writerAccess(capability).batch,v=batch.control(),protocol=this.session?.batchProtocol??0;
    check((v.execution!=='grouped'||protocol>=2) && (v.execution!=='session'||protocol>=3),'reader 0.7.0 required for grouped execution');
    check(v.execution!=='continuous'||protocol>=4,'reader 0.9.0 required');
    check(v.execution!=='autonomous'||protocol>=((v.scope?.groupSize??5)===0 || (v.scope?.groupSize??5)>5?6:5),'reader 1.1.0 required');
    return batch.claim();
  }
  batchAllowed(capability:string,batchId:string,attemptId:string){const b=this.writerAccess(capability).batch;return {allowed:b.control().id===batchId && b.allowed(attemptId)};}
  async batchResult(capability:string,batchId:string,attemptId:string,result:'confirmed'|'not-sent'|'uncertain'|'waiting-resources'|'rejected-size'){
    const b=this.writerAccess(capability).batch;check(b.control().id===batchId,'batch result mismatch');const v=await b.result(attemptId,result);return (this.session?.batchProtocol??0)>=5 ? {state:v.state,confirmed:v.confirmed,acceptedRequests:v.acceptedRequests,uncertain:v.uncertain} : v;
  }
  async claimUpgrade(capability:string){check(this.session?.batchProtocol===6,'upgrade reader required');return this.writerAccess(capability).upgrades.claim();}
  upgradeAllowed(capability:string,id:string){return {allowed:this.writerAccess(capability).upgrades.allowed(id)};}
  async upgradeResult(capability:string,id:string,result:'accepted'|'not-sent'|'uncertain'){await this.writerAccess(capability).upgrades.result(id,result);return {accepted:true};}
  claimPixel(capability: string) { return this.writerAccess(capability).claim(); }
  pixelAllowed(capability: string, attemptId: string) {
    const view = this.writerAccess(capability).view();
    return {allowed:view.mode === 'real' && view.state === 'started' && view.destination?.attemptId === attemptId
      && this.now() < view.destination.deadline};
  }
  pixelResult(capability: string, attemptId: string, result: 'confirmed'|'not-sent'|'uncertain') {
    return this.writerAccess(capability).result(attemptId,result);
  }
  private authenticate(capability: string,countMessage=false): Session {
    this.activateRotation(capability);
    this.tick();
    const s = this.session;
    check(s !== null && equal(capability, s.capability), 'HTTP capability expired or refused');
    // Count ingress messages once; revalidating the SAME held response is not another message.
    if(countMessage){s.requests=s.requests.filter(t=>t>this.now()-1000);check(s.requests.length<25,'HTTP message frequency exceeded');s.requests.push(this.now());}
    return s;
  }
    status(
        capability: string,
        readerVersion?: 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10,
        ack?: { revision: number; state: 'running' | 'paused' | 'stopped' },
        abortedCapture?: string,
        writerResources?: unknown
    ) {
        const s = this.authenticate(capability);
        s.lastSeen = this.now();
        if (s.approved) {
            if(readerVersion===5 || readerVersion===6 || readerVersion===7 || readerVersion===8 || readerVersion===9 || readerVersion===10)s.batchProtocol=readerVersion===10?6:readerVersion===9?5:readerVersion===8?4:readerVersion===7?3:readerVersion===6?2:1;
            this.provider.heartbeat();
            if(writerResources !== undefined) {
                check((readerVersion === 8 || readerVersion === 9 || readerVersion === 10) && this.writer !== undefined && s.epoch === this.provider.channelEpoch,'writer resource channel refused');
                this.writer.batch.observeResources(writerResources);
            }
            this.provider.monitoring.capabilities(readerVersion === 3 || readerVersion === 4 || readerVersion === 5 || readerVersion === 6 || (readerVersion === 7 || readerVersion === 8 || readerVersion === 9 || readerVersion === 10), readerVersion === 4 || readerVersion === 5 || readerVersion === 6 || (readerVersion === 7 || readerVersion === 8 || readerVersion === 9 || readerVersion === 10));
            if (abortedCapture) {
                check(readerVersion === 4 || readerVersion === 5 || readerVersion === 6 || (readerVersion === 7 || readerVersion === 8 || readerVersion === 9 || readerVersion === 10), 'regional reader required');
                this.provider.monitoring.abortCapture(abortedCapture);
            }
            if (ack) this.provider.monitoring.acknowledge(ack.revision, ack.state);
        }
        return {
            ...(readerVersion===10?{upgrades:{commandReady:this.writer?.upgrades.commandReady()??false},workAuthorized:!!this.writer?.batch.upgradeAuthority() || !!this.writer?.batch.transportRenewable()}:{}),
            approved: s.approved,
            ...((readerVersion===9 || readerVersion===10) ? {limits:{maxModelPixels:MAX_MODEL_PIXELS,modelMemoryBytes:MODEL_MEMORY_BYTES,groupMax:readerVersion===10?CONNECTOR_MAX_GROUP_PIXELS:5,commandBytes:CONNECTOR_COMMAND_BYTES,autonomous:true},renewRequired: s.approved && s.deadline-this.now()<90000 && !!this.writer?.batch.transportRenewable()} : {}),
            expires: s.deadline,
            lastSequence: s.lastSequence,
            fingerprint: s.fingerprint,
            ...([4,5,6,7,8,9,10].includes(readerVersion??0) ? { regionalProtocol: 1 } : {}),
            ...([5,6,7,8,9,10].includes(readerVersion??0)?{batchProtocol:readerVersion===10?6:readerVersion===9?5:readerVersion===8?4:readerVersion===7?3:readerVersion===6?2:1,batch:this.writer?((readerVersion??0)>=9 ? {commandReady:this.writer.batch.control().commandReady,grant:this.writer.batch.grant()} : {...this.writer.batch.view(),grant:this.writer.batch.grant()}):null}:{}),
            ...(readerVersion === 3 || readerVersion === 4 || readerVersion === 5 || readerVersion === 6 || (readerVersion === 7 || readerVersion === 8 || readerVersion === 9 || readerVersion === 10)
                ? { monitoring: this.provider.monitoring.control(), pacing: 'server-50ms' }
                : {}),
        };
    }
    /** One bounded held HTTP response. No browser timer, no permission renewal beyond deadline. */
    async poll(
        capability: string,
        readerVersion: 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10,
        ack: { revision: number; state: 'running' | 'paused' | 'stopped' } | undefined,
        signal: AbortSignal,
        abortedCapture?: string,
        writerResources?: unknown
    ) {
        const initial=this.status(capability, readerVersion, ack, abortedCapture, writerResources);
        if(initial.upgrades?.commandReady || initial.batch?.commandReady)return initial;
        if(readerVersion===10 && this.provider.monitoring.automaticRegionCount()>0 && initial.monitoring?.state==='running'){await new Promise(r=>setTimeout(r,150));check(!signal.aborted,'reader poll aborted');return this.status(capability,readerVersion);}
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
    this.revoke('Lecteur HTTP déconnecté ; nouveau couplage requis.', 'HTTP_READER_DISCONNECTED');
    return { disconnected: true };
  }
  private diagnostic(s: Session, code: ChannelDiagnostic['code'], reason: string) {
    const event = { code, reason, at: this.now(), approvedAt: s.approvedAt, expiresAt: s.deadline, lastSeen: s.lastSeen };
    if (code !== 'HTTP_APPROVED' && code !== 'HTTP_RENEWED') this.lastTermination = event;
    // Logging failure must never prevent a revocation. No capability, origin, token or request body.
    try { this.onDiagnostic?.({...event}); } catch { /* retain security behaviour if logging fails */ }
  }
  revoke(reason = 'Couplage HTTP révoqué ; nouveau couplage requis.', code: ChannelDiagnostic['code'] = 'HTTP_REVOKED'): void {
    const s = this.session;
    this.session = null;
    if (s) this.diagnostic(s,code,reason);
    s?.releasePoll?.();
    if (s?.approved && s.epoch === this.provider.channelEpoch) this.provider.disconnect(reason);
  }
  tick(): void {
    const s = this.session;
    if (!s) return;
    if (this.now() >= s.deadline) {
      this.revoke(s.approved ? 'Couplage navigateur expiré : dix minutes depuis son approbation, indépendamment de la durée du dessin. Nouveau couplage requis.' : 'Demande de couplage expirée avant approbation.', s.approved ? 'HTTP_LIFETIME_EXPIRED' : 'HTTP_PENDING_EXPIRED');
    } else if (s.approved && this.now() - s.lastSeen >= HTTP_IDLE_MS) {
      this.revoke('Couplage navigateur interrompu : aucune activité reçue pendant 30 secondes. Nouveau couplage requis.', 'HTTP_IDLE_EXPIRED');
    } else if (s.approved && s.epoch !== this.provider.channelEpoch) {
      const contextChanged = this.provider.status().error === 'Projet, position, palette ou session modifié : nouveau couplage requis.';
      this.revoke(contextChanged ? 'Contexte de page modifié : projet, position, palette ou session. Nouveau couplage requis.' : 'Canal navigateur remplacé ou interrompu. Nouveau couplage requis.', contextChanged ? 'HTTP_CONTEXT_CHANGED' : 'HTTP_CHANNEL_REPLACED');
    }
  }
  info() {
    this.tick();
    const s = this.session;
    return {
      enabled: this.controlKey !== null,
      batchProtocol: s?.batchProtocol ?? null,
      pending:
        s && !s.approved
          ? { requestId: s.id, fingerprint: s.fingerprint, originClaim: s.originClaim, expires: s.deadline }
          : null,
      active: !!s?.approved,
      approvedAt: s?.approvedAt ?? null,
      expires: s?.approved ? s.deadline : null,
      remainingMs: s?.approved ? Math.max(0,s.deadline-this.now()) : null,
      lastTermination: this.lastTermination ? {...this.lastTermination} : null,
    };
  }
}
