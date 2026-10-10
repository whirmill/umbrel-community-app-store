import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../web/components/AgentComposer.tsx',import.meta.url),'utf8');
test('web historical surface directs conversation to Telegram and retains model settings without input or submission controls',()=>{
 assert.match(source,/Conversazione disponibile su Telegram/);
 assert.match(source,/<ModelPicker/);
 assert.doesNotMatch(source,/<(?:textarea|form|ComposerPrimitive\.(?:Input|Send|Root))/);
 assert.doesNotMatch(source,/void onSubmit\(|void onAnalysis\(|\.send\(/);
});
