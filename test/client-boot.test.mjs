/**
 * 客户端 bundle 的启动安全性——1.3.0 / 1.3.1 让整个 DSH 打不开之后加的护栏。
 *
 * 判据不是「我觉得没问题」，而是 DSH 自己的判据：
 *   web-frontend 里 `hw[i.fiber.state] !== "active"` 就抛
 *   `web boot: N entry did not activate`。
 *   lo = { PENDING:0, LOADING:1, ACTIVE:2, FAILED:3, DISPOSED:4, UNLOADING:5 }
 *
 * 所以这里用**真实 cordis**（从本机 DSH 安装里找）把 client.js 加载一遍。
 * 1.6.0 的契约抄自本机已跑通的 dsh-windows-mcp：inject 只写 `slots`，
 * 槽用 `conversation.input.left`，状态走自家 HTTP 路由。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const clientPath = path.join(root, '..', 'lib', 'client.js');

const CORDIS_CANDIDATES = [
  process.env.DSH_CORDIS_DIR,
  'C:/Users/heche/新建文件夹/resources/app/dsh/node_modules/@deepseek-ai/cordis',
  path.join(process.cwd(), 'node_modules', '@deepseek-ai', 'cordis'),
].filter(Boolean);

function findCordis() {
  for (const dir of CORDIS_CANDIDATES) {
    const entry = path.join(dir, 'lib', 'index.js');
    if (existsSync(entry)) return entry;
    const pkgFile = path.join(dir, 'package.json');
    if (existsSync(pkgFile)) return dir;
  }
  return null;
}

const cordisEntry = findCordis();
const skip = cordisEntry === null ? '本机找不到 @deepseek-ai/cordis（用 DSH_CORDIS_DIR 指过去）' : false;

const quiet = { info() {}, warn() {}, log() {}, error() {} };

/** 够组件渲染用的最小 React：createElement 只搭树，hooks 返回稳定值。 */
function fakeReact() {
  const el = (type, props, ...children) => ({ type, props: props ?? {}, children });
  return {
    createElement: el,
    useState: (initial) => [initial, () => {}],
    useRef: (initial) => ({ current: initial }),
    useEffect: () => {},
    useCallback: (fn) => fn,
  };
}

function makeSandbox() {
  const React = fakeReact();
  const head = { children: [], appendChild(n) { this.children.push(n); } };
  const document = {
    baseURI: 'http://127.0.0.1:1/',
    head,
    documentElement: head,
    getElementById: () => null,
    createElement: (tag) => ({ tagName: String(tag).toUpperCase(), id: '', textContent: '' }),
  };
  let captured = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => { captured = def; } } },
    document,
    location: { pathname: '/', hash: '' },
    console: quiet,
    URL,
    fetch: () => Promise.reject(new Error('no network in test')),
    setTimeout,
    clearInterval: () => {},
  };
  sandbox.globalThis = sandbox;
  const code = readFileSync(clientPath, 'utf8');
  vm.runInNewContext(code, sandbox, { filename: 'lib/client.js' });
  assert.ok(captured !== null, 'client.js 应当调用 window.__ModuleLoader__.load');
  const mod = captured.factory((name) => {
    if (name === 'react') return React;
    throw new Error('unexpected require: ' + name);
  });
  return { mod, def: captured };
}

test('client.js：模块级 inject 只有 slots（写包名会让 boot pending）', () => {
  const { mod } = makeSandbox();
  // 跨 vm realm 的数组原型不同，deepEqual 会误报，只能转成普通字符串再比。
  assert.ok(Array.isArray(mod.inject), 'inject 必须是数组');
  assert.deepEqual(Array.from(mod.inject), ['slots']);
  assert.equal(mod.name, 'dsh-goal-loop');
  assert.equal(typeof mod.apply, 'function');
});

test('client.js：apply 同步返回 cleanup，不是 Promise（否则 boot 会 loading）', () => {
  const { mod } = makeSandbox();
  const ret = mod.apply({ logger: quiet });
  assert.equal(typeof ret, 'function', 'apply 必须返回 dispose 函数');
  assert.ok(!(ret && typeof ret.then === 'function'), 'apply 不得返回 Promise');
});

