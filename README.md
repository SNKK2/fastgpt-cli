# fastgpt-cli

通过命令行管理 FastGPT 全部资源：工作流、知识库、权限、运行调试。零依赖，Node 18+。

所有命令输出 JSON，错误以非零退出码返回，适合 agent 直接调用。

## 环境自检

```bash
$ fastgpt doctor
{
  "ok": false,
  "ready": false,
  "summary": "还不能建工作流，先解决下面标 ✗ 的项",
  "checks": [
    { "check": "服务地址", "ok": true,  "detail": "https://your-host" },
    { "check": "服务可达", "ok": true,  "detail": "80ms" },
    { "check": "登录状态", "ok": true,  "detail": "138xxxx / team" },
    { "check": "可用模型", "ok": false, "detail": "没有任何应用配置过模型",
      "fix": "在 WebUI 任意应用中拖入「AI 对话」节点并选模型后保存，再运行 fastgpt model id" },
    { "check": "知识库",   "ok": true,  "detail": "1 个" }
  ],
  "next": "在 WebUI 任意应用中拖入「AI 对话」节点并选模型后保存，再运行 fastgpt model id"
}
```

一次看清能不能干活，不用跑到第三步才发现缺东西。

## 错误契约

所有错误都是结构化 JSON，`hint` 就是下一步操作，`action_required` 决定谁来处理：

```json
{ "ok": false, "error": {
    "type": "platform", "subtype": "model_id_unavailable",
    "message": "...", "hint": "...", "next_command": "fastgpt model id",
    "action_required": "user",
    "forbidden": "不要编造 ObjectId" } }
```

## 一句话用法

**工作流用 DSL 描述，不要手写 FastGPT 原始 JSON。**

```bash
# DSL：只写 type + id + 业务参数
{ "type": "chat", "id": "n_chat", "modelId": "<OBJECT_ID>", "question": "n_start:userChatInput" }

# 部署：结构、handle、selectedType 全部自动生成
node bin/fastgpt.mjs wf build my-workflow.json --dry-run   # 先校验
node bin/fastgpt.mjs wf build my-workflow.json             # 再写入
```

手写 `nodeId` / `sourceHandle` / `flowNodeType` 会踩中下文所有坑。
DSL 未覆盖的节点类型用 `"type": "raw"` 传完整 JSON，仍然走校验。

## 为什么需要它

FastGPT 的 API 有一批会静默失败的坑，直接手写 HTTP 几乎必踩：

| 坑 | 后果 | CLI 怎么处理 |
|---|---|---|
| `app/update` / `version/update` 是假保存 | 返回 200 但数据被 strip，拉回是空 | 只用 `version/publish` |
| handle 格式是 `${nodeId}-source-${key}` | 顺序写反 UI 不渲染连线 | `edge()` 自动生成 |
| 引用输入必须 `selectedType: reference` | 否则变量显示空白 | `input()` 自动推断 |
| `modelId` 是 24 位 ObjectId | 传模型名发布失败 | 校验器拦截并警告 |
| 分类分支桩由 `agents` 动态生成 | 手动塞 outputs 反而干扰 | 构造器只保留 cqResult |
| 所有请求要 CSRF 头 | 403 csrf_invalid | client 内置 |

## 安装

```bash
git clone https://github.com/SNKK2/fastgpt-cli.git
cd fastgpt-cli
chmod +x bin/fastgpt.mjs
node bin/fastgpt.mjs init     # 配置地址 + 登录
node bin/fastgpt.mjs doctor   # 环境自检
```

## 安装（其他方式）

```bash
# 作为 skill
cp -r fastgpt-cli ~/.agents/skills/

# 或作为全局命令
cd fastgpt-cli
npm link          # 或 ln -s "$PWD/bin/fastgpt.mjs" /usr/local/bin/fastgpt
```

## 快速开始

