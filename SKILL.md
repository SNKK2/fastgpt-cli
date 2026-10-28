---
name: fastgpt-cli
description: "管理 FastGPT 的唯一推荐方式。工作流必须用本 CLI 的 DSL 构建并用 wf build 部署，禁止手写 nodes/edges JSON 或直接 curl FastGPT API。踩过的 8 类 API 陷阱已固化在构造器和校验器里，手写 JSON 必然触发。用于搭建/修改 FastGPT 工作流、Agent、知识库、权限、发布渠道、运行调试。"
---

# FastGPT CLI

## 🚨 红线：先读这一段

**如果你正在输出包含 `nodeId` / `sourceHandle` / `flowNodeType` / `selectedType` 的 JSON，立刻停止 —— 走错路了。**

| ❌ 错误做法 | 后果 | ✅ 正确做法 |
|---|---|---|
| 手写 `{"nodes":[...],"edges":[...]}` | handle 格式、selectedType、modelId 类型、maxToken 等 8 类陷阱必然踩中，UI 上连线消失或输出为空 | 写 DSL，用 `wf build` |
| 直接 `curl` FastGPT API | 缺 CSRF 头 → 403；pro 接口前缀错 → 404；appId 要放 query → 参数校验失败 | 用 CLI 命令 |
| 把模型名当 modelId | 发布报 `Model model is unavailable` | `wf get <appId>` 提取 24 位 ObjectId |
| 看到 `{"code":200}` 就当成功 | `app/update` / `version/update` 是假保存，数据被静默 strip | 用 `wf build`，拉回校验 |
| 自己算 handle id | `${nodeId}-source-${key}` 顺序反了 UI 不渲染，但运行时照样跑 | `edge()` 或 DSL 数组 |

### 🚨 红线二：遇到 dead_end 必须停

有些错误带 `dead_end: true` 和 `must_end_turn: true`，意思是：

**这条路没有替代走法，把消息发给用户，结束本轮。**

典型是 `model_id_unavailable`（团队没配过模型）。它的 hint 里写明了为什么绕过没用：

```
⚠️ 这条路没有替代走法：
  · 修改 CLI 源码去掉校验 → 服务端 version/publish 仍会拒绝
  · 直接调 FastGPT API 传模型名 → 同样返回 Model model is unavailable
  · 编造 24 位 hex → 格式能过，发布时一定失败
  · 换用其他命令或改 DSL 参数 → 结果完全相同
```

**看到 `dead_end` 就停下。** 不要读源码、不要改 CLI、不要换命令重试。

### 🚨 红线三：前端不认的写法（服务端能跑，所以最难发现）

这四类写法**运行时全绿、界面全错**，只靠跑通判断一定漏：

| 写法 | 症状 | 正确做法 |
|---|---|---|
| 裸变量占位 `{{DatasetId}}` | UI 显示纯文本而非变量芯片，变量依赖/改名联动全失效 | 写 `{{$VARIABLE_NODE_ID.DatasetId$}}`，节点输出写 `{{$nodeId.outputKey$}}` |
| `canEdit:true` 的输入存常量 | 进「自定义变量」表格只给引用选择器 → 空的「选择引用变量」+「存在未完成的输入变量配置」 | 常量内联进代码/节点参数后删掉该输入项；`canEdit` 本身不要删（运行时靠它解析引用） |
| `system_addInputParam.value = null` | 动态输入表格按数组处理，渲染异常 | `[]` |
| `ifElseList[].list[].value = true` | 「输入项 ifElseList 不符合字段结构约束」 | 布尔存字符串 `"true"` |

`wf lint` 全会报，`wf build` 会先尝试自动修；`canedit_const_value` 这类要加 `--inline-consts` 才自动内联（默认关，属内容级修改）。对应字段：`issues[].code`（
`bare_variable_ref` / `canedit_const_value` / `addinputparam_null` / `ifelse_value_type` / `handle_legacy_port`），
`issues[].fix` 为 `auto` 的跑一次 `wf lint --fix` 就没了，`manual` 的必须改内容。

发布前必须 `wf check-run` 再看一遍，因为**服务端兼容裸写法**，功能正常不代表界面正常。

**判断信息该放哪**（写一次省很多次）：
- 决定「下一步动作」→ 错误 envelope 的 `hint`（要到命令级，不要写"逐项修正"这种废话）
- 「这个错具体怎么改」→ `details.issues[].message` + `fix` 标记，让 agent 按 code 分支
- 「禁止做什么」→ `forbidden` 字段 + 本文件红线
- 只写在文档里 = 大概率没被读，等于没有

### 强制停止层

撞上 dead_end 后，CLI 会在本地写一个阻断状态。后续 `wf build` / `wf publish` / `app create`
会直接返回：

