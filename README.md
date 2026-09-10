# pi-bob-code

Bob 五站流水线的 pi 扩展版：**编码改动强制过体检，收工前门禁拦截**。

```
编辑 src/ 落盘 ──→ 埋 bob-pending 标记
收工（agent_settled）──检测到标记──→ 拦停，注入 /bob 指令
/bob 流水线：
  ① 侦察（并行：规格审计 / 清洁透镜 / 硬化站，≤8 路）
  ② 对抗验证（每条发现一个怀疑者，默认反驳，≤4 条存活）
  ③ 修复（单一修复者顺序落地，变异锚点逐字保留）
  ④ 门禁（verifyCommand 全绿，失败进修复环 ≤2 轮）
  ⑤ 汇报 + 独立复核
```

改编自 [Kingo Liang](https://github.com/) 为其 digitaltwin 项目写的 Claude Code bob 套件
（`.claude/hooks` + `/bob` 命令 + 五站 workflow），通用化为 pi 扩展：
仓库路径、门禁命令、子代理、写路径、架构不变量全部抽到 `bob.config.json`。

## 安装

```bash
pi install git:github.com/VincentHanxiaoDu/pi-bob-code
```

或手动克隆后把 `extensions/` 路径加进 `~/.pi/agent/settings.json` 的 `extensions` 数组。

## 配置（可选）

项目根放 `bob.config.json`（或 `.pi/bob.config.json`），全部字段可选：

```json
{
  "srcPaths": ["src/", "lib/"],
  "writePaths": ["src/api/", "src/db/"],
  "verifyCommand": "npm test",
  "scoutAgent": "scout",
  "fixerAgent": "worker",
  "qaAgent": "scout",
  "maxFindings": 4,
  "chunkSize": 3,
  "anchorsPath": "test/mutation.ts",
  "archRules": "tasks/evidence 写只走 src/api/actions.ts；verifier 不得 import runner"
}
```

- `srcPaths`：命中即埋待检标记的路径前缀
- `writePaths`：命中才上"硬化站"（对抗审查最贵，不浪费在文案改动上）
- `verifyCommand`：门禁命令（QA 子代理执行，你也手工复核同一条）
- `anchorsPath`：变异测试锚点文件，存在则修复必须逐字保留锚点行
- `archRules`：架构不变量，违反的发现直接被怀疑者否决

子代理名需与 [pi-subagents](https://github.com/nicobailon/pi-subagents) 里注册的 agent 一致
（默认 `scout` 做侦察/对抗/QA，`worker` 做修复）。

## 命令

| 命令 | 作用 |
|---|---|
| `/bob` | 手动跑五站流水线体检当前改动 |
| `/bob-done` | 清标记，明确豁免本轮体检 |

## 与原版（Claude Code）的差异

| 原版 | 本插件 |
|---|---|
| PostToolUse / Stop hooks（`settings.json`） | `tool_call` / `agent_settled` 事件 |
| `.git/bob-pending` 标记 + bash 脚本 | 同机制，pi 事件驱动，无 bash 依赖 |
| `Workflow` 工具（`agent()`/`parallel()`/`phase()`） | pi-subagents `runs.run`/`runs.all` |
| 结构化输出 schema | 子代理回纯 JSON 文本，流水线宽松解析 |
| 硬编码 digitaltwin 仓库路径/锚点/不变量 | 全部进 `bob.config.json` |

## 已知共存问题

- **pi-multi-account**：切账户会替换会话，旧实例的 `agent_settled` 偶发打印一条 stale 日志。
  属良性竞态：待检标记持久在 `.git/`，新会话的新实例自愈（下次编码改动照常拦截）。
  插件侧已把 stale 降级为静默（`assertActive` 抛错即放弃本轮注入）。

## 设计取舍

- **标记放 `.git/` 内**：不进工作区、不被 git 跟踪（沿用原版纪律）；无 `.git` 时退回 `.pi/`。
- **收工拦截用 `agent_settled` + followUp 注入**而非硬 block：pi 的事件模型里"拦停收工"即
  "再起一轮"，语义一致且不会与 auto-compact/重试打架。
- **30 分钟陈旧豁免**：会话崩溃残留的标记不拦人（沿用原版）。
- **JSON-in-text 而非 schema**：子代理输出解析宽容一层（剥围栏、取平衡块），
  解析失败按"该站零发现/门禁未过"降级，不会误杀。
