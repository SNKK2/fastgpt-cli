# 示例 DSL

两个可直接改用的工作流定义。把占位符替换成你自己的 ID 后即可部署：

```bash
node bin/fastgpt.mjs wf build examples/dsl-basic.json --dry-run   # 先校验
node bin/fastgpt.mjs wf build examples/dsl-basic.json             # 再写入
```

## dsl-basic.json

意图识别分流：

```
流程开始 → 意图识别 ─[知识库问答]→ 知识库搜索 → AI 回复 → 指定回复
                    └[闲聊]      → 闲聊回复   → 闲聊输出
```

需要替换：
- `<YOUR_APP_ID>` 应用 ID（`app create` 返回）
- `<YOUR_LLM_MODEL_OBJECT_ID>` 模型 ObjectId（从已有应用节点里取）
- `<YOUR_DATASET_ID>` 知识库 ID（`ds list` 获取）

## dsl-contract-review.json

合同审查，用户上传文件后自动解析、审查并输出批注版：

```
流程开始(收文件) → 文件解析 → AI 审查+批注 → 内容提取(结构化) → 指定回复
```

需要替换：
- `<YOUR_APP_ID>`
- `<YOUR_LLM_MODEL_OBJECT_ID>`

审查立场为**中立第三方**，同时输出双方影响对比表。如需改成单方委托立场，
修改 `n_review` 节点 prompt 开头的角色描述即可，例如：

```
你是甲方委托的法务顾问，审查重点是该合同对甲方的风险敞口。
```

## 关于 modelId

`modelId` 是 24 位 ObjectId，不是模型名称。获取方式：

```bash
node bin/fastgpt.mjs wf get <任意已有应用ID> | grep -o '"modelId":"[^"]*"'
```

传模型名会在发布时报 `Model model is unavailable`。