```json
{
  "ok": false,
  "blocked": true,
  "error": {
    "subtype": "model_id_unavailable",
    "dead_end": true,
    "note": "当前环境已进入阻断状态，换命令或改参数都不会有不同结果"
  }
}
```

**看到 `blocked: true` 不要再试任何相关命令。** 阻断会在用户完成配置、
`fastgpt model id` 成功返回后自动解除（24 小时未解除会自动失效）。

### 🚨 红线三：缺关键信息时，必须问用户，禁止绕过

需要以下任一项但当前没有时，**停下来向用户索要**，不要用占位符或伪造值硬走：

| 缺失项 | 正确做法 | 禁止做法 |
|---|---|---|
| `FASTGPT_BASE` | 问用户「你的 FastGPT 地址是什么？」 | 猜一个地址 |
| 账号凭证 | 问用户「账号密码或 token？」 | 跳过登录直接写 DSL |
| `modelId` | 运行 `fastgpt model id`，无结果则引导用户去 WebUI 操作 | ❌ **用 `0000...` 或任意 24 位 hex 伪造** |
| `datasetId` | `fastgpt ds list` 让用户确认 | 编一个 ID |

**为什么不能伪造 modelId**：校验器只能检查「格式是不是 24 位 hex」，
`000000000000000000000000` 能通过格式校验，但部署后 100% 报
`Model model is unavailable`。伪造等于让用户拿到一个跑不起来的半成品。

真实部署时 CLI 会拿 DSL 里的 modelId 和团队真实候选比对，对不上直接 exit 3。

### 🚨 红线三：dry-run 也要登录

```
wf lint  <dsl.json>       纯语法检查（离线，可未登录）—— 不代表可部署
wf build <dsl.json> --dry-run   需要登录，校验结构 + 验证 modelId/datasetId 真实性
wf build <dsl.json>             真实写库
chat run                        验证真的能跑
```

**`wf build --dry-run` 强制要求登录。** 未登录会 exit 11 并让你去 init。

理由：dry-run 要验证 `modelId` 是否属于当前团队、`datasetId` 是否存在。
不登录这些验证都做不了，「结构合法」的假象会让人误以为能部署。

**只有 `wf lint` 是真正离线的**，它的输出会明确标注：

```json
{
  "ok": true,
  "lintOnly": true,
  "note": "仅语法检查，未验证 modelId / datasetId 真实性，不代表可部署",
  "unresolvedModelIds": [{ "node": "n_chat", "value": "<YOUR_MODEL_ID>" }]
}
```

**看到 `lintOnly: true` 就说明：还不能交付，必须登录后跑 `wf build`。**

**唯一合法的建工作流方式**：

```bash
# 1. 写 DSL（人类可读，不是 FastGPT 原始 JSON）
cat > my-workflow.json <<'DSL'
{
  "appId": "<APP_ID>",
  "nodes": [
    { "type": "start",  "id": "n_start" },
    { "type": "chat",   "id": "n_chat", "modelId": "<OBJECT_ID>",
      "question": "n_start:userChatInput" },
    { "type": "answer", "id": "n_answer", "content": "n_chat:answerText" }
  ],
  "edges": [["n_start","n_chat"], ["n_chat","n_answer"]]
}
DSL

# 2. 先干跑校验（不触网）
fastgpt wf build my-workflow.json --dry-run

# 3. 部署
fastgpt wf build my-workflow.json
```

DSL 里只需要 `type` + `id` + 业务参数，节点结构、连线 handle、selectedType 全部由 CLI 生成。

## 安装与前置

```bash
npm install -g github:SNKK2/fastgpt-cli

fastgpt init      # 交互选择部署版本 + 登录
fastgpt doctor    # 环境自检
```

装完直接用 `fastgpt <命令>`，不需要进入任何目录。

### 不要读源码

`fastgpt` 是全局安装的命令，**没有可读的源码目录**。
遇到报错时按错误里的 `hint` 走，不要去翻实现或搜索后端源码找绕过方法。

想确认某个命令怎么用：`fastgpt help` 或 `fastgpt <group> <cmd> --help`。

`init` 会列出四种部署版本，选一个即可：

| preset | 部署版本 | 地址 |
|---|---|---|
| `cn` | 中国 SaaS 版 | `https://cloud.fastgpt.cn` |
| `global` | 海外 SaaS 版 | `https://cloud.fastgpt.io` |
| `local` | 本地开发 | `http://localhost:3000` |
| `private` | 商业私有化 | 需你提供，如 `http://192.168.1.10:3000` |

```bash
fastgpt init --preset cn --user <账号> --pass <密码>
fastgpt init --preset private --base https://fastgpt.yourcompany.com
```

**这些选项也直接出现在未配置的错误返回里**，不需要查文档。

`init` 会引导你完成两件事，写入 `~/.fastgpt/config.json`（权限 600）：

1. 服务地址（如 `https://your-fastgpt-host`）
2. 登录方式（账号密码 / 浏览器扫码）

