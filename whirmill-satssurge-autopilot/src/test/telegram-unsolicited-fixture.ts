import assert from 'node:assert/strict';
import { Store } from '../store.js';
import { day } from '../domain.js';
import { romeHour, telegramHtml } from '../telegram.js';

// Unsolicited traffic is still exercised and acknowledged. Only the exact persisted
// digest receipt in the fixture's current destination may bypass its scenario response.
export function unsolicitedFixture(store: Store) {
    const calls: { method: string; body: any; eventId: string; generation: string; chatId: number; messageId: number }[] = [];
    return {
        calls,
        async acknowledge(method: string, body: any): Promise<{ message_id: number } | undefined> {
            const binding = store.get<any>('telegramBinding');
            if (!binding) return;
            let row: any;
            if (method === 'sendMessage' && body?.chat_id === binding.chatId && body.parse_mode === 'HTML') {
                row = store.all("SELECT * FROM telegram_outbox WHERE kind='digest' AND status='sending' AND generation=?", binding.generation)
                    .find(r => r.event_id === 'digest:' + day(r.created_at) && romeHour(r.created_at) >= 9 && body.text === telegramHtml(r.text));
            }
            if (!row) return;
            assert.equal(row.attempts, 1, 'unsolicited fixture acknowledgement must not be replayed');
            assert.ok(!calls.some(c => c.eventId === row.event_id), 'one physical call per unsolicited receipt');
            const messageId = 900000 + calls.length + 1;
            calls.push({ method, body, eventId: row.event_id, generation: binding.generation, chatId: binding.chatId, messageId });
            return { message_id: messageId };
        },
        verify() {
            for (const call of calls) {
                const row = store.one('SELECT * FROM telegram_outbox WHERE event_id=?', call.eventId);
                assert.equal(row.status, 'sent'); assert.equal(row.attempts, 1);
                assert.equal(row.message_id, call.messageId); assert.equal(row.generation, call.generation);
                assert.equal(call.body.chat_id, call.chatId);
            }
        }
    };
}
