import {requireLifecycleGate} from './lifecycle-gate.js';
import {resolve} from 'node:path';
requireLifecycleGate('migration');
const {migrateStorage}=await import('./lifecycle-storage.js');
await migrateStorage(resolve(process.env.DATA_DIR ?? '/data'));