非交互环境（agent 调用）用参数形式：

```bash
fastgpt init --base https://your-host --user <账号> --pass <密码>
```

Node 18+；扫码登录需要 Node 22+ 和本机 Chrome。

### 配置位置

| 路径 | 内容 |
|---|---|
| `~/.fastgpt/config.json` | 服务地址 |
| `~/.fastgpt/cookies.json` | 登录态（7 天） |

可用 `FASTGPT_HOME` 覆盖目录，便于多实例隔离：

```bash
FASTGPT_HOME=~/.fastgpt-prod fastgpt init
```

环境变量 `FASTGPT_BASE` 优先级高于配置文件。

**下文所有示例用全局命令 `fastgpt`**。如果你是用 git clone 装的（开发模式），
把 `fastgpt` 换成 `node bin/fastgpt.mjs` 即可，但生产使用建议走 `npm i -g`。

## 环境快照

登录后自动展示，也可随时运行：

```bash
fastgpt info            # 人类可读
fastgpt info --deep     # 含工作流/知识库明细（约 2 秒）
fastgpt info --json     # 结构化，给 agent 解析
```

人类可读版长这样：

```
  FastGPT 环境
  ──────────────────────────────────────────────
  用户      user_xxxxx
  团队      示例团队
  身份      可写成员
  套餐      standard
  积分      剩余 120,000 / 共 500,000

  资源
  ──────────────────────────────────────────────
  工作流    8 个（其中高级编排 6）
  知识库    3 个（另有 1 个文件夹）
  文档      12 篇（3 个知识库有内容）
  应用总数  10 个（含插件 2、工具集 1）
  成员      5 人
  模型      6 个 LLM，2 个向量模型
  可用模型  4 个 modelId 可提取

  能力
  ──────────────────────────────────────────────
  ✓ 创建 / 编辑工作流
  ✓ 创建知识库
  ✓ 创建 API Key
  ✗ 管理成员与权限
  ✗ 新增模型
```

**agent 用 `--json`**，字段：`identity` / `team` / `permissions` / `can` / `plan` /
`members` / `models` / `apps` / `datasets` / `apiKeys` / `ready` / `summary`。

### `can` —— 语义化能力（推荐 agent 读这个）

`permissions` 是 17 个原始布尔字段（`hasDatasetCreatePer` 之类，难记）。
`can` 是派生出的语义化版本：

```json
"can": {
  "read": true,
  "write": true,           // 能创建/编辑工作流
  "createApp": true,
  "createDataset": true,
  "createApiKey": true,
  "createSkill": true,
  "manageModels": false,   // 能新增模型
  "manageMembers": false,  // 能管理成员权限
  "isOwner": false,
  "readOnly": false        // = !write
}
```

**判断能不能做某事，直接读 `can.xxx`，不要去猜原始字段名。**

`readOnly: true` 说明账号只能看不能改 —— 此时不应尝试任何写操作。

## 成功响应也带提示（_notice）

操作成功不代表可以往下走。CLI 会在成功响应里附加 `_notice`：

| 命令 | notice.type | 提示内容 |
|---|---|---|
| `wf build --dry-run` | `dry_run_only` | 只校验了结构，还必须真实部署 + chat run |
| `app create` | `app_created` | 应用节点为空，此时无法对话，下一步写 DSL |
| `ds add-file/text/link` | `training_async` | 训练异步执行，此时检索返回空，轮询 `ds training` |
| `ds search` 空结果 | `empty_result` | 可能训练未完成，不一定是配置错误 |
| `chat run` 空回答 | `empty_answer` | 应用未发布或节点未配模型 |

**看到 `_notice` 就按 `hint` 走下一步，不要忽略。**

## 工具调用（agent v2）

**不要用 `agent` 节点挂工具**（`agent_selectedTools` 发布时报 appUnExist）。
正确结构是 `tools` 节点 + `pluginModule` 节点，用特殊 handle 连线：

```
start → tools ─[sourceHandle: "selectedTools"]→ pluginModule（工具1）
              └[sourceHandle: "selectedTools"]→ pluginModule（工具2）
              └[sourceHandle: "right"]→ answer
```

DSL 写法：

```json
{
  "nodes": [
    { "type": "start", "id": "n_start" },
    { "type": "toolCall", "id": "n_tools", "modelId": "<ID>",
      "question": "n_start:userChatInput",
      "prompt": "你是知识库管家。问有哪些知识库时调用查询工具。" },
    { "type": "pluginModule", "id": "pm_query",
      "appId": "<plugin应用ID>", "name": "查询知识库",
      "params": [{ "key": "searchKey", "label": "搜索词" }] },
    { "type": "answer", "id": "n_answer", "content": "n_tools:answerText" }
  ],
  "edges": [
    ["n_start", "n_tools"],
    ["n_tools", "n_answer"]
  ]
}
```

