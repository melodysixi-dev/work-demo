const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const { once } = require('node:events');
const { createServer } = require('./server');
test('演示密钥按服务转发且不泄漏到页面', async t => {
  const fixture = http.createServer((req, res) => { req.resume(); res.end(JSON.stringify({ authorization: req.headers.authorization })); });
  fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
  t.mock.method(https, 'request', (url, options, callback) => http.request(`http://127.0.0.1:${fixture.address().port}${new URL(url).pathname}`, options, callback));
  const server = createServer({keys:{qa:'qa-test-secret',model:'model-test-secret'}});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); fixture.closeAllConnections(); fixture.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(origin)).text();
  assert.ok(html.includes('const SERVER_KEYS = {"qa":true,"model":true}'));
  assert.ok(!html.includes('test-secret'));
  new (require('node:vm').Script)(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  for (const [path, key] of [['/model/api/chat/completions','model-test-secret'],['/model/api/med-general-qa/chat/completions','qa-test-secret']]) {
    const response = await fetch(origin+path,{method:'POST',body:'{}'});
    assert.equal((await response.json()).authorization,'Bearer '+key);
  }
  assert.equal((await fetch(origin+'/keys.local.json')).status,404);
});
