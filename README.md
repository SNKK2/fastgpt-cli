# fastgpt-cli

> **AI 只负责把话翻译成参数，能力全部做成工具；加能力就加工具，别在流程里加分支。**
> `Translate, don't decide. Capabilities are tools, not branches.`

这条原则出现在 `help` / `start` / `tool new` / `agent new` 的输出里，并由 `wf lint` 做硬检测：
code 节点里出现 `detectChartType` / 字段别名表 / 中文问法正则 → warning 提示拆成工具。


> 用命令行管理 FastGPT 的全部资源 —— 工作流、知识库、权限、发布渠道、运行调试。
> 为 **AI agent 设计**：每次输出都是 JSON，每条报错都是下一步的操作手册。

---

## 安装

```bash
npm install -g github:SNKK2/fastgpt-cli
```

零依赖，需要 Node 18+。装完直接使用 `fastgpt` 命令，不需要进入任何目录。

> 开发模式：`git clone` 仓库后 `npm link`。生产使用建议走上面的全局安装。

### 初始化

```bash
fastgpt init --preset cn
```

四个预设：

| preset | 地址 | 适用 |
|---|---|---|
| `cn` | `https://cloud.fastgpt.cn` | 国内 SaaS |
| `global` | `https://cloud.fastgpt.io` | 海外 SaaS |
| `local` | `http://localhost:3000` | 本地部署 |
| `private` | 需提供 `--base <地址>` | 商业私有化 |

也可以跳过交互直接给凭证：

```bash
fastgpt init --preset cn --user <账号> --pass <密码>
```

或者扫码登录（会打开 Chrome）：

```bash
fastgpt auth scan
```

凭证存在 `~/.fastgpt/`，`600` 权限。

---

## 能做什么

45 个命令，覆盖 FastGPT 的完整生命周期。

| 组 | 命令数 | 能力 |
|---|---|---|
| `init` / `doctor` / `info` | 5 | 配置、环境自检、能力快照 |
| `auth` | 5 | 密码登录、扫码登录、状态、登出 |
| `model` | 2 | 提取真实 modelId、列出模型 |
| `app` | 6 | 创建、列表、详情、更新、删除、复制 |
| `wf` | 5 | `build` / `lint` / `get` / `validate` / `publish` |
| `ds` | 16 | 知识库、集合、文档、QA、训练、检索、权限 |
| `perm` | 4 | 成员、权限、协作者 |
| `chat` | 1 | 运行对话，支持 SSE 流式和节点轨迹 |
| `apikey` | 1 | 创建 API Key |

```bash
fastgpt help                    # 全部命令
fastgpt wf --help              # 某个组的子命令
fastgpt info --deep            # 环境 + 资源明细
```

### 支持的工作流节点

`start` `chat` `classify` `datasetSearch` `answer` `readFiles` `contentExtract`
`ifElse` `textConcat` `http` `code` `agent` `pluginInput` `pluginOutput`
`pluginModule` `toolCall`，外加 `raw` 兜底任意节点类型。

---

## 使用

### 环境自检

```bash
$ fastgpt doctor
```

告诉你地址是否可达、登录是否有效、模型是否就绪、权限边界在哪。有问题会直接给出修复命令。

```bash
$ fastgpt info
```

```
  FastGPT 环境
  ──────────────────────────────────────────────
  用户      user_xxxxx
  团队      你的团队
  身份      可写成员
  积分      剩余 120,000 / 共 500,000

  资源
  ──────────────────────────────────────────────
  工作流    8 个（其中高级编排 6）
  知识库    3 个（另有 1 个文件夹）
  模型      6 个 LLM，2 个向量模型

  能力
  ──────────────────────────────────────────────
  ✓ 创建 / 编辑工作流
  ✓ 创建知识库
  ✗ 管理成员与权限
```

`can` 字段是语义化的布尔值 —— agent 不用自己推断权限。

### 搭建工作流

