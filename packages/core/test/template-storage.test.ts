import { createMemoryTemplateStorage } from '../src/index.js';
import { testCodec, testHasher } from './helpers/ports.js';
import { storageConformance } from './helpers/storage-conformance.js';

storageConformance({ name: 'memory', make: async () => createMemoryTemplateStorage(), codec: testCodec, hasher: testHasher });