**注意**：`selectedTools` 连线不能用 `["源","目标"]` 简写（那个生成的 handle 是 `-source-right`），
要写完整对象：

```json
{ "source":"n_tools", "sourceHandle":"selectedTools",
  "target":"pm_query", "targetHandle":"selectedTools" }
```

### 四个必须避开的坑

| 坑 | 错误 | 正确 |
|---|---|---|
| **工具挂载节点** | `agent` + `agent_selectedTools` | `pluginModule` + `selectedTools` edge |
| **HTTP 头字段** | `system_httpHeaders` | `system_httpHeader`（单数） |
| **工具参数模式** | `selectedType: 'input'` | `agentGenerated` + `defaultToAgentGenerated: true` |
| **变量引用** | `{{$pluginInput.xxx$}}` | `{{$<实际nodeId>.xxx$}}` |

第四点最容易踩：`pluginInput` 是别名，引用要用节点的真实 `nodeId`
（比如 `n_input`），写成 `{{$n_input.datasetName$}}`。

用 helper 生成：`VARP('n_input', 'datasetName')` → `"{{$n_input.datasetName$}}"`

### 工作流工具（plugin）的搭建

```
pluginInput(参数) → httpRequest468(调 API) → pluginOutput(结果)
```

```js
import { node, VARP } from './lib/nodes.mjs';

const pin = node.pluginInput('n_input', { params: [{ key:'datasetName', label:'知识库名称', required:true }] });
const http = node.http('n_http', {
  url: 'https://your-host/api/core/dataset/create',
  method: 'POST',
  headers: [{ key:'Authorization', value:'Bearer <API_KEY>', type:'string' }],
  jsonBody: `{"parentId":null,"type":"dataset","name":"${VARP('n_input','datasetName')}","intro":""}`
});
const pout = node.pluginOutput('n_output', { from: ['n_http','httpRawResponse'] });
```

## 内在参数自动调整

DSL 里有几类参数**不写就会出错**，`wf build` 会按节点依赖关系自动修正：

| 参数 | 规则 | 不做会怎样 |
|---|---|---|
| `chatNode.isResponseAnswerText` | 输出的 `answerText` 被 `answerNode` 消费 → `false`；无消费者 → `true` | **同一条回复输出两次**（chatNode 流式一次 + answerNode 一次） |

实测现象：

```
# 修复前
fastAnswer: "你好呀！很高兴见到你…"        ← answerNode 输出
answer:     "你好呀" + "，" + "今天" + …   ← chatNode 又流式输出一遍

# 自动调整后
fastAnswer: "你好呀！很高兴见到你…"        ← 只剩这一个
answer:     (空)
```

执行时会打印变更：

```
⚙️  已自动调整节点参数：
   n_chat.isResponseAnswerText: (未设置) → false
     answerText 已被 answerNode 消费，关闭节点自身输出以避免重复回复
```

**取舍**：接了 `answerNode` 会失去流式效果（`answerNode` 走 `fastAnswer` 一次性输出）。
如果要流式，就不要接 `answerNode`，让 `chatNode` 直接输出。

### 重复引用检测

多个 `answerNode` 引用同一个输出时，校验器会判断它们是否互斥：

| 情况 | 判定 | 结果 |
|---|---|---|
| 同一路径上两个 answer 引用同一输出 | 会同时执行 | ❌ ERROR，拒绝部署 |
| 分属同一 classify 的不同分支 | 互斥，一次只走一条 | ⚠️ WARNING，可忽略 |
| 各自引用不同的 chat 输出 | 无冲突 | 通过 |

错误示例：

```
ERROR: 多个 answerNode 引用同一输出 n_chat:answerText（n_a1, n_a2），
这些节点可能同时执行，导致同一条回复输出多次。
请只保留一个，或让它们挂到互斥的分支上
```

判定方法：从每个 answerNode 向上游回溯，收集途经的分支选择
（`sourceHandle` 为 `-source-<key>` 的边）。若两个节点经过同一 classify
下的不同 key，则互斥。

## 错误契约（agent 必读）

所有错误都是结构化 envelope，**`hint` 就是操作指令，`action_required` 决定你该做什么**：

```json
{
  "ok": false,
  "error": {
    "type": "platform",
    "subtype": "model_id_unavailable",
    "message": "当前团队没有任何应用配置过模型，无法提取 modelId",
    "hint": "请让用户完成：1) 打开任意应用 2) 拖入「AI 对话」节点 3) 选模型 4) 保存",
    "next_command": "fastgpt model id",
    "action_required": "user",
    "forbidden": "不要用 000000000000000000000000 或任意编造的 24 位 hex 冒充 modelId"
  }
}
```

**`action_required` 的三种值，决定你的行为**：

| 值 | 含义 | 你该做什么 |
|---|---|---|
| `self` | 你能解决 | 执行 `next_command` |
| `user` | 必须用户操作 | **把 `hint` 原文发给用户，结束本轮**，不要自己想办法绕 |
| `none` | 无法解决 | 上报 |