```bash
# 1. 拿模型 ObjectId（必须有真实的应用配过模型）
fastgpt model id

# 2. 建应用
fastgpt app create --name "智能客服" --type advanced

# 3. 写 DSL
cat > wf.json <<'EOF'
{
  "appId": "<APP_ID>",
  "versionName": "v1",
  "nodes": [
    { "type": "start",  "id": "n_start" },
    { "type": "chat",   "id": "n_chat",
      "modelId": "<MODEL_OBJECT_ID>",
      "prompt": "你是客服助手",
      "question": "n_start:userChatInput" },
    { "type": "answer", "id": "n_answer", "content": "n_chat:answerText" }
  ],
  "edges": [["n_start","n_chat"], ["n_chat","n_answer"]]
}
EOF

# 4. 先干跑（验证 modelId / datasetId 真实存在）
fastgpt wf build wf.json --dry-run

# 5. 部署并发布
fastgpt wf build wf.json
```

### 一条命令跑完全链路：`wf verify`

```bash
fastgpt wf verify export.json --inline-consts \
  --variables '{"RequestId":"<uuid>","DomainList":"[\"IE-内饰\"]"}' \
  --ui-cmd 'node scripts/check-ui.mjs {appId}'
```

七步串成一条，**默认在影子应用上跑，跑完自动删除**（`--appId` 才写入生产，`--keep` 保留影子）：

```
lint → target(影子) → validate+dryrun → deploy → diff → run → (ui) → cleanup
```

```json
{ "verdict": "all_passed", "totalMs": 3484,
  "steps": [
    { "step": "lint",     "ok": true, "autoFixed": 65, "issues": 0 },
    { "step": "target",   "ok": true, "mode": "shadow" },
    { "step": "validate", "ok": true },
    { "step": "deploy",   "ok": true },
    { "step": "diff",     "ok": true, "verdict": "clean",
      "counts": { "whitelisted": 141, "stripped": 0 } },
    { "step": "run",      "ok": true, "Status": "success" },
    { "step": "cleanup",  "ok": true }
  ] }
```

任一步失败即停：`{ ok:false, failedAt, hint, steps, details }`，exit 2。没配 API Key 时 `run` 步标注 `skipped`，不算失败。

### 部署后三层检测（v0.2.0 起内建）

工作流的坑分三层，**每层都会骗过另外两层**，必须各测一次：

| 层 | 命令 | 抓什么 |
|---|---|---|
| 静态 | `fastgpt wf lint <file> [--fix out.json]` | handle 形态、裸变量占位、canEdit 常量、null 动态输入、ifElse 值类型、引用不可解析 |
| 运行时 | `fastgpt wf check-run <appId> --variables '{...}'` | 真跑一次，摊开每个 HTTP 节点的 `headers`/`body`，抓「变量没替换」 |
| 版本 | `fastgpt wf versions <appId>` | 草稿 / `version/latest` / 各版本指纹，判断改动写进哪一层 |

`wf lint` 先做规范化再校验：能自动修的（handle、裸变量、null、ifElse 值）直接修好并列在 `autoFixed`，修不掉的（canEdit 常量）才报 error。`--fix` 会把规范化结果写成可直接喂 `wf build` 的文件。

```bash
fastgpt wf lint export.json --fix fixed.json --inline-consts   # 65 项自动修复，0 error
fastgpt wf build fixed.json --dry-run
```

`--inline-consts` 会把 code 节点里「`canEdit` 动态输入存常量」的情况内联进代码并删掉输入项
（前提是代码里确实把该 key 当变量用；替换后有残留就整体放弃，不做半成品）。

### 生成工具骨架：`tool new`

工具（plugin）应用必须写成 `function main({ 解构参数 })`、声明 outputs、接好动态输入 —— 这三件事只在服务端 sandbox 才报错，且不告诉你是哪个节点。`tool new` 把它们固化掉：

```bash
fastgpt tool new --name dt_query --params filters,groupBy,agg --code body.js
# → dt_query.tool.json（pluginInput → code → pluginOutput 已接好，main 已包好）

fastgpt tool new --name dt_query --params filters --code body.js --deploy
# → 直接建 plugin 应用并发布，返回 appId
```

