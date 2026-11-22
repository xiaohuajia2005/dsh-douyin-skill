// 开源红线守卫：仓库里不允许出现本机绝对路径、凭据、运行时数据。
// 这条测试的意义不在于"现在干净"，而在于"以后不会有人顺手把路径写回去"——
// 2026-11-22 推送 GitHub 前，meme-wiki.mjs 里就有过一行写死的 C:/Users/<name>/... 。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP_DIRS = new Set(['node_modules', '.git', 'state', 'memory', 'control', 'coverage']);
const SOURCE_EXT = /\.(?:mjs|cjs|js|json|py|yml|yaml|txt|md)$/;
const SELF = relative(ROOT, fileURLToPath(import.meta.url));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name), info = statSync(full);
    if (info.isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(name)) out.push(full);
  }
  return out;
}

const files = walk(ROOT).filter(file => relative(ROOT, file) !== SELF);

// 每种模式都只匹配"像本机绝对路径"的形态，不匹配文档里的相对路径或占位符。
const FORBIDDEN = [
  { name: 'Windows 用户目录绝对路径', pattern: /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}[^\\/\s'"]+/ },
  { name: 'macOS 用户目录绝对路径', pattern: /[\\/]Users[\\/][A-Za-z0-9._-]+[\\/](?:Desktop|Documents|Downloads|Library|\.dsh)/ },
  { name: 'Linux 家目录绝对路径', pattern: /[\\/]home[\\/][A-Za-z0-9._-]+[\\/]/ },
  { name: '明文 API Key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'GitHub Token', pattern: /\bghp_[A-Za-z0-9]{20,}/ },
  { name: 'AWS Access Key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
];

test('G1 源码与配置里不存在本机绝对路径与明文凭据', () => {
  const hits = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const { name, pattern } of FORBIDDEN) {
      const match = text.match(pattern);
      if (match) hits.push(`${relative(ROOT, file)}: ${name} → ${match[0].slice(0, 60)}`);
    }
  }
  assert.deepEqual(hits, [], `发现疑似隐私泄露：\n${hits.join('\n')}`);
});

test('G2 运行时数据目录与数据库后缀都在 .gitignore 里', () => {
  const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  for (const rule of ['node_modules/', 'state/', 'memory/', 'control/', '*.log', '*.sqlite', '*.db', '*.bak*', '.env']) {
    assert.ok(ignore.includes(rule), `.gitignore 缺少 ${rule}`);
  }
});

test('G3 运行时数据目录没有被 git 跟踪', () => {
  let listing = '';
  try { listing = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }); }
  catch { return; } // 无 git 环境（如 npm 包解压后）跳过
  const tracked = listing.split('\n').filter(Boolean).map(path => path.split(sep).join('/'));
  const bad = tracked.filter(path => /^(?:state|memory|control)\//.test(path) || /\.(?:sqlite|db|jsonl)$/.test(path) || /\.log$/.test(path));
  assert.deepEqual(bad, [], `这些运行时文件被跟踪了：\n${bad.join('\n')}`);
});

test('G4 梗库默认路径不在源码里写死（回归：C:/Users/<name>/... 那行）', () => {
  const source = readFileSync(join(ROOT, 'meme-wiki.mjs'), 'utf8');
  assert.equal(/const DEFAULT_DB\s*=\s*'/.test(source), false, 'DEFAULT_DB 不应是字符串字面量');
  assert.ok(source.includes('DSH_MEMEWIKI_DB'), '应支持环境变量覆盖词库路径');
  assert.ok(/resolveMemeDb\(\)/.test(source), '应通过解析函数得到词库路径');
});