**`forbidden` 字段是硬性禁止**。看到它就不要尝试该做法，即使那样能让命令"通过"。

### 退出码

| 码 | category | 含义 |
|---|---|---|
| 10 | config | 未配置 |
| 11 | auth | 未登录 |
| 12 | permission | 权限不足 |
| 13 | resource | 资源不存在 |
| 14 | platform | 平台限制 |
| 15 | network | 网络异常 |
| 2 | validation | 校验失败 |
| 1 | usage | 用法错误 |

## 扫码登录：Split-Flow

**不要在单轮里阻塞等待用户扫码** —— 你的中间输出用户看不到。

```bash
# 第一轮：立即返回，不阻塞
fastgpt auth scan --no-wait
# → {"ok":true, "sessionId":"9460", "url":"https://.../login",
#    "hint":"把这条消息发给用户并结束本轮",
#    "nextCommand":"fastgpt auth scan --wait --session-id 9460",
#    "action_required":"user"}

# 结束本轮，等用户回复「扫好了」

# 第二轮：确认
fastgpt auth scan --wait --session-id 9460
```

浏览器在 `--no-wait` 后会保持打开（detached），第二轮能重连。

## agent 标准动作

按这个顺序做，不要跳步：

0. `doctor` —— 先跑这个，确认能不能干活
0.5 `info` —— 看清家底（成员数、工作流数、知识库数、配额、权限）
1. `auth whoami` 确认身份、拿 teamId/tmbId
2. `wf get <任意已有应用>` 提取 `<LLM_MODEL_OBJECT_ID>`（不要猜）
3. `ds list` 拿知识库 ID（如果要用 RAG）
4. 写 DSL 文件
5. `wf build xxx.json --dry-run` —— **必须通过，有 error 就改 DSL，不要绕过**
6. `wf build xxx.json` 部署
7. `chat run --appId <id> -q "测试问题" --detail` 验证真的能跑

## 自检清单（交付前必过）

- [ ] 我没有手写任何 `nodeId` / `sourceHandle` / `flowNodeType`
- [ ] DSL 通过了 `--dry-run`，warnings 也看过
- [ ] modelId 是 24 位 hex，不是我猜的模型名
- [ ] 我用 `chat run` 实跑过，`trace` 显示走了预期节点
- [ ] 我拉回 `wf get` 确认节点数、连线数和预期一致

任何一条不满足，说明流程有问题。

## 前置：认证

**首次使用或 cookie 失效（7 天）时会自动引导**，任意命令触发：

```
未登录或登录已失效，请选择登录方式：
  1) 账号密码登录
  2) 打开浏览器扫码（微信/企业微信账号）

```

两种方式也可直接指定：

```bash
# 密码登录
fastgpt auth login --user 138xxxx --pass '明文密码'

# 扫码登录（自动开浏览器 + 抓 httpOnly cookie）
fastgpt auth scan
```

**没有第三条路**。token 是这两种登录方式的结果，不是一种输入。
不要去找 token、不要复用别人的 cookie、不要从浏览器手工复制。

验证：

```bash
fastgpt auth whoami    # 返回 _id / username / team
```

### agent 调用时的行为

非 TTY 环境（脚本/agent）不会卡在交互提示，直接返回带指引的错误：

```json
{
  "ok": false,
  "error": "未登录或登录已失效。请先执行其中之一：\n  fastgpt auth login --user <账号> --pass <密码>\n  fastgpt auth scan              # 打开浏览器扫码",
  "code": 401
}
```

agent 应根据这个提示选择：有密码 → `auth login`；扫码账号 → `auth scan`（会弹出浏览器，需要用户配合）。

执行中途 cookie 过期也会自动触发重新认证并重试一次。

## 核心：三个必知概念

### 1. modelId 是 ObjectId，不是模型名

```bash
fastgpt model list --type llm     # 只能看到名字
```

真实的 `modelId` 形如 `<LLM_MODEL_OBJECT_ID>`（24 位 hex）。获取方式：

```bash
# 从已有应用的节点里取
fastgpt wf get <appId> | grep -o '"modelId"[^,]*'
```

**传模型名会失败**，发布时报 `Model model is unavailable`。

### 2. 连线 handle 不要手写

用 `edge()` 生成的格式永远正确。规则：

```
普通输出  {nodeId}-source-right
分支输出  {nodeId}-source-{branchKey}    ← type 在前，不是 key 在前
普通输入  {nodeId}-target-left
```

常见的错：`n_classify-kb-source-right`（顺序反了，UI 不渲染）。

在 DSL 里只写 `["源节点","目标节点","分支key?"]`，CLI 自动算。

### 3. 引用型输入必须 selectedType=reference

