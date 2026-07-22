#!/usr/bin/env npx tsx

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  handleHostArtifactCacheRequest,
  HostArtifactCache,
} from '../packages/harness-browser/src/host-artifact-cache';

test('host artifact cache is byte bounded and refreshes LRU recency', () => {
  const cache = new HostArtifactCache(2, 8);
  assert.equal(cache.put('a', 'aaaa'), true);
  assert.equal(cache.put('b', 'bbbb'), true);
  assert.equal(cache.get('a'), 'aaaa');
  assert.equal(cache.put('c', 'cccc'), true);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 'aaaa');
  assert.equal(cache.get('c'), 'cccc');
  assert.equal(cache.size, 2);
  assert.equal(cache.byteLength, 8);
});

test('host artifact cache rejects oversized values without evicting valid entries', () => {
  const cache = new HostArtifactCache(2, 4);
  assert.equal(cache.put('valid', 'data'), true);
  assert.equal(cache.put('oversized', '12345'), false);
  assert.equal(cache.get('valid'), 'data');
  assert.equal(cache.size, 1);
  assert.equal(cache.byteLength, 4);
});

test('host artifact cache protocol requires the active worker token', () => {
  const cache = new HostArtifactCache(2, 32);
  const replies: unknown[] = [];
  const worker = { postMessage: (message: unknown) => replies.push(message), terminate() {} };
  handleHostArtifactCacheRequest({
    cache,
    worker,
    validateProtocolToken: (token) => token === 'active-token',
    message: {
      type: 'compiler-artifact-cache-request',
      requestId: 'denied',
      protocolToken: 'stale-token',
      payload: { operation: 'put', key: 'artifact', value: 'bytes' },
    },
  });
  assert.equal(cache.size, 0);
  assert.equal(replies.length, 0);

  handleHostArtifactCacheRequest({
    cache,
    worker,
    validateProtocolToken: (token) => token === 'active-token',
    message: {
      type: 'compiler-artifact-cache-request',
      requestId: 'accepted',
      protocolToken: 'active-token',
      payload: { operation: 'put', key: 'artifact', value: 'bytes' },
    },
  });
  assert.equal(cache.get('artifact'), 'bytes');
  assert.equal(replies.length, 1);
});
