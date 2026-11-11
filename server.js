#!/usr/bin/env node
'use strict';

/**
 * Yandex Direct API v5 -> MCP (stdio) bridge.
 * Zero dependencies: raw JSON-RPC over newline-delimited stdio, global fetch (Node >= 18).
 *
 * Credentials (re-read on every call, so a token can be added without restarting):
 *   ~/.config/yandex-direct/config.json  {"token": "...", "client_login": "...", "sandbox": false}
 *   ~/.config/yandex-direct/token        (plain token, fallback)
 *   env YANDEX_DIRECT_TOKEN / YANDEX_DIRECT_CLIENT_LOGIN / YANDEX_DIRECT_SANDBOX / YANDEX_DIRECT_READONLY
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER_NAME = 'yandex-direct';
const SERVER_VERSION = '0.1.0';

const PROD_BASE = 'https://api.direct.yandex.com/json/v5/';
const SANDBOX_BASE = 'https://api-sandbox.direct.yandex.com/json/v5/';

const CONFIG_DIR =
  process.env.YANDEX_DIRECT_CONFIG_DIR || path.join(os.homedir(), '.config', 'yandex-direct');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const TOKEN_FILE = path.join(CONFIG_DIR, 'token');

const SERVICES = [
  'adextensions', 'adgroups', 'adimages', 'ads', 'agencyclients', 'audiencetargets',
  'bidmodifiers', 'bids', 'businesses', 'campaigns', 'changes', 'clients', 'creatives',
  'dictionaries', 'dynamicfeedadtargets', 'dynamictextadtargets', 'feeds', 'keywordbids',
  'keywords', 'keywordsresearch', 'leads', 'negativekeywordsharedsets', 'retargetinglists',
  'sitelinks', 'smartadtargets', 'turbopages', 'vcards',
];

const MUTATING = /^(add|update|delete|archive|unarchive|suspend|resume|moderate|set|setAuto|setRelated|push)$/i;

function truthy(v) {
  return typeof v === 'string' && /^(1|true|yes|on)$/i.test(v.trim());
}

function loadConfig() {
  const cfg = { token: null, client_login: null, sandbox: false, readonly: false };
  try {
    Object.assign(cfg, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } catch (_) { /* no config file yet */ }
  if (!cfg.token) {
    try { cfg.token = fs.readFileSync(TOKEN_FILE, 'utf8').trim() || null; } catch (_) {}
  }
  if (process.env.YANDEX_DIRECT_TOKEN) cfg.token = process.env.YANDEX_DIRECT_TOKEN;
  if (process.env.YANDEX_DIRECT_CLIENT_LOGIN) cfg.client_login = process.env.YANDEX_DIRECT_CLIENT_LOGIN;
  if (process.env.YANDEX_DIRECT_SANDBOX) cfg.sandbox = truthy(process.env.YANDEX_DIRECT_SANDBOX);
  if (process.env.YANDEX_DIRECT_READONLY) cfg.readonly = truthy(process.env.YANDEX_DIRECT_READONLY);
  return cfg;
}

function baseUrl(sandbox) {
  return sandbox ? SANDBOX_BASE : PROD_BASE;
}