`value` 是 `["nodeId","outputId"]` 数组时，`selectedType` 必须为 `"reference"`，否则 UI 显示空白。

节点构造器（`lib/nodes.mjs`）已自动处理，不要手工拼 inputs。

## 命令速查

```bash
# 自检
fastgpt doctor

# 认证
fastgpt auth login --user U --pass P
fastgpt auth scan --no-wait                        # 第一轮
fastgpt auth scan --wait --session-id <id>         # 第二轮
fastgpt auth whoami

# 模型
fastgpt model list --type llm          # 只看名字，没有 ID
fastgpt model id                        # 从已有应用提取 modelId（ObjectId）

# 应用
fastgpt app list
fastgpt app create --name "我的工作流" --type advanced
fastgpt app detail <appId>
fastgpt app delete <appId>

# 发布渠道（分享链接 / 嵌入 / API）
fastgpt app share create --appId <id> --name "对外分享" --type share
fastgpt app share create --appId <id> --name "网页嵌入" --type iframe
fastgpt app share create --appId <id> --name "API访问" --type apikey --qpm 200
fastgpt app share list   --appId <id>
fastgpt app share delete <_id>

# 工作流
fastgpt wf build <dsl.json> --dry-run     # 只校验，不写库
fastgpt wf build <dsl.json>               # 保存为草稿
fastgpt wf validate <workflow.json>
fastgpt wf get <appId> [--out wf.json]
fastgpt wf publish <appId>

# 知识库
fastgpt ds list
fastgpt ds create --name "知识库名"
fastgpt ds detail <datasetId>
fastgpt ds delete <datasetId>

# 知识库文档（RAG 内容）
fastgpt ds add-file <datasetId> ./doc.pdf              # 单文件
fastgpt ds add-batch <datasetId> ./docs --ext pdf,md    # 批量（递归+过滤+并发）
fastgpt ds add-text <datasetId> --name "标题" --text "内容"
fastgpt ds add-link <datasetId> https://example.com
fastgpt ds add-qa <datasetId> --file qa.json            # QA 问答对
fastgpt ds collections <datasetId>               # 文档列表
fastgpt ds training <collectionId>               # 训练进度（done=true 才可用）
fastgpt ds data <collectionId>                   # 切分后的数据块
fastgpt ds search <datasetId> "查询词"            # 检索召回测试
fastgpt ds retrain <collectionId>
fastgpt ds del <collectionId>
fastgpt ds perm <datasetId> on                   # 开启文档级权限

# ============ 权限（permission: 1管理 2写 4读，相加）============
# 读写=6  只读=4  全权=7  传 0 表示移除

# ⚠️ collaborators 是「完整列表」语义，不是增量。
#    CLI 已自动先查现状再合并，不用手动处理。但如果直接调 API，
#    只传新成员等于把 admin 删掉，会报 can_not_edit_admin_permission。

# 知识库 / 集合 / 应用
fastgpt perm dataset <datasetId>                     # 查协作者
fastgpt perm dataset <datasetId> --set tmbId:6       # 设为读写
fastgpt perm collection <collectionId> [--set tmbId:6]
fastgpt perm app <appId> [--set tmbId:6] [--del tmbId]
fastgpt ds perm <datasetId> on                       # 开文档级权限（之后集合可单独授权）

# 团队成员
fastgpt perm member                                  # 列表（拿 tmbId）
fastgpt perm member --count
fastgpt perm member --search 张
fastgpt perm member --del <tmbId>                    # 移除
fastgpt perm member --restore <tmbId>                # 恢复
fastgpt perm member --rename tmbId:新名字

# 团队级权限（整个团队的能力边界）
fastgpt perm team                                    # 查
fastgpt perm team --set tmbId:4                      # 设为只读
fastgpt perm team --del <tmbId>

# 邀请链接 —— 成员唯一的加入方式，没有直接 add 接口
fastgpt perm invite                                  # 列出
fastgpt perm invite --create --desc "研发组" --expires 7d --limit -1
fastgpt perm invite --forbid <linkId>                # 禁用

# 运行
fastgpt apikey create --name cli
fastgpt chat run --appId <id> -q "问题" --detail
```

## 工作流 DSL

> `"publish": true` 是默认行为（不写就是 true）。**只有要存草稿才显式写 false** ——
> 草稿状态下 `chat run` 会一直等到超时，因为对话接口只认已发布版本。

最小可用示例（意图识别 + 知识库问答 + 闲聊双分支）：