```bash
# 1. 初始化：配置服务地址 + 登录（写 ~/.fastgpt/config.json）
fastgpt init

# 非交互环境
fastgpt init --base https://your-host --user <账号> --pass <密码>

# 2. 确认身份
fastgpt auth whoami

# 3. 找模型 ObjectId
fastgpt model id        # 扫描团队应用，自动提取
# 如果返回空，说明团队还没有应用配过模型 → 按提示去 WebUI 点一次模型下拉框

# 某些部署接受模型名（会打印警告）
fastgpt wf build my.json --allow-model-name

# 4. 找知识库 ID
fastgpt ds list

# 5. 建应用
fastgpt app create --name "客户问答" --type advanced
# → {"appId":"..."}

# 6. 写 DSL，先干跑
#    examples/dsl-basic.json          意图识别 + 知识库问答双分支
#    examples/dsl-contract-review.json 文件上传 → 解析 → 合同审查批注（中立第三方视角）
fastgpt wf build my-workflow.json --dry-run

# 7. 正式保存
fastgpt wf build my-workflow.json

# 8. 建 key 并试跑
fastgpt apikey create --name cli
fastgpt chat run --appId <id> -q "你们有什么产品？" --detail
```

## 目录

```
fastgpt-cli/
├── bin/fastgpt.mjs        CLI 入口 + 命令分发
├── lib/
│   ├── client.mjs         HTTP / CSRF / 错误归一
│   ├── auth.mjs           认证引导：密码 / 扫码(CDP) / 粘贴
│   ├── nodes.mjs          节点构造器（9 种节点）
│   └── validate.mjs       连线构造器 + 保存前硬校验
├── examples/
│   ├── dsl-basic.json             意图识别 + 知识库问答双分支
│   └── dsl-contract-review.json   文件解析 → 合同审查 → 批注版输出
├── SKILL.md               agent 使用说明
└── .fastgpt/              凭证（cookies.json / apikey），权限 600
```

## 三层防错

```
构造器（填对）  →  校验器（拦住）  →  保存（写库）
```

**构造器**：`node.chat()` / `node.classify()` 等自动补齐 selectedType、renderTypeList、outputs。

**校验器**：写库前检查 9 类问题，不通过直接退出码 2，绝不写入半成品。

**保存**：只有 `version/publish` 一个入口，避免误用假接口。

校验失败的输出示例：

```json
{
  "ok": false,
  "stage": "validate",
  "errors": [
    "edge[1] 分支 key \"NOT_EXIST\" 不在 agents 中，可用: kb",
    "edge[2] source 不存在: n_missing",
    "n_answer.text 引用了不存在的节点 n_chat"
  ],
  "warnings": [
    "n_classify.modelId=\"Qwen-flash\" 不是 24 位 ObjectId，发布可能报 \"Model model is unavailable\""
  ]
}
```

## DSL 引用简写

```json
"question": "n_start:userChatInput"       → ["n_start","userChatInput"]
"datasets": ["<datasetId>:知识库名"]   → 完整 dataset 对象
```

## 知识库内容

```bash
# 文档
fastgpt ds add-file  <datasetId> ./doc.pdf
fastgpt ds add-batch <datasetId> ./docs --ext pdf,md --concurrency 3
fastgpt ds add-text  <datasetId> --name 标题 --text "内容"
fastgpt ds add-link  <datasetId> https://example.com

# QA 问答对
fastgpt ds add-qa <datasetId> --file qa.json --name "FAQ"

# 验证
fastgpt ds training <collectionId>
fastgpt ds search   <datasetId> "查询词"
```

训练是异步的。`ds training` 会告诉你卡在哪个队列：

```json
{ "pending": { "index": 1 }, "done": false, "hint": "还在训练，检索会返回空，请继续轮询" }
```

`index` 队列没清空时检索一定为空，这是最容易误判的地方。

## 发布渠道

```bash
fastgpt app share create --appId <id> --name "对外分享" --type share
# → <your-fastgpt-host>/chat/share?shareId=xxx   （匿名可访问）

fastgpt app share create --appId <id> --name "嵌入" --type iframe
# → <your-fastgpt-host>/chat/share?shareId=xxx&iframe=true

fastgpt app share create --appId <id> --name "API" --type apikey --qpm 200

fastgpt app share list --appId <id>
fastgpt app share delete <_id>     # 注意是 _id 不是 shareId
```

## 已知限制

- `perm collection` 在部分实例返回 `collectionPermissionDisabled`，需先 `ds perm <id> on` 开启
- `/api/core/workflow/debug` 在部分环境长挂不返回，用 `chat run --detail` 替代
- 批量上传、QA 模式训练尚未封装

## 安全

`.fastgpt/cookies.json` 等同账号权限，有效期 7 天。已加入 `.gitignore`，勿提交。