`wf lint` 会拦这三类只在运行时才暴露的错：

| 错 | 报错原文 | lint 提示 |
|---|---|---|
| 顶层 `return`（没有 main） | `(intermediate value)(...) is not a function` | 代码没有定义 main 函数 |
| 内部变量与解构参数重名 | `Identifier 'groupBy' has already been declared` | 与 main 的解构参数重名，改内部变量名 |
| 解构模式下还用 `input.xxx` | `input is not defined` | 直接用解构出来的变量名 |

### 从工具生成 agent：`agent new`

```bash
fastgpt agent new --name chart_agent --tools <appId1>,<appId2>,<appId3> --deploy
```

自动做四件必做的事（每一件漏了都会「静默失败」）：

| 做法 | 漏了会怎样 |
|---|---|
| 建 `tools` 节点并 `selectedTools` 连 pluginModule | 工具挂不上，agent 报 `no valid tool calls matched` |
| **按工具真实入参填 pluginModule 的 params** | agent 传参永远是 `{}`，工具「正常返回空结果」，看不出错 |
| 从团队已有应用提取真实 modelId | 发布时报 Model unavailable |
| 按工具清单生成 prompt（列确切工具名 + 禁止发明工具名） | 模型臆造工具名 → `no valid tool calls` |

`wf build` 会额外做**工具参数契约检查**：pluginModule 一个参数都没声明、或缺少工具必填参数时直接拦下。

### 提交 vs 落库：`wf diff`

服务端保存时会跑 migration、补默认值、补异常边，**这些都不在响应里**。`wf diff` 读回对比，分五类输出：

```bash
fastgpt wf diff <appId> <file>
```

```json
{
  "verdict": "clean | server_normalized | data_loss",
  "added": [], "removed": [], "injected": [], "stripped": [], "changed": [],
  "whitelisted": [{ "code": "catch_edge_added", "count": 11, "samples": [] }]
}
```

- `stripped` / `removed` 非空 → `data_loss`，你的配置被丢了，必须合并回本地文件
- 已知无害项自动折叠成白名单计数：`agentGenerated` 注入、`selectedType` 默认填充、`catchError` 默认值、服务端补的 catch 边、变量 `renderTypeList` 被 strip

**注意顺序**：编辑器一打开前端就 autoSave。所以「部署 → diff → 开 UI 校验」之后必须**再 diff 一次**，
最终以「前端写回后的落库形态」为准。

### 运行验证

```bash
fastgpt apikey create --name cli
fastgpt chat run --appId <APP_ID> -q "你好"

# 看节点执行轨迹
fastgpt chat run --appId <APP_ID> -q "你好" --detail
```

### 知识库

```bash
fastgpt ds create --name "产品文档"                     # 建库
fastgpt ds collections <datasetId>                      # 列出集合
fastgpt ds import <datasetId> <collectionId> ./doc.pdf  # 传文档
fastgpt ds training <collectionId>                      # 看训练进度
fastgpt ds search <datasetId> "怎么退款"                 # 试检索

# QA 问答对
fastgpt ds qa import <collectionId> ./qa.csv
```

### 发布

```bash
fastgpt wf publish <appId>
fastgpt app share <appId>       # 分享链接
fastgpt app embed <appId>       # 嵌入代码
```

---

## 设计原理

### ① 错误就是操作手册

agent 不会读文档，所以每条报错都自带完整的下一步：

```json
{
  "ok": false,
  "error": {
    "type": "platform",
    "subtype": "model_id_unavailable",
    "message": "当前团队没有任何应用配置过模型，无法提取 modelId",
    "action_required": "user",
    "dead_end": true,
    "must_end_turn": true,
    "hint": "这是 FastGPT 平台的硬限制...\n\n唯一出路是让用户在 WebUI 配一次模型：\n  1. 打开任意应用 → 2. 拖入「AI 对话」节点 → 3. 选模型 → 4. 保存\n\n👉 把这条消息原样发给用户，然后结束本轮。",
    "forbidden": "不要修改 CLI 源码、不要直接调 API 绕过、不要编造 ObjectId、不要换命令重试",
    "resolved_by": "用户在 WebUI 配置模型后运行 fastgpt model id"
  }
}
```

