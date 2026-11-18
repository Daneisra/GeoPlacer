import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, open, rename, statfs } from 'node:fs/promises';
import path from 'node:path';
import { assertMetadataHeadroom } from './capacity.js';
type Archive = { schema: 1; batch: unknown; records: unknown[] };
type Manifest = { schema: 2; batch: unknown; segments: number; recordCount: number; head: string };
type Segment = { schema: 1; index: number; previous: string; records: unknown[]; hash: string };
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const EMPTY = hash([]);
/** Immutable, chained metadata segments beside the EXISTING attempt journal.
 * No retention/deletion. A crash between segment and manifest is recovered from the valid chain.
 * The attempt journal remains the authority for execution outcomes. */
export class BatchMetadataStore {
    private count = 0;
    private segments = 0;
    private head = EMPTY;
    private readonly directory: string;
    constructor(
        private readonly root: string,
        private readonly saveManifest: (v: unknown) => Promise<void>
    ) {
        this.directory = path.join(root, 'connector-confirmations');
    }
    private async immutable(filename: string, value: unknown) {
        const body = JSON.stringify(value),
            target = path.join(this.directory, filename);
        try {
            if ((await readFile(target, 'utf8')) === body) return;
            throw new Error('Confirmation segment already exists with different content');
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
        const disk = await statfs(this.directory);
        if (disk.bavail * disk.bsize < Buffer.byteLength(body) + 16 * 1048576)
            throw new Error('Espace disque insuffisant pour conserver les confirmations');
        const temp = target + '.' + randomUUID() + '.partial',
            file = await open(temp, 'wx');
        try {
            await file.writeFile(body, 'utf8');
            await file.sync();
        } finally {
            await file.close();
        }
        await rename(temp, target);
    }
    async load(value: unknown): Promise<unknown> {
        await mkdir(this.directory, { recursive: true });
        if (value === null) return null;
        const m = value as Manifest;
        if (m.schema !== 2) return value; // Legacy archive is preserved on the first save.
        if (
            !Number.isSafeInteger(m.segments) ||
            m.segments < 0 ||
            !Number.isSafeInteger(m.recordCount) ||
            m.recordCount < 0
        )
            throw new Error('Invalid confirmation manifest');
        const names = (await readdir(this.directory)).filter((n) => /^segment-\d{16}\.json$/.test(n)).sort();
        const records: unknown[] = [];
        for (const name of names) {
            const raw = await readFile(path.join(this.directory, name), 'utf8');
            assertMetadataHeadroom(raw.length * 4);
            const s = JSON.parse(raw) as Segment;
            if (
                s.schema !== 1 ||
                s.index !== this.segments + 1 ||
                s.previous !== this.head ||
                !Array.isArray(s.records) ||
                s.hash !== hash([s.index, s.previous, s.records])
            )
                throw new Error('Confirmation chain damaged; preserve files before repair');
            for (const record of s.records) records.push(record);
            this.segments = s.index;
            this.head = s.hash;
            if (s.index === m.segments && (records.length !== m.recordCount || this.head !== m.head))
                throw new Error('Confirmation manifest mismatch');
        }
        if (this.segments < m.segments || (m.segments === 0 && (m.recordCount !== 0 || m.head !== EMPTY)))
            throw new Error('Missing confirmation segments');
        this.count = records.length;
        return { schema: 1, batch: m.batch, records };
    }
    async save(value: unknown) {
        const a = value as Archive;
        assertMetadataHeadroom();
        if (a.schema !== 1 || !Array.isArray(a.records) || a.records.length < this.count)
            throw new Error('Confirmation history cannot shrink');
        await mkdir(this.directory, { recursive: true });
        if (this.segments === 0 && this.count === 0) {
            // Keep the original v1 archive, including historical metadata, without overwriting it.
            try {
                const old = JSON.parse(await readFile(path.join(this.root, 'connector-batch.json'), 'utf8'));
                if (old.schema === 1) await this.immutable('legacy-v1.json', old);
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
            }
        }
        if (a.records.length > this.count) {
            const index = this.segments + 1,
                records = a.records.slice(this.count),
                previous = this.head;
            const s: Segment = { schema: 1, index, previous, records, hash: hash([index, previous, records]) };
            await this.immutable('segment-' + String(index).padStart(16, '0') + '.json', s);
            this.segments = index;
            this.count = a.records.length;
            this.head = s.hash;
        }
        await this.saveManifest({
            schema: 2,
            batch: a.batch,
            segments: this.segments,
            recordCount: this.count,
            head: this.head,
        });
    }
}
