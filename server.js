'use strict';

const http = require('node:http');
const https = require('node:https');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const UPSTREAM = 'https://zx-dsc.sm.cn';
const API_PATHS = new Set([
  '/model/api/med-general-qa/chat/completions',
  '/model/api/chat/completions'
]);

function json(res, status, message) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify({ error: { message } }));
}

function createServer({ keys = {} } = {}) {
  return http.createServer(async (req, res) => {
    const port = res.socket.localPort;
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!allowedHosts.has(req.headers.host)) {
      json(res, 403, '请通过本机 localhost 或 127.0.0.1 访问。');
      return;
    }
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
      json(res, 403, '仅允许本地页面的同源请求。');
      return;
    }
    if (req.url === '/' || req.url === '/medical-chat.html') {
      if (req.method !== 'GET') {
        json(res, 405, '页面仅支持 GET。');
        return;
      }
      try {
        const html = await readFile(path.join(__dirname, 'medical-chat.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html.toString().replace('/* SERVER_CONFIG */', 'const SERVER_KEYS = ' + JSON.stringify({qa: Boolean(keys.qa), model: Boolean(keys.model)}) + ';'));
      } catch {
        json(res, 500, '无法读取 medical-chat.html。');
      }
      return;
    }
    if (!API_PATHS.has(req.url)) {
      json(res, 404, '未找到该页面或代理接口。');
      return;
    }
    if (req.method !== 'POST') {
      json(res, 405, '接口仅支持 POST。');
      return;
    }
    const service = req.url === '/model/api/chat/completions' ? 'model' : 'qa';
    const authorization = req.headers.authorization || (keys[service] ? 'Bearer ' + keys[service] : '');
    if (!/^Bearer\s+\S+$/i.test(authorization)) {
      json(res, 401, '请输入当前服务的 API Key。');
      return;
    }

    const upstream = https.request(UPSTREAM + req.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': req.headers.accept || '*/*',
        'Accept-Encoding': 'identity',
        'Authorization': authorization
      }
    }, response => {
      if (res.destroyed) {
        response.destroy();
        return;
      }
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.resume();
        json(res, 502, '上游返回了重定向，代理未跟随。');
        return;
      }
      const headers = {
        'Content-Type': response.headers['content-type'] || 'application/json',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no'
      };
      if (response.headers['content-encoding']) headers['Content-Encoding'] = response.headers['content-encoding'];
      res.writeHead(response.statusCode, headers);
      res.flushHeaders();
      response.on('error', () => res.destroy());
      response.on('aborted', () => res.destroy());
      response.pipe(res);
    });
    upstream.setTimeout(300_000, () => {
      const error = new Error('upstream timeout');
      error.code = 'ETIMEDOUT';
      upstream.destroy(error);
    });
    upstream.on('error', error => {
      if (res.destroyed) return;
      if (res.headersSent) res.destroy();
      else json(res, error.code === 'ETIMEDOUT' ? 504 : 502,
        error.code === 'ETIMEDOUT' ? '上游响应超时，请重试。' : '本地代理无法连接医疗接口，请检查本机网络后重试。');
    });
    req.on('aborted', () => upstream.destroy());
    req.on('error', () => { upstream.destroy(); res.destroy(); });
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    req.pipe(upstream);
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT 必须是 1 到 65535 的整数。');
    process.exit(1);
  }
  let keys = {};
  try { keys = require('./keys.local.json'); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') { console.error('keys.local.json 格式无效。'); process.exit(1); }
  }
  const server = createServer({ keys: {
    qa: process.env.MEDICAL_QA_API_KEY || keys.qa,
    model: process.env.MEDICAL_MODEL_API_KEY || keys.model
  } });
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，可使用 PORT=3001 npm start。` : `本地服务启动失败：${error.code || '未知错误'}`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log(`医疗 AI 已启动：http://127.0.0.1:${port}`));
}

module.exports = { createServer };
