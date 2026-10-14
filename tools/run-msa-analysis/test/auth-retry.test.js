import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublisher } from '../src/platform/poller.js';
test('401 and 403 are retryable after credentials recover', async () => {
  let status = 401;
  const core = { configured: true, publish: async () => { if (status !== 200) throw Object.assign(new Error('auth failed'), { kind: 'auth', status }); return { outcome: 'published', eventId: 'test-1', seq: 1 }; } };
  const publisher = createPublisher({ core, mode: 'live' });
  const event = { event_id: 'test-1', event: { type: 'TEST' } };
  await assert.rejects(publisher.publish(event), { kind: 'auth', status: 401 });
  status = 403;
  await assert.rejects(publisher.publish(event), { kind: 'auth', status: 403 });
  status = 200;
  assert.equal((await publisher.publish(event)).state, 'published');
});
