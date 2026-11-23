// 客户端 bundle 的安全约束：这些断言来自三次真实启动事故，不要放宽。
//
// 事故 1（1.3.0，`pending`）：
//   dsh.client.inject 写了两个**包名**当服务名 → cordis 等一个不存在的服务
//   → `web boot: 1 entry did not activate` → dsh-goal-loop: pending → DSH 打不开
//
// 事故 2（1.3.1，`loading`）：
//   inject 清空后调 ctx.slots.inject('conversation.input.dock', …)，外部 bundle
//   没声明该槽所属服务，槽不出现 → Promise 永不 resolve → entry 卡 loading → 同样起不来
//
// 事故 3（1.4.x，DOM 版能启动但按钮不出现 / 点击无效）：
//   纯 DOM 找输入框靠猜选择器，DSH 一改版就失准
//
// 现行方案（1.6.0）：照抄本机已跑通的 `dsh-windows-mcp` pill ——
//   inject = ["slots"]（唯一确定存在的服务）、槽用 `conversation.input.left`、
//   状态走自家 HTTP 路由（GET/POST `/dsh-goal-loop/state`）、不碰 ctx.remote。
// 下面这些断言就是为了让这条边界不被下次改坏。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const clientSource = readFileSync(path.join(root, 'lib', 'client.js'), 'utf8');
/** 只检查代码，不检查注释：注释里会正当地提到 ctx.slots / ctx.remote 这些词。 */
const clientCode = clientSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('manifest：客户端入口存在且是字符串', () => {
  const entry = pkg.exports?.['./client'];
  assert.equal(typeof entry, 'string', 'exports["./client"] 必须是字符串');
  assert.ok(existsSync(path.join(root, entry)), `客户端入口文件不存在：${entry}`);
});

test('manifest：dsh.client.platform 是 web', () => {
  assert.equal(pkg.dsh?.client?.platform, 'web');
});

test('manifest：dsh.client 只写 platform，不写 inject（两个 inject 不是一回事）', () => {
  // package.json 的 dsh.client.inject 是**模块依赖清单**（包名，dsh-client-modules 的
  // graphRow 用它排加载顺序）；client.js 里的 `var inject = [...]` 才是 **cordis 服务依赖**。
  // 本插件在 factory 里只 require 了 react（静态表提供），没有任何外部客户端模块依赖，
  // 所以这里不该出现 inject。已跑通的 dsh-sidebar-fold 就是 `{platform:"web"}`。
  assert.equal(pkg.dsh?.client?.inject, undefined, `dsh.client 不该带 inject，当前：${JSON.stringify(pkg.dsh?.client?.inject)}`);
  assert.deepEqual(Object.keys(pkg.dsh.client), ['platform'], 'dsh.client 只该有 platform');
});

test('client.js：模块级 inject 是 ["slots"]', () => {
  const match = clientSource.match(/var\s+inject\s*=\s*\[([^\]]*)\]/);
  assert.ok(match, 'client.js 里找不到 `var inject = [...]`');
  const names = match[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  assert.deepEqual(names, ['slots'], `client.js 的 inject 只能有 slots，当前：[${match[1]}]`);
});

test('client.js：槽名必须是 conversation.input.left', () => {
  assert.ok(
    /SLOT_NAME\s*=\s*['"]conversation\.input\.left['"]/.test(clientSource),
    '槽名必须是 conversation.input.left（dsh-windows-mcp 已验证的那个座位）',
  );
});

test('client.js：ctx.remote 只做兜底，且必须在 try/catch 里惰性取', () => {
  // 主路永远是自家 /state 路由；命令通道只在路由不通时兜底。
  // 它绝不能进模块级 inject（那会让 fiber 等一个没人声明的服务，1.3.0 就是这么崩的）。
  const at = clientSource.indexOf('function makeRunCommand(');
  assert.ok(at > 0, '找不到 makeRunCommand：命令兜底必须收在一个函数里');
  const body = clientSource.slice(at, clientSource.indexOf('\n    }', at));
  assert.ok(/ctx\s*&&\s*ctx\.remote/.test(body), '取 ctx.remote 必须防 undefined');
  assert.ok(/try\s*\{/.test(body), '取 ctx.remote 必须包 try：服务缺席时要安静降级');
  assert.ok(
    /typeof commands\.execute !== ['"]function['"]/.test(body),
    '必须先确认 commands.execute 是函数再调用',
  );
  assert.ok(!/inject[^\n]*remote/.test(clientSource), 'ctx.remote 的包名不许写进 inject');
});

test('client.js：ctx.slots 只出现在 apply 里，且 apply 包了 try/catch', () => {
  const applyAt = clientSource.indexOf('function apply(');
  assert.ok(applyAt > 0, '找不到 function apply(');
  const before = clientSource.slice(0, applyAt);
  assert.ok(
    !/ctx\.slots/.test(before),
    'ctx.slots 不能出现在 apply 之外（模块加载期执行会让 entry 直接失败）',
  );
  assert.ok(/function apply\(ctx\)\s*\{\s*try/.test(clientSource), 'apply 应该以 try 开头');
});

test('client.js：require 只有 react', () => {
  const requires = [...clientSource.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  const allowed = new Set(['react']);
  for (const name of requires) {
    assert.ok(allowed.has(name), `client.js 里出现了未预期的 require：${name}`);
  }
});

test('client.js：导出形态正确', () => {
  assert.ok(
    /module\.exports\s*=\s*\{\s*name:\s*PACKAGE_ID,\s*apply:\s*apply,\s*inject:\s*inject\s*\}/.test(clientSource),
    '导出必须是 { name, apply, inject }',
  );
});

test('client.js：状态路由是自家路径，不借用别人的', () => {
  assert.ok(
    /STATE_PATH\s*=\s*['"]\/dsh-goal-loop\/state['"]/.test(clientSource),
    'STATE_PATH 必须是 /dsh-goal-loop/state',
  );
});

test('manifest：宿主侧入口不受影响', () => {
  assert.equal(pkg.exports?.['.'], './index.mjs');
  assert.equal(typeof pkg.dsh?.bundle?.patch, 'string');
});