function authHeaders(cfg, clientLogin) {
  const h = {
    Authorization: `Bearer ${cfg.token}`,
    'Accept-Language': 'ru',
    'Content-Type': 'application/json; charset=utf-8',
  };
  const login = clientLogin || cfg.client_login;
  if (login) h['Client-Login'] = login;
  return h;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/*
 * Номера объявлений в Директе 19-значные (1234567890123456789), а число в JS точно только до 2^53
 * (16 цифр). Обычный JSON.parse округляет такие номера: 1234567890123456789 и …790 оба превращаются
 * в 1234567890123456800, и агент правит не то объявление. Поэтому целые больше 2^53 оборачиваем
 * в кавычки до разбора и отдаём строками. Директ принимает номера строками и в запросах.
 * Строки JSON пропускаются целиком, дробные числа и экспонента не трогаются.
 */
const JSON_STRING_OR_LONG_INT = /("[^"\\]*(?:\\.[^"\\]*)*")|(?<![\d.eE+-])(-?\d{16,})(?![\d.eE])/g;

function parseJsonKeepingLongInts(text) {
  return JSON.parse(text.replace(JSON_STRING_OR_LONG_INT, (match, str, int) =>
    str !== undefined || Number.isSafeInteger(Number(int)) ? match : `"${int}"`));
}

// Длинный номер, переданный числом, мог быть округлён ещё на стороне MCP-клиента — в Директ его не пускаем.
function findUnsafeInteger(value, where) {
  if (typeof value === 'number') return Number.isInteger(value) && !Number.isSafeInteger(value) ? where : null;
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const hit = findUnsafeInteger(item, Array.isArray(value) ? `${where}[${key}]` : `${where}.${key}`);
      if (hit) return hit;
    }
  }
  return null;
}

/* ---------------------------------------------------------------- tools --- */

async function toolStatus() {
  const cfg = loadConfig();
  const lines = [
    `token: ${cfg.token ? `загружен (${cfg.token.length} симв., ...${cfg.token.slice(-4)})` : 'НЕ НАЙДЕН'}`,
    `источник: ${process.env.YANDEX_DIRECT_TOKEN ? 'env YANDEX_DIRECT_TOKEN' : `${CONFIG_FILE} / ${TOKEN_FILE}`}`,
    `client_login: ${cfg.client_login || '(не задан — работаем от владельца токена)'}`,
    `среда: ${cfg.sandbox ? 'ПЕСОЧНИЦА ' + SANDBOX_BASE : 'БОЕВАЯ ' + PROD_BASE}`,
    `readonly: ${cfg.readonly ? 'ДА (мутирующие методы заблокированы)' : 'нет (доступны add/update/delete)'}`,
  ];
  if (!cfg.token) {
    lines.push('', `Положи токен в ${TOKEN_FILE} (chmod 600) или в ${CONFIG_FILE}.`);
    return lines.join('\n');
  }
  try {
    const res = await callApi(cfg, 'clients', 'get', { FieldNames: ['Login', 'Currency', 'Type'] }, null);
    lines.push('', 'Проверка доступа: OK', JSON.stringify(res.body, null, 2), `Баллы (Units): ${res.units || 'n/a'}`);
  } catch (e) {
    lines.push('', `Проверка доступа: ОШИБКА — ${e.message}`);
  }
  return lines.join('\n');
}

