// ============================================================
// 打包白名单特征测试 —— 迭代 5/6 的护栏
//
// 背景：package.json 的 `files` 是白名单。新增目录（config/ evidence/ service/）
// 或新增根模块时如果忘了登记，本机 node_modules 就地运行完全正常，
// 但 npm pack / 插件安装出来的包会缺文件，运行期才炸。这里把"漏登记"变成测试失败。
//
// 检查方式：扫描运行时会用到的路径形态，逐条确认被白名单覆盖
// （精确命中，或命中以 / 结尾的目录条目）。
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const listed = pkg.files;

const covered = path => listed.some(entry => entry.endsWith('/') ? path.startsWith(entry) : entry === path);

const runtimeFiles = () => {
  const names = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && /\.(mjs|js)$/.test(entry.name)) names.push(entry.name);
  }
  for (const dir of ['agent', 'chat', 'comment', 'config', 'evidence', 'service']) {
    for (const entry of readdirSync(new URL(`${dir}/`, root), { withFileTypes: true })) {
      if (entry.isFile()) names.push(`${dir}/${entry.name}`);
    }
  }
  return names.sort();
};

test('P1 包根与 agent/ chat/ comment/ config/ evidence/ service/ 下的运行时文件全部登记在 files 白名单', () => {
  const missing = runtimeFiles().filter(path => !covered(path));
  assert.deepEqual(missing, [], `以下文件未登记进 package.json 的 files，打包后会缺失：${missing.join(', ')}`);
});

test('P2 白名单不含开发期资产（测试与重构文档不进包）', () => {
  for (const path of ['tests/rows.test.mjs', 'refactor/PLAN.md', 'test_cases.py']) {
    assert.equal(covered(path), false, `${path} 不应进包`);
  }
});

test('P3 config 三个运行时文件必须显式可用（丢了等于插件启动即崩）', () => {
  for (const path of ['config/loader.mjs', 'config/behavior.json', 'config/persona.json']) {
    assert.equal(covered(path), true, `${path} 必须进包`);
  }
});

test('P4 证据层与投影模块必须进包，否则 chat-browser / chat-agent 导入失败', () => {
  for (const path of ['evidence/identity.mjs', 'evidence/rows.mjs', 'evidence/fingerprint.mjs', 'evidence/watermark.mjs',
    'evidence/admission.mjs', 'evidence/backlog.mjs', 'agent/projection.mjs', 'message-tracker.mjs']) {
    assert.equal(covered(path), true, `${path} 必须进包`);
  }
});

// P5 补的是 P1 的一处结构性盲区：P1 只扫它自己列出的目录。
// R1 新建 comment/ 时既没登记 files、也不在 P1 的扫描列表里，
// 结果是"本机 node_modules 就地运行完全正常、npm pack 出来的包一 import 就崩"。
// 所以这里对 comment/ 单独点名，P1 的目录列表也一并补上——两边都漏才是真漏。
test('P5 评论层模块必须进包，否则 comment-browser 导入即失败', () => {
  for (const path of ['comment/scope.mjs', 'comment/lock-policy.mjs', 'comment/timing.mjs', 'comment/receipts.mjs']) {
    assert.equal(covered(path), true, `${path} 必须进包`);
  }
});

// P6 是 P5 的同款盲区：chat/ 是第二阶段新建的目录，同样要「白名单 + 点名」双登记。
test('P6 私信层模块必须进包，否则 chat-service 导入即失败', () => {
  for (const path of ['chat/composer-guard.mjs']) {
    assert.equal(covered(path), true, `${path} 必须进包`);
  }
});