四个字段的语义：

| 字段 | 含义 |
|---|---|
| `action_required` | `self` = 自己能解决，`user` = 必须问人，`none` = 无能为力 |
| `dead_end` | `true` = 这条路走不通，不是可重试的失败 |
| `must_end_turn` | `true` = 立即结束本轮，别试别的 |
| `forbidden` | 列出所有"看起来能绕过但实际没用"的做法 |

退出码按类别映射：`2` 使用错误、`10` 配置缺失、`11` 未登录、`14` 平台限制、`15` 网络异常。

### ② DSL 而不是手写 JSON

FastGPT 的 `nodes` / `edges` 结构有 30 多个 UI 字段，handle 格式、`selectedType`、
`inputs` 数组顺序全都不能错。手写必然失败。

DSL 只写业务语义：

```json
{ "type": "chat", "id": "n_chat",
  "modelId": "<MODEL_OBJECT_ID>",
  "question": "n_start:userChatInput",
  "quoteQA": "n_search:quoteQA" }
```

`wf build` 自动补全字段、算好 handle、推断 `selectedType`、生成布局。

11 类校验会在写入前拦截：节点 ID 重复、缺少开始节点、边不完整、引用无法解析、
handle 格式错、modelId 格式错、多 answer 重复引用、HTTP 字段名、变量引用格式、
工具参数模式、孤立节点。

### ③ 强制停止层

撞上死路后，CLI 写本地阻断状态，后续所有相关命令都返回同一提示：

```bash
$ fastgpt wf build wf.json --dry-run
{"error": {"subtype": "model_id_unavailable", "dead_end": true}}

$ fastgpt app create --name test        # 换命令也没用
{"blocked": true, "error": {"note": "当前环境已进入阻断状态，换命令或改参数都不会有不同结果"}}
```

不给 agent 留"再试一次"的空间。用户完成配置后 `fastgpt model id` 成功即自动解除，24 小时未解除自动失效。

### ④ 成功也带提示

操作成功 ≠ 可以往下走：

```json
{
  "ok": true,
  "appId": "<APP_ID>",
  "_notice": {
    "type": "app_created",
    "message": "应用已创建，但节点为空，此时无法对话",
    "hint": "下一步：写 DSL 后运行 fastgpt wf build <file>",
    "nextCommand": "fastgpt wf get <APP_ID>"
  }
}
```

覆盖 9 种场景：`dry_run_verified` / `training_async` / `empty_result` / `empty_answer` /
`app_created` / `plugin_published` / `not_published` / `collection_permission_disabled` / `low_quota`。

### `wf lint` 与 `wf build --dry-run`

```
wf lint              纯离线语法检查。不需要登录，不验证 ID 真实性。
                     输出 lintOnly: true —— 明确说明只代表"语法对"

wf build --dry-run   必须登录。验证 modelId 存在于当前团队、datasetId 真的存在。
                     输出 dry_run_verified + 下一步提示
```

故意不提供"完全离线也能 build"的路径，避免用占位符产出"看起来成功"的假象。

---

## 环境变量

```bash
FASTGPT_HOME    配置目录，默认 ~/.fastgpt
FASTGPT_BASE    服务地址，覆盖配置文件
FASTGPT_APP_KEY  对话用的 API Key
CHROME_PATH    扫码登录用的浏览器路径
```

---

## 测试

```bash
npm test          # 99 项离线断言，不需要网络和账号
```

---

## 文档

- [`SKILL.md`](./SKILL.md) —— 面向 agent 的完整操作手册
- [`examples/`](./examples) —— 两个可直接部署的 DSL 示例

---

## License

MIT
