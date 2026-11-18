# patches/

这里是对插件源码的原地改动。**不是逆向，也不是改压缩产物** —— 插件是未打包的 ESM
源码（`.mjs`），可以直接读、直接改、直接 diff。

基线：`dsh-douyin-browser-local` **1.4.6**（`package.json` 里仍是 1.4.6，改动后没有升版本号）。
上游 1.4.7 已于 2026-11-12 发布，本项目尚未 rebase 到 1.4.7，见 [docs/patches.md](../docs/patches.md)。

## 收录范围

| 文件 | 内容 | 依据 |
|---|---|---|
| `01-chat-agent-proactive-and-frames.patch` | 主动开口分两类 + 分镜 16 帧 + 图片预算 + 记忆条目收敛 | `chat-agent.mjs.bak-20261112` |
| `02-chat-browser-timeouts.patch` | 表情面板/发送核对超时收紧，失败更快 | `chat-browser.mjs.bak-20261118` |
| `03-chat-message-fingerprint.patch` | 分享卡片指纹只算稳定身份 | `chat-message.mjs.bak-20261112` |

## 未收录（重要）

还有两个文件在 11-18 被改过，但**没有留下同名 `.bak` 基线**，无法产出可靠 diff：

- `chat-service.mjs`（139 KB，11-18 21:24）
- `memory-star.mjs`（13 KB，11-18 00:07）

如果需要完整回溯，从上游同版本取文件当基线再 diff：

```bash
git clone https://github.com/LockyBee/dsh-douyin-agent.git /tmp/upstream
diff -u --label a/chat-service.mjs --label b/chat-service.mjs \
  /tmp/upstream/chat-service.mjs "<插件目录>/chat-service.mjs" \
  > patches/04-chat-service.patch
```

## 应用方式

在插件目录里执行（`-p1` 去掉 `a/`、`b/` 前缀）：

```bash
cd ~/.dsh/profiles/desktop/node_modules/dsh-douyin-browser-local
patch -p1 < <本仓库>/patches/01-chat-agent-proactive-and-frames.patch
# 或
git apply -p1 < <本仓库>/patches/01-chat-agent-proactive-and-frames.patch
```

已验证：三个 patch 分别应用到对应 `.bak` 后，与当前线上文件**逐字节一致**
（源码为 LF 换行，`.gitattributes` 里给 `*.patch` 关掉了换行转换，保证跨机器 apply 结果不变）。

## 回滚

```bash
cp chat-agent.mjs.bak-20261112 chat-agent.mjs
```

`.bak` 比重新安装可靠 —— 重新安装会连带丢掉那两个没进 patch 的文件的改动。

## 约定

- 改源码前先备份：`cp x.mjs x.mjs.bak-$(date +%Y%m%d)`，否则下次产不出 diff。
- 改完在 `docs/patches.md` 补一条：改了什么、为什么、风险、怎么验证。
- **不要**把插件完整源码复制进本仓库，只放 diff。
