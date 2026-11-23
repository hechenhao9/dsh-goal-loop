/**
 * 宿主侧状态路由：输入框那个 pill 真的能读、能写。
 *
 * 这条路由是 1.6.0 的关键——它不走命令系统，所以即使 `/goal-mode` 在前端
 * catalog 里没刷新出来，开关照样能用。测的是契约本身（方法、状态码、返回体、
 * 内存开关的副作用），不是「我觉得应该能跑」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply } from '../index.mjs';

const ROUTE = '/dsh-goal-loop/state';

/** 装一次 apply，返回注册到的 routes 与工具表。 */
function boot(dir) {
  const routes = new Map();
  const services = {
    tools: { register: () => {} },
    skills: { register: () => {} },
    commands: { register: () => {} },
    systemPrompt: { section: () => () => {}, getSectionOrder: () => 10 },
    webServer: {
      register: ({ kind, path: p, handler }) => {
        routes.set(`${kind} ${p}`, handler);
      },
    },
  };
  const ctx = {
    inject: (_names, cb) => cb({ get: (k) => services[k], ...services }),
    get: (k) => services[k],
    logger: { warn: () => {} },
  };
  apply(ctx, {});
  return routes;
}

function request(method, body) {
  const req = new EventEmitter();
  req.method = method;
  req.destroy = () => {};
  setImmediate(() => {
    if (typeof body === 'string') req.emit('data', Buffer.from(body, 'utf8'));
    req.emit('end');
  });
  return req;
}

function response() {
  const res = {
    status: 0,
    headers: {},
    payload: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
    },
    end(payload) {
      this.payload = payload ?? '';
    },
  };
  return res;
}

const dir = mkdtempSync(path.join(os.tmpdir(), 'goal-loop-route-'));
// 让 setMode 落到临时目录，不污染仓库
process.chdir(dir);

test('路由注册在 /dsh-goal-loop/state（exact）', () => {
  const routes = boot(dir);
  assert.ok(routes.has(`exact ${ROUTE}`), `实际注册：${[...routes.keys()].join(', ')}`);
});

test('GET 返回宿主真实开关', async () => {
  const routes = boot(dir);
  const handler = routes.get(`exact ${ROUTE}`);
  const res = response();
  handler(request('GET'), res);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  const body = JSON.parse(res.payload);
  assert.equal(typeof body.enabled, 'boolean');
  assert.equal(body.route, ROUTE);
});

test('POST {enabled:false} 真的把开关关掉（再 GET 能读回）', async () => {
  const routes = boot(dir);
  const handler = routes.get(`exact ${ROUTE}`);

  const off = response();
  handler(request('POST', JSON.stringify({ enabled: false })), off);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(off.status, 200);
  assert.equal(JSON.parse(off.payload).enabled, false);

  const read = response();
  handler(request('GET'), read);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(JSON.parse(read.payload).enabled, false);

  const on = response();
  handler(request('POST', JSON.stringify({ enabled: true })), on);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(JSON.parse(on.payload).enabled, true);
});

test('POST 非法 body → 400，不给假成功', async () => {
  const routes = boot(dir);
  const handler = routes.get(`exact ${ROUTE}`);

  const bad = response();
  handler(request('POST', 'not json'), bad);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(bad.status, 400);

  const wrong = response();
  handler(request('POST', JSON.stringify({ enabled: 'yes' })), wrong);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(wrong.status, 400);
});

test('其它方法 → 405', async () => {
  const routes = boot(dir);
  const handler = routes.get(`exact ${ROUTE}`);
  const res = response();
  handler(request('PUT'), res);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(res.status, 405);
});

test('没有 webServer 服务时 apply 不抛（最坏是 pill 连不上）', () => {
  assert.doesNotThrow(() => {
    apply(
      {
        inject: (_n, cb) => cb({ get: () => ({ register: () => {}, section: () => () => {} }) }),
        get: () => ({}),
        logger: { warn: () => {} },
      },
      {},
    );
  });
});
