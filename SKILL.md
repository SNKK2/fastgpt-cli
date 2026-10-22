---
name: fastgpt-cli
description: "通过 CLI 管理 FastGPT：创建工作流/Agent、知识库、权限、运行调试。用于用户要求搭建/修改 FastGPT 工作流、配置知识库检索问答、分配知识库或文档权限、调用应用对话、查询模型列表时。所有操作走已验证的 HTTP API，无需浏览器。"
---

# FastGPT CLI

用命令行管理 FastGPT 全部资源。所有命令输出 JSON，错误以非零退出码返回，便于程序化消费。

## 何时使用

- 用户要搭建 / 修改 FastGPT 工作流、Agent
- 要做"意图识别 + 知识库问答 + AI 回复"这类组合链路
- 要管理知识库、文档集合
- 要查 / 改知识库、文档、应用的协作者权限
- 要跑应用对话做验证
- 要查团队可用模型

## 前置：认证

**首次使用或 cookie 失效（7 天）时会自动引导**，任意命令触发：

```
未登录或登录已失效，请选择登录方式：
  1) 账号密码登录
  2) 打开浏览器扫码（微信/企业微信账号）
  3) 手动粘贴 fastgpt_token
```

三种方式也可直接指定：

```bash
# 密码登录
fastgpt auth login --user 138xxxx --pass '明文密码'

# 扫码登录（自动开浏览器 + 抓 httpOnly cookie，最长等 240s）
fastgpt auth scan

# 手动粘贴（扫码后从 F12 复制 fastgpt_token）
fastgpt auth cookie --token 'xxxxx...%3Axxxxx'
```

验证：

```bash
fastgpt auth whoami    # 返回 _id / username / team
```

### agent 调用时的行为

非 TTY 环境（脚本/agent）不会卡在交互提示，直接返回带指引的错误：

```json
{
  "ok": false,
  "error": "未登录或登录已失效。请先执行其中之一：\n  fastgpt auth login --user <账号> --pass <密码>\n  fastgpt auth scan              # 打开浏览器扫码\n  fastgpt auth cookie --token <fastgpt_token>",
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
# 认证
fastgpt auth login --user U --pass P
fastgpt auth cookie --token T
fastgpt auth whoami

# 模型
fastgpt model list --type llm

# 应用
fastgpt app list
fastgpt app create --name "我的工作流" --type advanced
fastgpt app detail <appId>

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

# 权限（permission: 1管理 2写 4读，相加）
fastgpt perm dataset <datasetId>                  # 查
fastgpt perm dataset <datasetId> --set tmbId:6    # 读写
fastgpt perm collection <collectionId>
fastgpt perm app <appId>
fastgpt perm member                                # 取 tmbId

# 运行
fastgpt apikey create --name cli
fastgpt chat run --appId <id> -q "问题" --detail
```

## 工作流 DSL

最小可用示例（意图识别 + 知识库问答 + 闲聊双分支）：

```json
{
  "appId": "<APP_ID>",
  "versionName": "v1",
  "publish": false,
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
