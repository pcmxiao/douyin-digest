# douyin-digest

> 抖音精选：自动搜索、读文案和评论、挑出**真正值得看**的，分享到你的私信。
> 零依赖，只要 Node 22+ 和一个浏览器。

```bash
npx douyin-digest login                                    # 扫码登录一次
npx douyin-digest digest --kw "DeepSeek" --read 3 --share   # 搜、读、挑、分享
```

---

> ## ⚠️ 使用前必读
>
> **本项目仅供学习与技术研究，禁止商业用途。**
>
> - 会操作抖音网页端，**请遵守[抖音用户服务协议](https://www.douyin.com/falcon/douyin_agreement/user_agreement.html)及相关法律法规**
> - **建议用小号**。自动化操作可能被平台检测，**可能导致账号限流或封禁，风险自负**
> - 禁止用于刷量、引流、骚扰、诈骗、传播虚假信息等任何违规违法用途
> - 本项目不收集、不上传任何数据；所有数据存在本机 `~/.douyin-digest/`
>
> **完整条款见 [免责声明](./DISCLAIMER.md)。使用即视为接受全部条款。**
> 如不认同，请勿使用。

---

## 目录

- [解决什么问题](#解决什么问题)
- [快速开始](#快速开始)
- [命令](#命令)
- [AI 自动聊天](#ai-自动聊天)
- [为什么是私信，不是评论](#为什么是私信不是评论)
- [它是怎么工作的](#它是怎么工作的)
- [数据在哪](#数据在哪)
- [已知限制](#已知限制)
- [开发](#开发)
- **[路线图](./ROADMAP.md)** ← 还缺什么
- **[免责声明](./DISCLAIMER.md)**

---

## 解决什么问题

抖音的问题不是内容少，是**噪音太多**。

默认的推荐流按完播率和互动量排序 —— 结果是整活、番剧、吃播。你想看的「DeepSeek 开源推理框架的技术分析」被压在下面。

这个工具换了个做法：

```bash
douyin-digest digest --kw "DeepSeek"
```

它会：

1. **按你的关键词搜索**（不是靠推荐流喂你）
2. **读每条视频的文案和评论**（不是只看标题）
3. **打分**：关键词命中 + 知识类信号 + 互动率 − 娱乐类降权
4. **只挑前几条**写进日报
5. **分享到私信**（只有互关的人能看到）

输出的日报长这样（下面是**编造的示例**，不是真实数据）：

```markdown
### douyin:0000000000000000000
- 标题：某开源项目发布新版本，作者演示了完整流程
- 作者：@某科技账号　时长：3:51　播放：20.1万
- 链接：https://www.douyin.com/video/0000000000000000000
- **档位**：值得看
- 得分：187（命中关键词 ×1、知识类 ×3、评论率 1.50%）
- 内容形态：desc+comments
- 数据：赞 20000 · 评 3000 · 藏 500 · 分 40

【文案】
某开源项目发布新版本，作者演示了完整流程 #关键词 #开源 #技术分享

【评论 15 条】
用户甲：这个演示挺清楚的，之前一直没搞懂…（541 赞）
用户乙：请问在低配机器上跑得动吗？（43 赞）
```

---

## 快速开始

### 1. 装

```bash
npm i -g douyin-digest
# 或者不装，直接用
npx douyin-digest --help
```

需要 Node 22+（用了内置的 WebSocket）。

### 2. 登录

```bash
douyin-digest login
```

会弹出一个浏览器窗口，扫码登录**抖音小号**。

登录态保存在 `~/.douyin-digest/profiles/douyin/`，之后所有命令复用。

> **建议用小号**。这个工具会操作你的账号（搜索、分享），用小号不影响主号。

### 3. 跑一轮

```bash
# 只看效果（不写文件、不分享）
douyin-digest digest --kw "DeepSeek,AI"

# 写日报
douyin-digest digest --kw "DeepSeek" --read 3 --yes

# 写日报 + 分享到私信
douyin-digest digest --kw "DeepSeek" --read 3 --share --yes
```

---

## 命令

| 命令 | 做什么 |
|---|---|
| `login` | 扫码登录，登录态持久化 |
| `status` | 看登录态、家目录、判重表 |
| `search <关键词>` | 搜索并按分数排序 |
| `read <视频id>` | 读一个视频的文案 + 评论 |
| `digest` | 完整一轮（搜 → 读 → 打分 → 日报） |
| `share <视频id>` | 分享视频给互关好友 |
| `dm` | 读私信（区分谁发的） |
| `say <文本>` | 发私信 |
| **`watch`** | **私信自动回复（AI 聊天）** |
| `today` | 看今天的日报 |
| `config [k] [v]` | 读写配置 |

### 常用参数

| 参数 | 说明 |
|---|---|
| `--kw a,b` | 关键词，逗号分隔 |
| `--read N` | 读几条详情（默认 3，每条约 10 秒） |
| `--top N` | 挑几条进日报（默认 3） |
| `--share` | digest 时顺便分享 |
| `--yes` | 写入日报 / 真分享 / 真发（不加就是 dry-run） |
| `--to <好友名>` | 分享给指定好友（默认第一个互关好友） |

### watch 专用

| 参数 | 说明 |
|---|---|
| `--interval N` | 轮询间隔秒数（默认 30） |
| `--api-key sk-xxx` | 用 DeepSeek API 生成回复（也可用 `DEEPSEEK_API_KEY` 环境变量） |
| `--persona "…"` | 人设提示词 |
| `--reply-cmd "…"` | 用外部命令生成回复（消息从 stdin 进，回复从 stdout 出） |
| `--max-per-day N` | 每天最多回几条（默认 50） |
| `--rounds N` | 跑几轮就停（默认不限） |

---

## AI 自动聊天

抖音私信可以变成"AI 陪你聊天"的通道 —— 小号刷视频、发私信，你在大号那边回一句，AI 用小号自动接话。

```bash
# 先看它会回什么（dry-run）
douyin-digest watch --rounds 2

# 接 DeepSeek 真跑
douyin-digest watch --api-key sk-xxx --yes

# 接任意模型 / 脚本
douyin-digest watch --reply-cmd "你的脚本" --yes
```

### 已经有 DSH？直接复用它的凭据

仓库里带了 `examples/reply-dsh.mjs`，它**读 `~/.dsh/.credentials.yaml` 里已配的 key**，所以不用再单独配：

```bash
douyin-digest watch --reply-cmd "node examples/reply-dsh.mjs" --yes
```

加人设 —— **用环境变量，不要用 `--persona`**（会被 CLI 参数解析在空格处截断）：

```powershell
$env:REPLY_PERSONA="你是我的抖音小号，说话简短随意，像女朋友一样，接住话题别答非所问"
$env:REPLY_MODEL="MiniMax-M3.1-Flash"
douyin-digest watch --reply-cmd "node examples/reply-dsh.mjs" --yes
```

它按 `DEEPSEEK_API_KEY` → DSH 里其他已配 key 的顺序试。

> **为什么不直接用 `dsh headless`：**
> 桌面版跑得好好的，但 `dsh headless` 会报
> `MISSING_CREDENTIAL: no API key for provider route "deepseek-official"`
> —— headless 只认环境变量，读不到桌面版存在 `.credentials.yaml` 里的凭据。
> 所以这个脚本自己读那份文件。

### 上下文是标准 LLM messages

`--reply-cmd` 的输入不是拼好的文本，而是**标准 messages 数组**：

```json
{
  "messages": [
    { "role": "user",      "content": "你好" },
    { "role": "assistant", "content": "嗨，怎么啦？" },
    { "role": "user",      "content": "今天有点累" }
  ],
  "persona": "（可选）人设",
  "model":   "（可选）指定模型"
}
```

自己发的是 `assistant`，对方发的是 `user`。system prompt 由回复引擎自己加（人设归引擎管）。

stdout 只要回复正文，别输出别的。

**为什么这样做**：早先版本把历史拼成 `对方：xxx\n我：yyy` 的文本传进去，引擎还得反解析一遍 —— 中间任何格式抖动都会让模型答错。用 messages 数组直接透传，没有中间层。

### MiniMax 可用的模型

实测（2026-10，`GET /v1/models` + 逐个试）：

| 模型 | 状态 |
|---|---|
| `MiniMax-M3.1-Flash` | ✅ 最新，快 |
| `MiniMax-M3` | ✅ |
| `MiniMax-Text-01` | ✅ 老但稳 |
| `MiniMax-M2` / `abab6.5*` / `abab7*` | ❌ 已下线（`2069`） |

⚠️ 接口要用 `https://api.minimax.chat/v1/text/chatcompletion_v2`（老式）。新的 `/v1/chat/completions` 不认这个 key。

### 其他接法

```bash
# 本地 ollama
watch --reply-cmd "ollama run qwen2.5" --yes

# 自己的 shell 脚本（读 JSON、输出文本）
watch --reply-cmd "./my-reply.sh" --yes
```

### 安全闸（写死在代码里，不可关）

| 闸 | 说明 |
|---|---|
| 只回对方的 | 不回自己发的，否则会自己跟自己聊 |
| 每条只回一次 | 用消息指纹判重，存在 `watch-state.json` |
| 每天有上限 | 默认 50 条，跨天自动重置 |
| 分享卡片不回 | 那是视频卡片，不是对话 |
| 系统消息不回 | 「你们已互相关注」这类不触发 |
| **默认 dry-run** | 不加 `--yes` 只看会回什么，绝不发送 |

---

## 为什么是私信，不是评论

很多同类工具的做法是「在视频下评论 @ 你」。这个工具**不做评论**，只发私信。

原因很实际：

```
你在别人视频下评论 @ 自己
    ↓
算法把评论推给其他观众
    ↓
陌生人点进你的主页 / 回评 / 私信
    ↓
你的号从此被陌生人骚扰
```

抖音的推荐机制会把评论顶给更多人，引流比 B站 更凶。

**私信干净得多**：只有互关的人能收到，陌生人发不进来。

| | 公开评论 | 私信 |
|---|---|---|
| 谁能看到 | 所有人 | 只有你 |
| 副作用 | 引流陌生人 | 无 |
| 被审核风险 | 有 | 低 |

---

## 它是怎么工作的

全部通过**浏览器 DOM 操作**完成 —— 因为抖音没有可用的公开接口：

- **搜索**是前端渲染，数据直接可见
- **私信**走 ByteLink WebSocket（protobuf 编码），HTTP 里没有
- **分享 / 发消息**都是点击操作

用的是 CDP（Chrome DevTools Protocol），Node 22 自带 WebSocket，所以**零依赖**：

```
不用装 Playwright（省 150MB 的 Chromium 下载）
不用装 Puppeteer
不用 Python
```

### 一个坑：抖音每个按钮的点击方式都不一样

| 操作 | 正确方式 |
|---|---|
| 打开「消息」面板 | `dispatchEvent` |
| 打开分享面板 | `Input.dispatchMouseEvent`（真实鼠标） |
| 点「分享」按钮 | 先 hover，再 `el.click()` |
| 进聊天（点会话项） | `dispatchEvent` 到 `conversationConversationItemwrapper` |
| 发消息 | `Input.insertText` + Enter |

搞反了就是**没反应**，而且不报错。这些都在源码注释里标出来了。

### 更细的几个坑

- **「消息」是 toggle** —— 面板开着时再点会关掉
- **面板会被推到视口外** —— 窄窗口下抖音用 `translateX(100%)` 把它滑出去。
  `dispatchEvent` 不受影响（不需要坐标），但 `Input.dispatchMouseEvent` 就点不到
- **分享成功的判据不是"面板关闭"** —— 面板永不关。
  真信号是那个好友的按钮从「分享」变成「捎句话」
- **消息 DOM 顺序不可靠** —— 要按 `getBoundingClientRect().top` 排序才拿到正确时间线
- **判断"谁发的"用 `isFromMe` class** —— 不是靠左右位置（分享卡片会干扰）

---

## 数据在哪

```
~/.douyin-digest/
├── profiles/douyin/    浏览器 profile（登录态在这里）
├── out/<日期>.md       日报
├── seen.md             判重表（可以手动删行）
└── config.json         配置
```

不写进当前目录。

---

## 已知限制

| 限制 | 说明 |
|---|---|
| **要开浏览器窗口** | 不是 headless —— 抖音会识别 headless 并给空页面 |
| **抖音改版会失效** | class 名是构建时生成的随机串，改版要更新 `src/douyin.mjs` |
| **读不到语音** | 抖音没有字幕轨。现在读的是文案 + 评论，语音要另做 ASR |
| **每条详情约 10 秒** | 要等页面渲染 + 滚动加载评论 |
| **只能分享给互关好友** | 抖音的产品限制，不是工具的 |
| **Mac / Linux 未实测** | 只在 Windows + Edge 上验证过 |

---

## 开发

```bash
git clone https://github.com/YOUR_NAME/douyin-digest
cd douyin-digest
node bin/cli.mjs --help     # 直接跑，不用装依赖

DEBUG=1 node bin/cli.mjs status   # 看浏览器日志
```

结构：

```
bin/cli.mjs       命令行入口
src/browser.mjs   CDP 浏览器（零依赖）
src/douyin.mjs    抖音操作（搜索/详情/分享/私信）
src/score.mjs     打分
src/digest.mjs    完整一轮
src/config.mjs    配置与判重
```

---

## 许可证

MIT