async function callApi(cfg, service, method, params, clientLogin, sandboxOverride) {
  const sandbox = sandboxOverride === undefined || sandboxOverride === null ? cfg.sandbox : sandboxOverride;
  const url = baseUrl(sandbox) + service;
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(cfg, clientLogin),
    body: JSON.stringify({ method, params: params || {} }),
  });
  const units = res.headers.get('units');
  const requestId = res.headers.get('requestid');
  const text = await res.text();
  let body;
  try { body = parseJsonKeepingLongInts(text); } catch (_) { body = { raw: text }; }
  if (body && body.error) {
    const e = body.error;
    throw new Error(
      `Direct API error ${e.error_code}: ${e.error_string} — ${e.error_detail || ''} (request_id ${e.request_id || requestId})`
    );
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 800)}`);
  return { body, units, requestId, url };
}

async function toolCall(args) {
  const cfg = loadConfig();
  if (!cfg.token) throw new Error(`Нет OAuth-токена. Положи его в ${TOKEN_FILE} и повтори.`);
  const { service, method, params, client_login, sandbox } = args;
  if (!service || !method) throw new Error('Нужны параметры service и method.');
  if (cfg.readonly && MUTATING.test(method)) {
    throw new Error(`readonly-режим: метод "${method}" заблокирован. Сними YANDEX_DIRECT_READONLY, чтобы менять данные.`);
  }

  const unsafe = findUnsafeInteger(params, 'params');
  if (unsafe) {
    throw new Error(
      `${unsafe}: число больше 2^53 и могло быть округлено по дороге — запрос не отправлен, чтобы не задеть чужой объект. ` +
      'Передай длинные номера строками: {"Ids": ["1234567890123456789"]}.'
    );
  }
  const res = await callApi(cfg, service, method, params, client_login, sandbox);
  const head = `${res.url} :: ${method} :: Units ${res.units || 'n/a'} :: RequestId ${res.requestId || 'n/a'}`;
  return `${head}\n\n${JSON.stringify(res.body.result !== undefined ? res.body.result : res.body, null, 2)}`;
}

async function toolReport(args) {
  const cfg = loadConfig();
  if (!cfg.token) throw new Error(`Нет OAuth-токена. Положи его в ${TOKEN_FILE} и повтори.`);
  const params = args.params;
  if (!params) throw new Error('Нужен объект params (ReportDefinition).');
  const sandbox = args.sandbox === undefined || args.sandbox === null ? cfg.sandbox : args.sandbox;
  const url = baseUrl(sandbox) + 'reports';
  const headers = Object.assign(authHeaders(cfg, args.client_login), {
    processingMode: args.processing_mode || 'auto',
    returnMoneyInMicros: 'false',
    skipReportHeader: 'true',
    skipReportSummary: 'true',
    skipColumnHeader: 'false',
  });
  const body = JSON.stringify({ params });
  const deadline = Date.now() + (args.wait_seconds || 180) * 1000;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const res = await fetch(url, { method: 'POST', headers, body });
    const units = res.headers.get('units');
    if (res.status === 200) {
      const tsv = await res.text();
      const rows = tsv.trim() ? tsv.trim().split('\n').length - 1 : 0;
      return `Отчёт готов (попытка ${attempt}, Units ${units || 'n/a'}, строк: ${rows})\n\n${tsv}`;
    }
    if (res.status === 201 || res.status === 202) {
      const retryIn = parseInt(res.headers.get('retryin') || '5', 10);
      await res.text();
      if (Date.now() + retryIn * 1000 > deadline) {
        return `Отчёт ещё готовится (HTTP ${res.status}). Истёк лимит ожидания ${args.wait_seconds || 180} c — повтори тот же запрос позже, Директ отдаст готовый файл.`;
      }
      await sleep(Math.max(retryIn, 1) * 1000);
      continue;
    }
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch (_) {}
    if (parsed && parsed.error) {
      const e = parsed.error;
      throw new Error(`Reports error ${e.error_code}: ${e.error_string} — ${e.error_detail || ''}`);
    }
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 800)}`);
  }
}

