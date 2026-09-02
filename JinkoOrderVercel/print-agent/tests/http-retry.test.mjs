import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';

import { fetchWithRetry } from '../index.mjs';

let server;
let baseUrl;
let transientCalls = 0;
let missingCalls = 0;

before(async () => {
  server = createServer((request, response) => {
    if (request.url === '/transient') {
      transientCalls += 1;
      const status = transientCalls < 3 ? 503 : 200;
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: status === 200 }));
      return;
    }
    missingCalls += 1;
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: false }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

test('retries transient HTTP failures and returns the eventual response', async () => {
  const response = await fetchWithRetry(`${baseUrl}/transient`);
  assert.equal(response.status, 200);
  assert.equal(transientCalls, 3);
});

test('logs but does not retry a permanent HTTP 404', async () => {
  const response = await fetchWithRetry(`${baseUrl}/missing`);
  assert.equal(response.status, 404);
  assert.equal(missingCalls, 1);
});
