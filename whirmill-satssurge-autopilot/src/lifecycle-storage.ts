import {join} from 'node:path';
/** Storage-only migration; caller owns the exclusive lifecycle fence. */
export async function migrateStorage(directory: string) {
const {Store}=await import('./store.js');
const {Credentials}=await import('./credentials.js');
const {openNodeSqliteDatabase}=await import('@earendil-works/pi-durable/storage/sqlite/node');
const {SqliteStorage}=await import('@earendil-works/pi-durable/storage/sqlite');
const store=new Store(join(directory,'operational.sqlite'));
store.close();
const credentials=new Credentials(join(directory,'oauth.sqlite'));
await credentials.close();
const database=await openNodeSqliteDatabase(join(directory,'durable.sqlite'));
try {
  await database.exec('PRAGMA synchronous=FULL');
  await SqliteStorage.open(database);
} finally { await database.close(); }

}