const REFERENCE = `Яндекс Директ API v5 — шпаргалка для direct_call.

Базовые URL: боевой ${PROD_BASE} | песочница ${SANDBOX_BASE}
Тело запроса собирается сервером: {"method": <method>, "params": <params>}

Сервисы: ${SERVICES.join(', ')}

Типовые методы: get, add, update, delete, archive, unarchive, suspend, resume, moderate (ads),
set / setAuto (bids, keywordbids), hasSearchVolume (keywordsresearch).

Примеры params:
* campaigns.get      {"SelectionCriteria":{"States":["ON"]},"FieldNames":["Id","Name","State","Status","DailyBudget"],"TextCampaignFieldNames":["BiddingStrategy"]}
* campaigns.suspend  {"SelectionCriteria":{"Ids":[123456]}}
* adgroups.get       {"SelectionCriteria":{"CampaignIds":[123456]},"FieldNames":["Id","Name","CampaignId","Status"]}
* ads.get            {"SelectionCriteria":{"CampaignIds":[123456]},"FieldNames":["Id","AdGroupId","Type","State","Status"],"TextAdFieldNames":["Title","Title2","Text","Href"],"ResponsiveAdFieldNames":["Titles","Texts","Href"]}
* ads.get по номерам {"SelectionCriteria":{"Ids":["1234567890123456789"]},"FieldNames":["Id","AdGroupId","Type"]}   // номера объявлений — строками
* ads.add            {"Ads":[{"AdGroupId":111,"ResponsiveAd":{"Titles":["Заголовок 1","Заголовок 2"],"Texts":["Текст 1","Текст 2"],"Href":"https://example.com"}}]}
* keywords.get       {"SelectionCriteria":{"CampaignIds":[123456]},"FieldNames":["Id","Keyword","Bid","State","Status","StatisticsSearch"]}
* keywords.add       {"Keywords":[{"AdGroupId":111,"Keyword":"купить кроссовки nike","Bid":30000000}]}
* bids.set           {"Bids":[{"KeywordId":222,"Bid":25000000}]}          // ставки в микроединицах: 25 000 000 = 25 руб.
* keywordbids.setAuto{"KeywordBids":[{"CampaignId":123456,"MaxBid":40000000,"TargetTrafficVolume":75}]}

Отчёты (инструмент direct_report, params = ReportDefinition):
{"SelectionCriteria":{"DateFrom":"2026-08-01","DateTo":"2026-08-26"},
 "FieldNames":["Date","CampaignName","Impressions","Clicks","Cost","Ctr","AvgCpc","Conversions"],
 "ReportName":"campaign-aug-<уникальный суффикс>","ReportType":"CAMPAIGN_PERFORMANCE_REPORT",
 "DateRangeType":"CUSTOM_DATE","Format":"TSV","IncludeVAT":"YES","IncludeDiscount":"NO"}
ReportType: ACCOUNT_PERFORMANCE_REPORT, CAMPAIGN_PERFORMANCE_REPORT, ADGROUP_PERFORMANCE_REPORT,
AD_PERFORMANCE_REPORT, CRITERIA_PERFORMANCE_REPORT, SEARCH_QUERY_PERFORMANCE_REPORT,
CUSTOM_REPORT, REACH_AND_FREQUENCY_PERFORMANCE_REPORT.
ReportName должен быть уникальным. Cost приходит в валюте (returnMoneyInMicros=false).

Длинные номера: Id объявлений — 19 цифр, это больше точности чисел JSON в JS (2^53). В ответах сервер
отдаёт такие номера строками ("Id": "1234567890123456789"), в params передавай их тоже строками — Директ
их принимает. Длинный номер, переданный числом, сервер отклонит: по дороге он мог округлиться в чужой.

Объявления: текстовые объявления теперь комбинаторные (Type RESPONSIVE_AD) — структура ResponsiveAd
в add/update, ResponsiveAdFieldNames в get. Titles — от 1 до 7 заголовков (до 56 символов),
Texts — от 1 до 3 текстов (до 81 символа), в группе до 3 неархивных комбинаторных объявлений.
* TextAd в ads.add создаёт комбинаторное объявление с одним заголовком и одним текстом
  (Title2 приклеивается к Title через «. » или теряется). Для нескольких заголовков — ResponsiveAd.
* ads.update с TextAd по комбинаторному объявлению оставит в нём один заголовок и один текст —
  править только через ResponsiveAd.
* ads.get без ResponsiveAdFieldNames показывает комбинаторные объявления как TEXT_AD
  с первым заголовком и текстом.

Лимиты: ответ get отдаёт максимум 10 000 объектов — листай через LimitOffset {"Limit":10000,"Offset":N}.
Каждый вызов тратит баллы (Units) — они в заголовке ответа и печатаются в выводе.`;

