import { join } from 'node:path';
import { Store } from './store.js';
import { importHistory } from './importer.js';
const [directory]=process.argv.slice(2);
if(!directory)throw new Error('Usage: npm run import -- /private/history');
const store=new Store(join(process.env.DATA_DIR??'./data','operations.sqlite'));
const report=importHistory(store,directory);
console.log(JSON.stringify({at:report.at,files:report.files.length,ledgerEntries:report.ledgerEntriesRead,problems:report.problems,coverageComplete:report.coverageComplete}));
store.close();
