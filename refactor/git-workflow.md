# Git 使用方案（替换 .bak 手工备份）

> 仓库位置：本目录（插件包根，就地版本化）
> 基线提交：`0630151` ｜ 分支：`main`

---

## 1. 为什么可以放心删 .bak

基线提交已包含**当前全部源码状态**（128 个文件）。每个 `.bak` 的内容都对应某个历史时刻的文件，
那个时刻现在等价于一条 git 提交。仓库建立后：

```bash
# 确认仓库可用、测试全绿之后（迭代 1 执行）：
rm *.bak*          # Git Bash 下执行；35 个备份一次清空
```

在那之前它们只是留在磁盘上、被 `.gitignore` 隔离的惰性文件，不碍事。

---

## 2. 日常节奏（每次改代码）

```bash
# 1) 改代码前：确认起点干净
git status

# 2) 改代码（一个关注点，别贪多）

# 3) 跑测试（对账相关改动必须全绿）
python test_cases.py

# 4) 看这次到底改了什么
git diff

# 5) 提交（备注写"为什么"，不写"改了什么"——diff 自己会说）
git add -A
git commit
```

### 提交备注规范

```
<类型>(<区域>): <一句话做了什么>

<为什么做：现象/风险/目的>
<验证方式：python test_cases.py 全绿 / 实跑一天观察>
```

类型固定五种：`feat`（新能力）`fix`（修 bug）`refactor`（拆分，不改行为）`config`（只动 config/）`test`（只动 tests/）。

好的例子：
```
fix(evidence): 分享卡片指纹只取稳定身份字段

封面 imageMd5 与 resources 异步加载，加载完成指纹即变，
被二次核对误判为"消息被改动"导致会话暂停。
验证：tests/evidence.test.mjs A3/A4
```

坏的例子（禁止）：
```
修改                # 改了什么没说，为什么更没说
更新chat-agent      # 类型没写，diff 范围不明
```

---

## 3. 回滚手册（按场景）

| 场景 | 命令 | 说明 |
|---|---|---|
| 改坏了还没提交 | `git restore <file>` | 回到上次提交的样子，改动丢弃 |
| 改了多个文件只想回退一个 | `git restore <file>` | 其他文件的改动保留 |
| 上一条提交有问题 | `git revert HEAD` | 生成一条反向提交，历史不丢（**推荐**） |
| 想整体退回 3 个提交之前 | `git reset --hard HEAD~3` | 危险：丢弃之后的全部提交，仅限未推送 |
| 只想看某个文件历史 | `git log -p <file>` | 逐提交看 diff，等于无限份 .bak |
| 两个版本对比 | `git diff <旧commit> <新commit> -- <file>` | 代替任何手工对比 |

**经验法则**：出了问题优先 `revert` 而不是 `reset`——历史里留着"错误+修复"两条记录，
比抹掉历史更安全。`reset --hard` 之前先 `git branch backup-<日期>`。

---

## 4. 隐私与备份红线

- **`state/` 永不入库**（真实私信内容、聊天水位）。`.gitignore` 已隔离；
  未来若加远程仓库，先 `git ls-files | grep state` 确认无泄漏再加。
- 远程备份（可选，迭代 1 之后再说）：

```bash
# 私有仓库！代码含核心壁垒逻辑与完整二次开发
git remote add origin <你的私有仓库URL>
git push -u origin main
```

- 离线备份替代方案（不联网也能做）：
  `git bundle create ../dsh-agent-backup-$(date +%Y%m%d).bundle --all`
  生成单文件备份，拷到移动盘即可整仓恢复。

---

## 5. .gitignore 要点（已生效）

| 规则 | 原因 |
|---|---|
| `state/` | 30MB 运行时数据 + 真实私信，隐私与体积双红线 |
| `*.bak*` | Git 时代不再需要；旧备份先留在磁盘，迭代 1 清理 |
| `*.lock` `*.log` `*.tmp` | 运行时临时物 |
| `.env*` | 密钥永不入库 |
| `node_modules/` | 防嵌套 |

每次新增数据目录时同步补规则；`git status` 出现大量未跟踪文件 = 规则漏了，先补再提交。
