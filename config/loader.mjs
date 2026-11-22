// config/loader.mjs —— 配置层唯一入口
// 规则（见 refactor/PLAN.md 3.2/4.2）：
//   1. 返回值一律 Object.freeze（与 task-limits / video-limits 纪律一致）；
//   2. JSON 而非 YAML：零依赖，node:fs 直接读；
//   3. 文件缺失/解析失败 → 启动即抛错（fail-fast），宁可响亮崩溃也不静默换文案；
//   4. 对账阈值、风控数值不放这里（那是产品逻辑，走代码 + 测试）。
import { readFileSync } from 'node:fs';

const load = name => {
  const url = new URL(`./${name}.json`, import.meta.url);
  return Object.freeze(JSON.parse(readFileSync(url, 'utf8')));
};

export const personaConfig = () => load('persona');
export const behaviorConfig = () => load('behavior');