```json
{
  "appId": "<APP_ID>",
  "versionName": "v1",
  "publish": true,
  "nodes": [
    { "type": "start", "id": "n_start" },
    { "type": "classify", "id": "n_classify",
      "modelId": "<OBJECT_ID>",
      "prompt": "判断问题属于知识库问答还是闲聊",
      "question": "n_start:userChatInput",
      "branches": [
        { "key": "kb", "label": "知识库问答" },
        { "key": "chat", "label": "闲聊" }
      ] },
    { "type": "datasetSearch", "id": "n_search",
      "datasets": ["<datasetId>:知识库名"],
      "question": "n_start:userChatInput" },
    { "type": "chat", "id": "n_chat",
      "modelId": "<OBJECT_ID>",
      "prompt": "依据知识库回答",
      "question": "n_start:userChatInput",
      "quoteQA": "n_search:quoteQA" },
    { "type": "answer", "id": "n_answer", "content": "n_chat:answerText" },
    { "type": "chat", "id": "n_chat2",
      "modelId": "<OBJECT_ID>", "prompt": "友好闲聊",
      "question": "n_start:userChatInput" },
    { "type": "answer", "id": "n_answer2", "content": "n_chat2:answerText" }
  ],
  "edges": [
    ["n_start", "n_classify"],
    ["n_classify", "n_search", "kb"],
    ["n_search", "n_chat"],
    ["n_chat", "n_answer"],
    ["n_classify", "n_chat2", "chat"],
    ["n_chat2", "n_answer2"]
  ]
}
```

**引用简写**：`"n_start:userChatInput"` 会自动转成 `["n_start","userChatInput"]`。
**知识库简写**：`"ID:名称"` 会自动展开为完整 dataset 对象。

### 节点类型清单（11 种内置）

`start` `chat` `classify` `datasetSearch` `answer` `readFiles` `contentExtract`
`ifElse` `textConcat` `http` `code`

详细参数见下方表格。

### 不在清单里怎么办 —— 用 `raw`，不要绕开 CLI

如果需要的节点（如 `agent`、`toolCall`、`loop`、`userSelect`）没有构造器，
用 `raw` 直接传完整节点 JSON。它仍会走校验和保存，不会让你掉进那些坑：

```json
{
  "type": "raw",
  "id": "n_custom",
  "node": {
    "flowNodeType": "userSelect",
    "name": "用户选择",
    "avatar": "core/workflow/template/userSelect",
    "position": { "x": 300, "y": 0 },
    "showSourceHandle": true, "showTargetHandle": true,
    "inputs": [ ... ],
    "outputs": [ ... ]
  }
}
```

`raw` 会自动帮你做的：
- 补 `nodeId` / `position` / `inputs` / `outputs` 默认值
- 检测到 `value` 是 `[nodeId, outputId]` 数组时自动设 `selectedType: "reference"`
- 仍然参与 handle 校验、引用校验、孤立节点检查

**注意**：`raw` 的连线仍要在 `edges` 里手写，但 handle 由 `edge()` 生成，不用自己拼。
分支节点的 `sourceHandle` 写分支 key 即可（如 `["n_custom","n_next","branchKey"]`）。

### 支持的节点类型

| type | 说明 | 关键参数 |
|---|---|---|
| `start` | 流程开始 | 无 |
| `chat` | AI 对话 | `modelId`, `prompt`, `question`, `quoteQA?` |
| `classify` | 意图识别 | `modelId`, `branches[{key,label}]`, `question` |
| `datasetSearch` | 知识库搜索 | `datasets[]`, `question` |
| `answer` | 指定回复 | `content`（引用或文本） |
| `ifElse` | 条件判断 | `conditions[]` |
| `textConcat` | 文本拼接 | `texts[]` |
| `http` | HTTP 请求 | `url`, `method` |
| `code` | 代码执行 | `code`, `language` |

## 工作流模式库

### 模式 A：纯知识库问答

```
start → datasetSearch → chat(quoteQA) → answer
```

### 模式 B：意图识别分流

```
start → classify ─[kb]→ datasetSearch → chat → answer
                └[chat]→ chat → answer2
```

### 模式 C：带条件判断

```
start → chat → ifElse ─[true]→ answer
                     └[false]→ answer2
```

## 校验阶段能拦下什么

`wf build` 在写库前自动校验，任一项不通过则退出码 2、不写库：

- nodeId 重复 / 缺失
- edge 指向不存在的节点
- 分支 key 不在上游 `agents` 里
- sourceHandle / targetHandle 格式错误
- 引用指向不存在的节点或输出
- 引用但 selectedType 不是 reference
- 孤立节点（警告）
- modelId 不是 ObjectId（警告）

## 回归测试

```bash
npm test    # 62 项断言，纯离线
```

覆盖：15 种节点构造器、9 类校验规则、错误契约字段、`_notice` 挂载。

改动构造器或校验器后先跑这个。

## 常见错误

| 现象 | 原因 | 处理 |
|---|---|---|
| UI 上节点间没有连线 | handle 格式错 | 用 `edge()` / DSL 数组，不要手写 |
| UI 上变量显示空白 | selectedType 是 textarea | 构造器已处理；手写时设为 reference |
| 发布报 `Model model is unavailable` | modelId 传了模型名 | 改用 24 位 ObjectId |
| 保存返回 200 但拉回是空 | 用了 `app/update` 或 `version/update` | 只有 `version/publish` 能存图形 |
| 两条分支同时执行 | 分支 handle 顺序反了 | `${nodeId}-source-${branchKey}` |
| `403 csrf_invalid` | 缺 CSRF 头 | CLI 已内置 `fastgpt-web-request: fastgpt` |

