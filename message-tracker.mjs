// 门面（迭代 6）：实现已搬到 evidence/identity.mjs，这里只做 re-export。
//
// 为什么保留这个文件而不改调用方：
//   1. 全部 import 带 `?v=` 缓存戳，改调用方路径就是一批可避免的回归面；
//   2. 回滚只需要把这一行改回去，调用方零改动；
//   3. 证据层的依赖方向必须单向：evidence 不 import 任何上层，门面在上层这边。
export { MessageIdentityTracker } from './evidence/identity.mjs';