test('client.js：ctx 什么都没有时 apply 也不抛', () => {
  const { mod } = makeSandbox();
  assert.doesNotThrow(() => mod.apply({ logger: quiet }));
  assert.doesNotThrow(() => mod.apply(undefined));
  assert.doesNotThrow(() => mod.apply({ slots: {} }));
});

test('client.js：注册到 conversation.input.left，参数带 name/id/order/label', () => {
  const { mod } = makeSandbox();
  const calls = [];
  const ctx = {
    slots: {
      inject(name, factory) {
        calls.push({ kind: 'inject', name });
        factory();
      },
      register(options, Component) {
        calls.push({ kind: 'register', options, Component });
        return () => {};
      },
    },
  };
  mod.apply(ctx);
  const injectCall = calls.find((c) => c.kind === 'inject');
  assert.ok(injectCall !== undefined, '应当调用 ctx.slots.inject');
  assert.equal(injectCall.name, 'conversation.input.left');

  const reg = calls.find((c) => c.kind === 'register');
  assert.ok(reg !== undefined, '应当调用 ctx.slots.register');
  assert.equal(reg.options.name, 'conversation.input.left');
  assert.equal(reg.options.id, 'goal-loop-mode');
  assert.equal(reg.options.order, 26);
  assert.equal(typeof reg.options.label, 'function');
  assert.equal(typeof reg.Component, 'function');
});

test('client.js：pill 结构是 role=switch + 状态点 + 文案', () => {
  const { mod } = makeSandbox();
  let Component = null;
  mod.apply({
    slots: {
      inject: (_name, factory) => factory(),
      register: (_options, C) => { Component = C; return () => {}; },
    },
  });
  assert.ok(Component !== null, 'slot component 应当被注册');
  let tree = Component({ sessionId: 's1' });
  // 槽组件只是包了一层，真渲染的是它返回的函数组件：展开到 DOM 元素为止。
  let guard = 0;
  while (tree && typeof tree.type === 'function' && guard < 5) {
    tree = tree.type(tree.props ?? {});
    guard += 1;
  }
  assert.equal(tree.type, 'button', 'pill 应当是 button');
  assert.equal(tree.props.role, 'switch');
  assert.equal(tree.props['aria-checked'], false);
  assert.equal(tree.props['data-state'], 'off', '初始（加载中/关）应当是 off 或 warn');
  const kinds = tree.children.map((c) => c && c.props && c.props.className).filter(Boolean);
  assert.ok(kinds.includes('dgl-dot'), '必须有状态点');
  assert.ok(kinds.includes('dgl-icon'), '必须有图标');
  assert.ok(kinds.includes('dgl-label'), '必须有文案');
});

test('client.js：真实 cordis + 提供 slots 服务 → fiber 必须 ACTIVE(2)', { skip }, async () => {
  const cordis = await import(pathToFileURL(cordisEntry).href);
  const Context = cordis.Context ?? cordis.default;

  const { mod } = makeSandbox();
  const ctx = new Context();
  ctx.provide('slots');
  Object.defineProperty(ctx, 'slots', {
    value: {
      inject: (_name, factory) => factory(),
      register: () => () => {},
    },
    configurable: true,
  });
  const fiber = ctx.plugin(mod);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(
    fiber.state,
    2,
    `fiber.state 应当是 2=active，实际 ${fiber.state}` + '（0=pending 等 inject 服务，1=loading apply 没同步结束）',
  );
});

test('client.js：真实 cordis 不提供 slots → 如实是 pending（证明只该注入确定存在的服务）', { skip }, async () => {
  const cordis = await import(pathToFileURL(cordisEntry).href);
  const Context = cordis.Context ?? cordis.default;

  const { mod } = makeSandbox();
  const ctx = new Context();
  const fiber = ctx.plugin(mod);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(fiber.state, 0, '不提供 slots 时应当停在 pending(0)：这正是 1.3.0 的失败形态');
});
