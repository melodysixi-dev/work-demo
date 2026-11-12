'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const { once } = require('node:events');
const { createServer } = require('./server');

test('本地代理', { timeout: 15_000 }, async t => {
  let handler, forwarded = [];
  const fixture = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      forwarded.push({ path: req.url, headers: req.headers, body });
      handler(req, res);
    });
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const fixtureOrigin = `http://127.0.0.1:${fixture.address().port}`;
  const destinations = [];
  t.mock.method(https, 'request', (url, options, callback) => {
    destinations.push(url);
    return http.request(fixtureOrigin + new URL(url).pathname, options, callback);
  });
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    for (const instance of [server, fixture]) instance.closeAllConnections();
    await Promise.all([server, fixture].map(instance => new Promise(resolve => instance.close(resolve))));
  });
  const apiPath = '/model/api/chat/completions';
  const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer regression-test-key' };

  await t.test('托管页面，拒绝未授权、非同源及白名单以外的请求', async () => {
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /医疗助手/);
    for (const [path, options, status] of [
      ['/server.js', {}, 404],
      ['/model/api/unknown', { method: 'POST', headers }, 404],
      [apiPath + '?url=https://example.com', { method: 'POST', headers }, 404],
      [apiPath, { method: 'GET', headers }, 405],
      [apiPath, { method: 'POST' }, 401],
      [apiPath, { method: 'POST', headers: { ...headers, Origin: 'https://example.com' } }, 403]
    ]) {
      const response = await fetch(origin + path, options);
      assert.equal(response.status, status);
      await response.text();
    }
    assert.equal(forwarded.length, 0);
  });

  await t.test('两个接口转发 JSON 和鉴权，保留上游错误，不转发 Cookie 或 Origin', async () => {
    handler = (_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json', 'Set-Cookie': 'upstream-cookie=secret' });
      res.end('{"error":{"message":"invalid API key"}}');
    };
    const body = JSON.stringify({ messages: [{ role: 'user', content: '中文输入' }], stream: false });
    for (const path of [apiPath, '/model/api/med-general-qa/chat/completions']) {
      const response = await fetch(origin + path, { method: 'POST', headers: { ...headers, Accept: 'application/json', Origin: origin, Cookie: 'browser-cookie=private' }, body });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal((await response.json()).error.message, 'invalid API key');
      const request = forwarded.at(-1);
      assert.equal(request.path, path);
      assert.equal(request.body, body);
      assert.equal(request.headers.authorization, headers.Authorization);
      assert.equal(request.headers.accept, 'application/json');
      assert.equal(request.headers.cookie, undefined);
      assert.equal(request.headers.origin, undefined);
      assert.equal(destinations.at(-1), 'https://zx-dsc.sm.cn' + path);
    }
  });

  await t.test('SSE 在上游结束前到达浏览器，保持中文及 DONE 标记', async () => {
    let finish;
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"content":"中文"}\n\n');
      finish = () => res.end('data: [DONE]\n\n');
    };
    const response = await fetch(origin + apiPath, { method: 'POST', headers: { ...headers, Accept: 'text/event-stream' }, body: '{}' });
    assert.equal(forwarded.at(-1).headers.accept, 'text/event-stream');
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.match(new TextDecoder().decode(first.value), /中文/);
    finish();
    let rest = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    assert.match(rest, /\[DONE\]/);
  });

  await t.test('取消浏览器请求会断开上游流', async () => {
    let closed;
    const upstreamClosed = new Promise(resolve => { closed = resolve; });
    handler = (_req, res) => {
      res.on('close', closed);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"content":"partial"}\n\n');
    };
    const response = await fetch(origin + apiPath, { method: 'POST', headers, body: '{}' });
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
    await upstreamClosed;
  });

  await t.test('不跟随上游重定向', async () => {
    handler = (_req, res) => {
      res.writeHead(302, { Location: 'https://example.com' });
      res.end();
    };
    const response = await fetch(origin + apiPath, { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('location'), null);
    assert.match((await response.json()).error.message, /未跟随/);
  });

  await t.test('上游连接失败时返回可读的 502', async () => {
    handler = (req, _res) => req.socket.destroy();
    const response = await fetch(origin + apiPath, { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 502);
    const body = await response.text();
    assert.match(JSON.parse(body).error.message, /无法连接医疗接口/);
    assert.equal(body.includes('regression-test-key'), false);
  });

  await t.test('上游中途断流会让下游读流失败', async () => {
    let disconnect;
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"content":"partial"}\n\n');
      disconnect = () => res.destroy();
    };
    const response = await fetch(origin + apiPath, { method: 'POST', headers, body: '{}' });
    const reader = response.body.getReader();
    assert.equal((await reader.read()).done, false);
    disconnect();
    await assert.rejects(reader.read());
  });
});
