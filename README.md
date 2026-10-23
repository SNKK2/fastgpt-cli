# fastgpt-cli

> 用命令行管理 FastGPT 的全部资源 —— 工作流、知识库、权限、发布渠道、运行调试。
> 为 **AI agent 设计**：每次输出都是 JSON，每条报错都是下一步的操作手册。

```bash
npm install -g github:SNKK2/fastgpt-cli
fastgpt init --preset cn
```

零依赖 · Node 18+ · 45 个命令 · 28 种语义化错误 · 99 项离线测试

---

## 为什么需要它

FastGPT 的 OpenAPI **只能管理知识库**，工作流、应用配置、权限、发布渠道全都没有公开接口。
想自动化只能逆向内部 API —— 而内部 API 有一堆静默陷阱：

| 你写的 | 实际结果 |
|---|---|
| `POST /api/core/app/update` | 返回 200，但 nodes 被静默 strip |
| `PUT /api/core/app/version/update` | 返回 200，但只改了 versionName |
| `system_httpHeaders` | 字段被丢弃，HTTP 节点永远收不到头 |
| 工具参数用 `input` 模式 | agent 传参永远是空字符串 |
| `{{$pluginInput.xxx$}}` | 变量引用不生效，必须用实际 nodeId |

**这个 CLI 把这些坑固化进了构造器和校验器** —— 你不可能写出会踩坑的 JSON。

---

## 30 秒上手

```bash
# 1. 配置 + 登录（预设：cn / global / local / private）
fastgpt init --preset cn

# 2. 环境自检 —— 告诉你现在能做什么，不能做什么
fastgpt doctor

# 3. 拿模型 ObjectId
fastgpt model id

# 4. 建应用
fastgpt app create --name "智能客服" --type advanced
# → {"appId":"<APP_ID>"}

# 5. 写 DSL，部署
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

fastgpt wf build wf.json --dry-run   # 先验证 modelId / datasetId 都是真的
fastgpt wf build wf.json             # 部署并发布

# 6. 建 key 试跑
fastgpt apikey create --name cli
fastgpt chat run --appId <APP_ID> -q "你好"
```

---

## 三个核心设计

### ① 错误就是操作手册

agent 不会读文档。所以每条报错都自带：

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
    "hint": "这不是 CLI 的校验策略，是 FastGPT 平台的硬限制。\n\n⚠️ 这条路没有替代走法：\n  · 修改 CLI 源码去掉校验 → 服务端仍会拒绝\n  · 直接调 API 传模型名 → 同样失败\n  · 编造 24 位 hex → 发布时一定报错\n\n唯一出路是让用户在 WebUI 配一次模型：\n  1. 打开任意应用 → 2. 拖入「AI 对话」节点 → 3. 选模型 → 4. 保存\n\n👉 把这条消息原样发给用户，然后结束本轮。",
    "forbidden": "不要修改 CLI 源码、不要直接调 API 绕过、不要编造 ObjectId、不要换命令重试",
    "resolved_by": "用户在 WebUI 配置模型后运行 fastgpt model id"
  }
}
```

四个字段各司其职：

| 字段 | 作用 |
|---|---|
| `action_required` | `self` = 自己能解决，`user` = 必须问人，`none` = 无能为力 |
| `dead_end` | `true` = 这条路走不通，不是可重试的失败 |
| `must_end_turn` | `true` = 立即结束本轮，别试别的 |
| `forbidden` | 明确列出所有"看起来能绕过但实际没用"的做法 |

### ② DSL 而不是手写 JSON

手写 `nodes` / `edges` 一定会错 —— handle 格式要 `nodeId-source-right`，
`selectedType` 要跟 `value` 的类型匹配，`inputs` 是数组不是对象。

DSL 只写业务语义：

```json
{
  "type": "chat",
  "id": "n_chat",
  "modelId": "<MODEL_OBJECT_ID>",
  "question": "n_start:userChatInput",
  "quoteQA": "n_search:quoteQA"
}
```

`wf build` 自动补全 30+ 个 UI 字段、算好 handle、推断 `selectedType`、生成 `position`。

DSL 未覆盖的节点类型用 `raw` 兜底，仍然走全部校验 —— 不会因为"DSL 不支持"就绕开 CLI。

### ③ 强制停止层

撞上死路后，CLI 写本地阻断状态，**后续所有相关命令直接返回同一提示**：

```bash
$ fastgpt wf build wf.json --dry-run
{"error": {"subtype": "model_id_unavailable", "dead_end": true}}
→ 写入 ~/.fastgpt/blocked.json

