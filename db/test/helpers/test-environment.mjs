import assert from 'node:assert/strict';

export const container = process.env.AJTOOL_TEST_CONTAINER || 'ajtool-industrial-test-20261021';
export const port = process.env.AJTOOL_TEST_PORT || '55439';
assert.match(port, /^\d{1,5}$/);
assert.ok(Number(port) > 0 && Number(port) <= 65535);
export function assertTestContainer (info) {
  assert.equal(info.Config.Image, 'postgres:16');
  assert.deepEqual(info.NetworkSettings.Ports['5432/tcp'], [{ HostIp: '127.0.0.1', HostPort: port }]);
  if (container !== 'ajtool-industrial-test-20261021') {
    assert.match(container, /^ajtool-durability-ci-[a-f0-9]+$/);
    assert.equal(info.Config.Labels['ajtool.durability-test'], 'true');
  }
}