## 调试

`/api/core/workflow/debug` 在部分环境不返回（长挂），用流式对话代替：

```bash
fastgpt chat run --appId <id> -q "测试问题" --detail
```

输出：

```json
{
  "ok": true,
  "trace": ["running:意图识别", "running:知识库搜索", "running:AI 回复"],
  "answer": "……"
}
```

`trace` 能看出实际走了哪条分支，是验证分支互斥最快的办法。

## 知识库接入流程

```
建库 → 上传（文档/QA）→ 等训练 → 检索验证 → 接进工作流
```

### 批量上传

```bash
fastgpt ds add-batch "$DS" ./docs --ext pdf,md,docx --concurrency 3
```

递归子目录，跳过隐藏文件，`--ext` 过滤扩展名，`--concurrency` 控制并发（默认 3）。

输出汇总：

```json
{ "ok": true, "total": 12, "success": 12, "failed": 0, "results": [...] }
```

中文文件名已正确处理（内部用 RFC 5987 `filename*`，Node 原生 FormData 会乱码）。

### QA 模式

```bash
# 从文件导入（自动创建 QA 集合）
fastgpt ds add-qa "$DS" --file qa.json --name "HR FAQ"

# 单条
fastgpt ds add-qa "$DS" --q "试用期多久？" --a "3 个月"

# 追加到已有集合
fastgpt ds add-qa "$DS" --file more.json --collectionId <id>
```

`qa.json` 格式：

```json
[
  { "q": "试用期多久？", "a": "试用期 3 个月，表现优秀可提前转正。" },
  { "q": "年终奖怎么算？", "a": "按年度绩效系数乘以月薪，次年 1 月发放。" }
]
```

接口只支持逐条插入，CLI 自动循环，每 10 条打一次进度。

```bash
DS=$(fastgpt ds create --name "产品手册" | jq -r .datasetId)
fastgpt ds add-file "$DS" ./manual.pdf

# 训练是异步的，必须等 done=true，否则检索为空
until fastgpt ds training <collectionId> | grep -q '"done": true'; do sleep 5; done

# 验证召回，再进工作流
fastgpt ds search "$DS" "如何退款"
```

**关键：训练没完成时 `ds search` 返回 0 条，容易误判为"检索坏了"。**

`ds training` 输出里 `pending` 会显示卡在哪个队列（`chunk` / `index` / `auto`），`hint` 直接告诉你能否检索：

```json
{ "pending": { "index": 1 }, "done": false, "hint": "还在训练，检索会返回空，请继续轮询" }
```

**特别注意 `index` 队列**：分块完成后索引可能还在排队，此时 `fullTextRecall` 和 `embedding` 都查不到任何东西，要等 `index` 归零。

`ds search` 输出里的 `score` 已从数组 `[{type,value}]` 归一为数字，直接看分数即可。

## 发布渠道

三种 `--type`：

| type | 产出 | 用途 |
|---|---|---|
| `share` | `https://<base>/chat/share?shareId=xxx` | 对外分享链接，匿名可访问 |
| `iframe` | `...&iframe=true` | 嵌进自己网站 |
| `apikey` | 无 URL | 走 API 调用 |

```bash
fastgpt app share create --appId <id> --name "客户答疑" --type share
# → { "shareId": "...", "url": "<your-fastgpt-host>/chat/share?shareId=..." }
```

可选参数：

| 参数 | 作用 |
|---|---|
| `--qpm 1000` | 每分钟调用上限 |
| `--anonymous` | 允许匿名（默认开） |
| `--show-cite` | 显示引用来源 |
| `--show-status` | 显示节点运行状态 |
| `--show-fulltext` | 显示知识库全文 |
| `--can-download` | 允许下载源文件 |
| `--maxUsagePoints` | 积分上限，-1 不限 |

`--type apikey` 创建后不会给 URL，用于生成独立的 API 访问凭证。

删除要用 `_id`（`app share list` 返回的第一列），不是 `shareId`。

## 权限位

```
manage = 1   管理员
write  = 2   可写
read   = 4   可读

4 = 只读    6 = 读写    5 = 管理+读    7 = 全部
```

`tmbId` 从 `fastgpt perm member` 取，**不是 userId**。

## 环境变量

```
FASTGPT_BASE   服务地址（必填）
FASTGPT_USER   登录账号
FASTGPT_PASS   登录密码
FASTGPT_APP_KEY  应用 API Key（chat run 用）
```

凭证存于 `.fastgpt/cookies.json`，权限 600。
