'use strict';

// Запуск: npm test (node --test). Сервер поднимается как MCP-клиент его видит — через stdio,
// fetch подменён заглушкой из fetch-stub.js, поэтому запросы в Директ не уходят.

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server.js');
const STUB = path.join(__dirname, 'fetch-stub.js');

function run(tool, args, { env = {}, config = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yd-mcp-test-'));
  if (config) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n';
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('YANDEX_DIRECT_')));
  const res = spawnSync(process.execPath, ['-r', STUB, SERVER], {
    input,
    encoding: 'utf8',
    env: { ...cleanEnv, YANDEX_DIRECT_CONFIG_DIR: dir, YANDEX_DIRECT_TOKEN: 'test-token', ...env },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  const reply = res.stdout.trim().split('\n').map((l) => JSON.parse(l)).find((m) => m.id === 2);
  return { text: reply.result.content[0].text, isError: Boolean(reply.result.isError) };
}

const call = (args, opts) => run('direct_call', { service: 'campaigns', method: 'get', params: {}, ...args }, opts);
const PROD = 'https://api.direct.yandex.com/json/';
const SANDBOX = 'https://api-sandbox.direct.yandex.com/json/';

test('по умолчанию — v5', () => {
  const r = call({});
  assert.ok(!r.isError, r.text);
  assert.ok(r.text.startsWith(`${PROD}v5/campaigns ::`), r.text);
});

test('версия из config.json', () => {
  const r = call({}, { config: { api_version: 'v501' } });
  assert.ok(r.text.startsWith(`${PROD}v501/campaigns ::`), r.text);
});

test('YANDEX_DIRECT_API_VERSION приоритетнее config.json', () => {
  const r = call({}, { config: { api_version: 'v5' }, env: { YANDEX_DIRECT_API_VERSION: 'v501' } });
  assert.ok(r.text.startsWith(`${PROD}v501/campaigns ::`), r.text);
});

test('параметр api_version приоритетнее окружения и конфига', () => {
  const r = call({ api_version: 'v5' }, { config: { api_version: 'v501' }, env: { YANDEX_DIRECT_API_VERSION: 'v501' } });
  assert.ok(r.text.startsWith(`${PROD}v5/campaigns ::`), r.text);
});

test('версия применяется и к песочнице', () => {
  const r = call({ service: 'ads', api_version: 'v501', sandbox: true });
  assert.ok(r.text.startsWith(`${SANDBOX}v501/ads ::`), r.text);
});

test('direct_report учитывает версию', () => {
  const r = run('direct_report', { params: { ReportName: 'x' }, api_version: 'v501' });
  assert.ok(!r.isError, r.text);
  assert.ok(r.text.includes(`${PROD}v501/reports`), r.text);
});

test('неизвестная версия отклоняется', () => {
  for (const opts of [{}, { env: { YANDEX_DIRECT_API_VERSION: 'v6' } }]) {
    const r = call(opts.env ? {} : { api_version: 'v4' }, opts);
    assert.ok(r.isError, r.text);
    assert.match(r.text, /Неизвестная версия API/);
  }
});

test('имя сервиса с путём отклоняется до запроса', () => {
  for (const service of ['../v501/ads', 'v501/ads', 'ads?x=1', 'Ads', 'ads/', '']) {
    const r = call({ service });
    assert.ok(r.isError, `${service}: ${r.text}`);
    assert.ok(!r.text.includes('https://'), `${service}: запрос не должен уйти — ${r.text}`);
  }
  assert.match(call({ service: '../v501/ads' }).text, /api_version/);
});

test('direct_status показывает версию по умолчанию', () => {
  const r = run('direct_status', {}, { env: { YANDEX_DIRECT_API_VERSION: 'v501' } });
  assert.match(r.text, /версия API: v501 \(env YANDEX_DIRECT_API_VERSION/);
  assert.match(r.text, /БОЕВАЯ https:\/\/api\.direct\.yandex\.com\/json\/v501\//);
});
