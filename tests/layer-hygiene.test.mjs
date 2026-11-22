// ============================================================
// 分层卫生特征测试 —— 迭代 7
//
// 三条纪律，写测试比写文档更难被绕过：
//   L1 新层一律 LF：仓库 core.autocrlf=false，任何 CRLF 写入都会让 diff 变成"整文件重写"；
//   L2 新层不得有模块级可变状态（PLAN 3.2：let/var 命中数须为 0）；
//   L3 evidence 层零上层依赖：只允许 node: 内置与同层 ./ 相对导入。
//      "不 import 上层"是它能被离线全量测试的原因，也是壁垒的一部分。
//
// 只扫我们自己的层：包根还有上游 CRLF 文件，不属于本次治理范围，不碰。
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const layers = ['agent', 'evidence', 'service', 'config', 'tests', 'refactor'];

const layerFiles = () => {
  const out = [];
  for (const dir of layers) {
    for (const entry of readdirSync(new URL(`${dir}/`, root), { withFileTypes: true })) {
      if (entry.isFile() && /\.(mjs|json|md)$/.test(entry.name)) out.push(`${dir}/${entry.name}`);
    }
  }
  return out.sort();
};

const read = path => readFileSync(new URL(path, root), 'utf8');

test('L1 新层源码与配置一律 LF（无 CR）', () => {
  const offenders = layerFiles().filter(path => read(path).includes('\r'));
  assert.deepEqual(offenders, [], `以下文件含 CRLF/CR，会污染 diff：${offenders.join(', ')}`);
});

test('L2 新层没有模块级可变状态（let / var 顶层声明须为 0）', () => {
  const offenders = layerFiles().filter(path => path.endsWith('.mjs'))
    .filter(path => read(path).split('\n').some(line => /^(let|var)\s/.test(line)));
  assert.deepEqual(offenders, [], `以下文件有模块级 let/var：${offenders.join(', ')}`);
});

test('L3 evidence 层只依赖 node 内置与同层模块（不得 import 上层）', () => {
  const sources = readdirSync(new URL('evidence/', root), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.mjs'));
  const violations = [];
  for (const entry of sources) {
    const text = read(`evidence/${entry.name}`);
    for (const match of text.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gms)) {
      const spec = match[1];
      const legal = spec.startsWith('node:') || /^\.\/[^/]+$/.test(spec);
      if (!legal) violations.push(`evidence/${entry.name} → ${spec}`);
    }
  }
  assert.deepEqual(violations, [], `evidence 层出现向上/跨层依赖：${violations.join('; ')}`);
});

test('L4 门面文件本身不再承载大段实现（行数守住，防"搬了又搬回来"）', () => {
  // 门面的价值就在于薄：一旦有人把逻辑写回门面，分层立刻退化。
  const facades = { 'message-tracker.mjs': 12, 'chat-message.mjs': 26, 'contact-authorization.mjs': 18 };
  for (const [path, limit] of Object.entries(facades)) {
    const lines = read(path).split('\n').length;
    assert.ok(lines <= limit, `${path} 已 ${lines} 行，超过门面阈值 ${limit} 行`);
  }
});
