import { readFileSync } from 'node:fs';
/** Running app version, recorded on outbox and job receipts. */
export const APP_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string;