$ fastgpt wf build wf.json --dry-run      # 换参数
$ fastgpt app create --name test          # 换命令
{"blocked": true, "error": {"note": "当前环境已进入阻断状态，换命令或改参数都不会有不同结果"}}
```

不给 agent 留"再试一次"的空间。用户完成配置后 `fastgpt model id` 成功即自动解除。

---

## 命令一览

<details>
<summary><b>45 个命令，覆盖全生命周期</b></summary>

| 组 | 命令 | 说明 |
|---|---|---|
| `init` | 1 | 配置服务地址 + 登录 |
| `doctor` | 1 | 环境自检（地址/登录/模型/权限） |
| `info` | 3 | 环境快照，含语义化 `can` 能力字段 |
| `auth` | 5 | 密码登录、扫码登录（split-flow）、状态、登出 |
| `model` | 2 | 提取真实 modelId、列出模型 |
| `app` | 6 | 创建、列表、详情、更新、删除、复制 |
| `wf` | 5 | `build` / `lint` / `get` / `validate` / `publish` |
| `ds` | 16 | 知识库、集合、文档、QA、训练、检索、权限 |
| `perm` | 4 | 成员、权限、协作者 |
| `chat` | 1 | 运行对话（SSE 流式，支持 `--detail` 看节点轨迹） |
| `apikey` | 1 | 创建 API Key |

</details>

### `wf lint` 与 `wf build --dry-run` 的区别

```
wf lint              纯离线语法检查。不需要登录，不验证 ID 真实性。
                     输出 lintOnly: true —— 明确告诉你这只代表"语法对"

wf build --dry-run   必须登录。验证 modelId 存在于当前团队、datasetId 真的存在。
                     输出 dry_run_verified + 下一步提示
```

**故意不提供"完全离线也能 build"的路径** —— 那只会让 agent 用占位符产出"看起来成功"的假象。

---

## `doctor` / `info` 会告诉你现在能做什么

```bash
$ fastgpt info
```

```
  FastGPT 环境
  ──────────────────────────────────────────────
  用户      user_xxxxx
  团队      你的团队
  身份      可写成员
  积分      剩余 925,978 / 共 2,169,999

  资源
  ──────────────────────────────────────────────
  工作流    23 个（其中高级编排 18）
  知识库    5 个（另有 4 个文件夹）
  模型      31 个 LLM，7 个向量模型

  能力
  ──────────────────────────────────────────────
  ✓ 创建 / 编辑工作流
  ✓ 创建知识库
  ✗ 管理成员与权限
```

`can` 字段是语义化的 —— agent 不用自己推断权限，直接看布尔值。

---

## 成功响应也带提示

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

9 种场景：`dry_run_verified` / `training_async` / `empty_result` / `empty_answer` /
`app_created` / `plugin_published` / `not_published` / `collection_permission_disabled` / `low_quota`

---

## 踩过的坑，都固化在代码里

| 坑 | 现象 | 固化位置 |
|---|---|---|
| `app/update` 假保存 | 200 但 nodes 被 strip | `wf build` 只走 `version/publish` |
| HTTP 头字段名 | `system_httpHeaders` 被静默丢弃 | `node.http()` 用 `system_httpHeader` |
| 工具参数模式 | `input` 模式 agent 传参永远空 | `node.pluginModule()` 强制 `agentGenerated` |
| 工具挂载方式 | `agent` + `selectedTools` 发布报 `appUnExist` | 校验器强制 `pluginModule` + `selectedTools` 边 |
| 变量引用格式 | `{{$pluginInput.xxx$}}` 不生效 | `VARP(nodeId, outputId)` 用实际 nodeId |
| chat 节点参数 | 带 `maxToken: ''` 导致输出被截断到 1 字 | 构造器不生成这两个字段 |
| handle 顺序 | `n_a-kb-source-right` UI 不渲染 | `edge()` 自动算 `nodeId-source-{key}` |
| 多 answer 引用 | 同一输出被多处引用会重复回复 | 校验器报 error / warning |

---

## 测试

```bash
npm test          # 99 项离线断言，不需要网络和账号
```

覆盖：错误契约结构、强制停止层、DSL 构建、校验规则、handle 生成、域名纠错、`_notice` 语义。

---

## 文档

- [`SKILL.md`](./SKILL.md) —— 面向 agent 的完整操作手册（节点构造器、DSL 语法、故障排查表）
- [`examples/`](./examples) —— 两个可直接部署的 DSL 示例

---

## 安全

- 凭证存在 `~/.fastgpt/`，`600` 权限
- 不记录、不上传任何 token
- 扫码登录走本地 CDP，不经过第三方

---

## License

MIT
