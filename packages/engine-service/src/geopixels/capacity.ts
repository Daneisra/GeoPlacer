import { freemem, totalmem } from 'node:os';
import { getHeapStatistics } from 'node:v8';
/** Model admission reserves 64 bytes/pixel for image, observations, indexes and working buffers.
 * Bounds are resources, not a 4096 side length. Wire packets keep their independent size limit. */
const configured = process.env.GEOPLACER_MODEL_MEMORY_MIB;
const mib = configured === undefined ? Math.min(1024, Math.floor(totalmem() / 4 / 1048576)) : Number(configured);
if (!Number.isSafeInteger(mib) || mib < 64 || mib * 1048576 > totalmem() / 2)
    throw new Error('GEOPLACER_MODEL_MEMORY_MIB must reserve 64 MiB to half of physical RAM');
export const MODEL_MEMORY_BYTES = mib * 1048576;
export const MAX_MODEL_PIXELS = Math.min(2 ** 32 - 1, Math.floor(MODEL_MEMORY_BYTES / 64));
export function assertMetadataHeadroom(bytes = 65536) {
    if (
        getHeapStatistics().heap_size_limit - process.memoryUsage().heapUsed < bytes + 16 * 1048576 ||
        freemem() < bytes + 32 * 1048576
    )
        throw new Error(
            'Mémoire disponible insuffisante : arrêt avant une nouvelle réservation ; confirmations conservées.'
        );
}
