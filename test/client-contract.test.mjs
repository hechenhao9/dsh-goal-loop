// 客户端 bundle 的安全约束：这些断言来自两次真实启动事故，不要放宽。
//
// 事故 1（1.3.0，`pending`）：
//   dsh.client.inject 写了两个内置包名当服务名 → boot 一直等，等不到
//   → `web boot: 1 entry did not activate` → dsh-goal-loop: pending → DSH 打不开
//
// 事故 2（1.3.1，`loading`）：
//   inject 清空后调 ctx.slots.inject('conversation.input.dock', …)，外部 bundle
//   没声明该槽所属服务，槽不出现 → Promise 永不 resolve → entry 卡 loading → 同样起不来
//
// 现行方案（1.4.0）：照抄本机已跑通的 dsh-sidebar-fold —— 纯 DOM，inject 为空，
// 不碰 ctx.slots / ctx.remote，整个 apply 包 try/catch。最坏结果是「按钮不出现」。
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

test('manifest：dsh.client.inject 必须缺席或为空（否则 boot 会 pending）', () => {
  const inject = pkg.dsh?.client?.inject;
  const empty = inject === undefined || (Array.isArray(inject) && inject.length === 0);
  assert.ok(
    empty,
    `外部 bundle 等不到内置服务名，会卡在 "web boot: 1 entry did not activate"。当前值：${JSON.stringify(inject)}`,
  );
});

test('client.js：模块级 inject 是空数组', () => {
  const match = clientSource.match(/const\s+inject\s*=\s*\[([^\]]*)\]/);
  assert.ok(match, 'client.js 里找不到 `const inject = [...]`');
  assert.equal(match[1].trim(), '', `client.js 的 inject 必须为空数组，当前：[${match[1]}]`);
});

test('client.js：不碰 ctx.slots / ctx.remote（这是 loading 事故的根因）', () => {
  assert.ok(
    !/ctx\.slots/.test(clientCode),
    'client.js 不得使用 ctx.slots：外部 bundle 注册槽会让 boot 卡在 loading',
  );
  assert.ok(
    !/ctx\.remote/.test(clientCode),
    'client.js 不得使用 ctx.remote：不声明 inject 时它不可用，声明 inject 又会 pending',
  );
});

test('client.js：require 只能是惰性、且只对本仓库已知的包', () => {
  const requires = [...clientSource.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
  const allowed = new Set(['@deepseek-ai/dsh-api-remotes']);
  for (const name of requires) {
    assert.ok(allowed.has(name), `client.js 里出现了未预期的 require：${name}`);
  }
  // 惰性：require 只能出现在 lazyCommands 里，不能出现在 apply 顶层
  const applyBody = clientSource.slice(clientSource.indexOf('function apply('));
  assert.ok(
    !/require\(/.test(applyBody),
    'apply 里不得同步 require：解析失败会直接让 entry 失败',
  );
});

test('client.js：apply 整体包了 try/catch，且导出形态正确', () => {
  assert.ok(/function apply\(ctx\)\s*\{\s*try/.test(clientSource), 'apply 应该以 try 开头');
  assert.ok(
    /module\.exports\s*=\s*\{\s*name:\s*'dsh-goal-loop',\s*apply,\s*inject\s*\}/.test(clientSource),
    '导出必须是 { name, apply, inject }',
  );
});

test('manifest：宿主侧入口不受影响', () => {
  assert.equal(pkg.exports?.['.'], './index.mjs');
  assert.equal(typeof pkg.dsh?.bundle?.patch, 'string');
});
