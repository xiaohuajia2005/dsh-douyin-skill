// ============================================================
// 设置页路由三方一致性护栏
//
// 这条链路有三份各自维护的清单，任何一处漏登记都不会在测试里报错：
//   1. native-settings.mjs          实际处理请求（case）
//   2. native-settings-transport.mjs 通信白名单（writes）
//   3. client.js                    设置页允许发出的路由（routes）
// 漏在第 2 处时，本机走 http 前缀完全无感，只有在走 RPC 通道的宿主上
// 点下去直接 400 —— /interactions/configure 就漏过两次。
// 所以这里只做清单比对，不测功能，任何一处新增都必须同时改三处。
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

const settings = read('native-settings.mjs');
const transport = read('native-settings-transport.mjs');
const client = read('client.js');

const cases = new Set([...settings.matchAll(/case '(\/[^']+)'/g)].map(match => match[1]));
const writesBlock = /const writes = new Set\(\[([\s\S]*?)\]\);/.exec(transport);
const routesBlock = /const routes = new Set\(\[([\s\S]*?)\]\);/.exec(client);
assert.ok(writesBlock, '夹具前提：找到了通信白名单声明');
assert.ok(routesBlock, '夹具前提：找到了设置页 routes 声明');
const writes = new Set([...writesBlock[1].matchAll(/'([^']+)'/g)].map(match => match[1]));
const routes = new Set([...routesBlock[1].matchAll(/'(\/[^']+)'/g)].map(match => match[1]));

// 只读路由由 GET 分支处理，不经过 case，也不进写入白名单。
const READS = new Set(['/state', '/chat/unanswered']);
assert.ok(cases.size > 25, `夹具前提：case 数量异常（${cases.size}），正则以可能没匹配上`);
assert.ok(writes.size > 25, `夹具前提：白名单数量异常（${writes.size}）`);
assert.ok(routes.size > 30, `夹具前提：routes 数量异常（${routes.size}）`);

test('R1 每个写入处理器都在通信白名单里，否则 RPC 通道会 400', () => {
  const missing = [...cases].filter(item => !writes.has(item.slice(1))).sort();
  assert.deepEqual(missing, [], `这些路由有处理器但没登记白名单：${missing.join('、')}`);
});

test('R2 白名单里没有已经不存在的处理器', () => {
  const stale = [...writes].filter(item => !cases.has(`/${item}`)).sort();
  assert.deepEqual(stale, [], `白名单里残留了没有处理器的路由：${stale.join('、')}`);
});

test('R3 设置页可发的每个写路由都有处理器', () => {
  const missing = [...routes].filter(item => !READS.has(item) && item !== '/reports/read' && !cases.has(item)).sort();
  assert.deepEqual(missing, [], `设置页会请求但没有处理器的路由：${missing.join('、')}`);
});

test('R4 设置页实际请求的路径都在自己的 routes 集合里', () => {
  // 只扫字面量路径：'/'-拼接和模板变量由 R5 的白名单比对兜底。
  const requested = [...client.matchAll(/api\.request\(\s*[`'"]([^`'"$]+)/g)]
    .map(match => match[1].split('?')[0])
    .filter(item => item.startsWith('/') && item.length > 1);
  assert.ok(requested.length >= 10, `夹具前提：扫描到 ${requested.length} 条请求，数量偏少`);
  const missing = [...new Set(requested)]
    .filter(item => !routes.has(item) && !READS.has(item) && item !== '/reports/read')
    .sort();
  assert.deepEqual(missing, [], `设置页发出未登记的路由：${missing.join('、')}`);
});

test('R5 白名单与设置页写路由一一对应', () => {
  const onlyWrites = [...writes].filter(item => !routes.has(`/${item}`)).sort();
  const onlyRoutes = [...routes].filter(item => !READS.has(item) && item !== '/reports/read' && !writes.has(item.slice(1))).sort();
  assert.deepEqual(onlyWrites, [], `白名单有但设置页不发：${onlyWrites.join('、')}`);
  assert.deepEqual(onlyRoutes, [], `设置页发但白名单没有：${onlyRoutes.join('、')}`);
});
