/**
 * 客户端 bundle 的启动安全性——这是 1.3.0 / 1.3.1 让整个 DSH 打不开之后加的护栏。
 *
 * 判据不是「我觉得没问题」，而是 DSH 自己的判据：
 *   web-frontend 里 `hw[i.fiber.state] !== "active"` 就抛
 *   `web boot: N entry did not activate`。
 *   lo = { PENDING:0, LOADING:1, ACTIVE:2, FAILED:3, DISPOSED:4, UNLOADING:5 }
 *
 * 所以这里用**真实 cordis**（从本机 DSH 安装里找）把 client.js 加载一遍，
 * 断言 fiber.state === 2。
 *
 * 两次事故的原因都记在下面，改这个文件之前先读：
 *   - inject 里写服务名而服务不存在 → state 0 pending
 *   - apply 返回 Promise（例如 await 了槽注册）→ state 1 loading
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
const skip = cordisEntry === null
  ? '本机找不到 @deepseek-ai/cordis（用 DSH_CORDIS_DIR 指过去才能跑这条）'
  : false;

class FakeEl {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.attrs = {};
    this.textContent = '';
    this.offsetParent = { fake: true };
  }
  set className(v) { this._cls = v; }
  get className() { return this._cls ?? ''; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  append(...nodes) { for (const n of nodes) this.appendChild(n); }
  appendChild(n) { n.parentElement = this; this.children.push(n); return n; }
  remove() {
    if (this.parentElement === null) return;
    this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
  }
  addEventListener() {}
  closest(sel) {
    const idMatch = /^\[id="(.+)"\]$/.exec(String(sel));
    if (idMatch !== null) {
      let node = this;
      while (node !== null && node !== undefined) {
        if (node.id === idMatch[1]) return node;
        node = node.parentElement;
      }
      return null;
    }
    return this;
  }
  contains(other) {
    if (other === this) return true;
    return this.children.some((c) => c.contains?.(other));
  }
  querySelectorAll(sel) {
    const raw = String(sel);
    const out = [];
    const want = raw.toUpperCase();
    const classSel = raw.startsWith('.') ? raw.slice(1) : null;
    const walk = (node) => {
      for (const c of node.children) {
        if (classSel !== null) {
          if (String(c.className ?? '').split(/\s+/).includes(classSel)) out.push(c);
        } else if (c.tagName === want) {
          out.push(c);
        }
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}

function makeDom({ withComposer }) {
  const html = new FakeEl('html');
  const head = new FakeEl('head');
  const body = new FakeEl('body');
  html.append(head, body);

  const row = new FakeEl('div');
  row.append(new FakeEl('button'), new FakeEl('button'));

  const composer = new FakeEl('textarea');
  composer.setAttribute('placeholder', '发消息或创建任务，/调用指令，@ 文件或对话');
  if (withComposer) {
    const col = new FakeEl('div');
    col.append(composer, row);
    body.appendChild(col);
  }

  const documentListeners = new Map();
  const document = {
    head,
    body,
    listeners: documentListeners,
    addEventListener(type, fn, capture) {
      const list = documentListeners.get(type) ?? [];
      list.push({ fn, capture: capture === true });
      documentListeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = documentListeners.get(type) ?? [];
      documentListeners.set(type, list.filter((item) => item.fn !== fn));
    },
    execCommand() { return false; },
    getElementById(id) {
      const walk = (node) => {
        if (node.id === id) return node;
        for (const c of node.children) {
          const hit = walk(c);
          if (hit !== null) return hit;
        }
        return null;
      };
      return walk(html);
    },
    createElement(tag) { return new FakeEl(tag); },
    querySelector(sel) { return html.querySelector(sel); },
    querySelectorAll(sel) {
      if (String(sel).includes('textarea')) return withComposer ? [composer] : [];
      return html.querySelectorAll(sel);
    },
  };
  return { document, body, row, composer, html };
}

const quiet = { info() {}, warn() {}, log() {}, error() {} };

function loadClient(dom) {
  const code = readFileSync(clientPath, 'utf8');
  let captured = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => { captured = def; } } },
    document: dom.document,
    location: { pathname: '/', hash: '' },
    console: quiet,
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    setTimeout,
    HTMLTextAreaElement: class {},
    Event: class { constructor(type) { this.type = type; } },
    KeyboardEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox, { filename: 'lib/client.js' });
  assert.ok(captured !== null, 'client.js 应当调用 window.__ModuleLoader__.load');
  const mod = captured.factory(() => { throw new Error('unexpected require'); });
  return { def: captured, mod };
}

test('client.js：模块级 inject 为空（否则 boot 会 pending）', () => {
  const { mod } = loadClient(makeDom({ withComposer: false }));
  // 跨 vm realm 的数组原型不同，deepEqual 会误报，只能查形状。
  assert.ok(Array.isArray(mod.inject), 'inject 必须是数组');
  assert.equal(mod.inject.length, 0, 'inject 必须为空，否则 boot 会等不存在的服务');
  assert.equal(mod.name, 'dsh-goal-loop');
  assert.equal(typeof mod.apply, 'function');
});

test('client.js：apply 同步返回 cleanup 函数，不是 Promise（否则 boot 会 loading）', () => {
  const { mod } = loadClient(makeDom({ withComposer: false }));
  const ret = mod.apply({ logger: quiet });
  assert.equal(typeof ret, 'function', 'apply 必须返回 dispose 函数');
  assert.ok(!(ret && typeof ret.then === 'function'), 'apply 不得返回 Promise');
});

test('client.js：页面上没有输入框时 apply 也不抛', () => {
  const { mod } = loadClient(makeDom({ withComposer: false }));
  assert.doesNotThrow(() => mod.apply({ logger: quiet }));
  assert.doesNotThrow(() => mod.apply(undefined));
});

test('client.js：在真实 cordis 里 fiber.state 必须是 ACTIVE(2)', { skip }, async () => {
  const cordis = await import(pathToFileURL(cordisEntry).href);
  const Context = cordis.Context ?? cordis.default;

  for (const withComposer of [false, true]) {
    const { mod } = loadClient(makeDom({ withComposer }));
    const ctx = new Context();
    const fiber = ctx.plugin(mod);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      fiber.state,
      2,
      `fiber.state 应当是 2=active，实际 ${fiber.state}` +
        '（0=pending 等 inject 服务，1=loading apply 没同步结束）',
    );
  }
});

test('client.js：输入框和按钮行都在时，按钮真的挂到了那一行', { skip }, async () => {
  const dom = makeDom({ withComposer: true });
  const { mod } = loadClient(dom);
  mod.apply({ logger: quiet });
  const ids = dom.row.children.map((c) => c.id).filter(Boolean);
  assert.ok(ids.includes('dsh-goal-loop/mode-chip'), '按钮应挂在按钮行里，实际 children=' + JSON.stringify(ids));
});

test('client.js：点击走 document 捕获阶段委托（React 重建按钮也不丢监听）', { skip }, async () => {
  const dom = makeDom({ withComposer: true });
  const { mod } = loadClient(dom);
  mod.apply({ logger: quiet });
  const clicks = (dom.document.listeners.get('click') ?? []).filter((l) => l.capture);
  assert.equal(clicks.length, 1, '应当只在 document 捕获阶段注册一个 click 监听');
});

test('client.js：点一下必须有可见反馈（以前 B 路成功也不改文案，看着像没反应）', { skip }, async () => {
  const dom = makeDom({ withComposer: true });
  const { mod } = loadClient(dom);
  mod.apply({ logger: quiet });

  const button = dom.row.children.find((c) => c.id === 'dsh-goal-loop/mode-chip');
  assert.ok(button !== undefined, '按钮应当已挂上');
  const labelOf = () => button.querySelector('.dshgl-label')?.textContent ?? '';
  const before = labelOf();
  assert.equal(before, '目标工程 · 关');

  const clicks = (dom.document.listeners.get('click') ?? []).filter((l) => l.capture);
  let prevented = false;
  clicks[0].fn({
    target: button,
    preventDefault() { prevented = true; },
    stopPropagation() {},
  });
  assert.ok(prevented, '点击应当被 preventDefault');

  await new Promise((resolve) => setTimeout(resolve, 30));
  const after = labelOf();
  assert.notEqual(after, before, '点击后文案必须变化：' + JSON.stringify(after));
});