const TOOLS = [
  {
    name: 'direct_status',
    description:
      'Проверить подключение к Яндекс Директу: найден ли токен, какая среда (боевая/песочница), доступен ли API (пробный clients.get) и сколько осталось баллов. Токен не раскрывается.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'direct_call',
    description:
      'Универсальный вызов Яндекс Директ API v5: POST на /json/v5/{service} с телом {method, params}. Покрывает всё управление: кампании, группы, объявления, ключевые фразы, ставки, ретаргетинг, справочники. Сначала загляни в direct_reference за именами сервисов, методов и формой params. Номера объявлений (19 цифр) приходят и передаются строками: число больше 2^53 по дороге округлится.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'Сервис API v5, например campaigns, adgroups, ads, keywords, bids, dictionaries.' },
        method: { type: 'string', description: 'Метод сервиса: get, add, update, delete, suspend, resume, archive, moderate, set, setAuto.' },
        params: { type: 'object', description: 'Объект params запроса (SelectionCriteria, FieldNames, массивы объектов и т.д.). Длинные номера (Id объявлений) — строками: {"Ids": ["1234567890123456789"]}.' },
        client_login: { type: 'string', description: 'Логин клиента для агентского аккаунта (заголовок Client-Login). По умолчанию берётся из конфига.' },
        sandbox: { type: 'boolean', description: 'true — бить в песочницу, false — в боевой API. По умолчанию из конфига.' },
      },
      required: ['service', 'method'],
      additionalProperties: false,
    },
  },
  {
    name: 'direct_report',
    description:
      'Статистика через сервис Reports API v5. Принимает ReportDefinition в params, сам дожидается готовности отчёта (коды 201/202 с повторами) и возвращает TSV.',
    inputSchema: {
      type: 'object',
      properties: {
        params: { type: 'object', description: 'ReportDefinition: SelectionCriteria, FieldNames, ReportName (уникальное), ReportType, DateRangeType, Format: TSV, IncludeVAT, IncludeDiscount.' },
        client_login: { type: 'string', description: 'Логин клиента для агентского аккаунта.' },
        sandbox: { type: 'boolean', description: 'Песочница вместо боевого API.' },
        processing_mode: { type: 'string', enum: ['auto', 'online', 'offline'], description: 'Режим формирования отчёта, по умолчанию auto.' },
        wait_seconds: { type: 'number', description: 'Сколько секунд ждать готовности отчёта, по умолчанию 180.' },
      },
      required: ['params'],
      additionalProperties: false,
    },
  },
  {
    name: 'direct_reference',
    description:
      'Шпаргалка по API v5: список сервисов, методов, примеры params, типы отчётов, единицы ставок и лимиты. Вызывай перед первым direct_call, чтобы не гадать с полями.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

async function dispatchTool(name, args) {
  switch (name) {
    case 'direct_status': return await toolStatus();
    case 'direct_call': return await toolCall(args || {});
    case 'direct_report': return await toolReport(args || {});
    case 'direct_reference': return REFERENCE;
    default: throw new Error(`Неизвестный инструмент: ${name}`);
  }
}

/* ------------------------------------------------------------ transport --- */

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    switch (method) {
      case 'initialize':
        return send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: (params && params.protocolVersion) || '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          },
        });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return;
      case 'ping':
        return send({ jsonrpc: '2.0', id, result: {} });
      case 'tools/list':
        return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      case 'resources/list':
        return send({ jsonrpc: '2.0', id, result: { resources: [] } });
      case 'prompts/list':
        return send({ jsonrpc: '2.0', id, result: { prompts: [] } });
      case 'tools/call': {
        const text = await dispatchTool(params.name, params.arguments);
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(text) }] } });
      }
      default:
        if (isRequest) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
        return;
    }
  } catch (err) {
    if (method === 'tools/call' && isRequest) {
      return send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `Ошибка: ${err.message}` }], isError: true },
      });
    }
    if (isRequest) send({ jsonrpc: '2.0', id, error: { code: -32603, message: err.message } });
  }
}

let stdinEnded = false;
let pending = 0;

function maybeExit() {
  if (stdinEnded && pending === 0) process.exit(0);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (_) { continue; }
    pending += 1;
    Promise.resolve(handle(msg)).finally(() => {
      pending -= 1;
      maybeExit();
    });
  }
});
process.stdin.on('end', () => {
  stdinEnded = true;
  maybeExit();
});
