// pi-bob-code：Bob 五站流水线（侦察 → 对抗验证 → 修复 → 门禁）的 pi 扩展
// 改编自 Kingo digitaltwin 项目的 .claude bob 套件，通用化：仓库路径/命令/代理均可由 bob.config.json 配置。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EDIT_TOOLS = new Set(["write", "edit", "apply_patch", "multiedit"]);
const STALE_MS = 30 * 60 * 1000;

type BobConfig = {
  srcPaths: string[];        // 视为"源码"的路径前缀，碰到即埋 pending 标记
  verifyCommand: string;     // 门禁命令（QA 站与人工复核都用它）
  scoutAgent: string;        // 侦察/对抗验证子代理
  fixerAgent: string;        // 修复者子代理（需要写权限）
  qaAgent: string;           // 门禁子代理（需要 bash）
  maxFindings: number;       // 进入对抗验证的发现上限
  chunkSize: number;         // 清洁站每路通读的文件数
  anchorsPath?: string;      // 变异锚点文件（存在则修复必须逐字保留）
  archRules?: string;        // 架构不变量（写进验证/修复的铁律）
  extraWriteTools?: string[];// 额外视为写文件的工具名
};

const DEFAULTS: BobConfig = {
  srcPaths: ["src/", "lib/", "app/"],
  verifyCommand: "npm test",
  scoutAgent: "scout",
  fixerAgent: "worker",
  qaAgent: "scout",
  maxFindings: 4,
  chunkSize: 3,
};

function loadConfig(cwd: string): BobConfig {
  const cfg: Partial<BobConfig> = {};
  for (const p of [join(cwd, "bob.config.json"), join(cwd, ".pi", "bob.config.json")]) {
    if (existsSync(p)) {
      try { Object.assign(cfg, JSON.parse(readFileSync(p, "utf8"))); break; } catch { /* 坏配置就用默认 */ }
    }
  }
  return { ...DEFAULTS, ...cfg };
}

function markerPath(cwd: string, name: string): string {
  // 标记放 .git/ 内：不进工作区、不被 git 跟踪；无 .git 时退回 .pi/
  const dir = existsSync(join(cwd, ".git")) ? join(cwd, ".git") : join(cwd, ".pi");
  return join(dir, name);
}

function markPending(cwd: string) {
  try { writeFileSync(markerPath(cwd, "bob-pending"), String(Date.now())); } catch { /* 只读盘等极端情况静默 */ }
}

function pendingState(cwd: string): "none" | "pending" | "running" {
  const runningP = markerPath(cwd, "bob-running");
  try {
    if (existsSync(runningP)) {
      const mtime = Number(readFileSync(runningP, "utf8")) || 0;
      if (Date.now() - mtime < STALE_MS) return "running"; // 流水线在跑，放行收工
    }
  } catch { /* fallthrough */ }
  return existsSync(markerPath(cwd, "bob-pending")) ? "pending" : "none";
}

function clearMarkers(cwd: string) {
  for (const n of ["bob-pending", "bob-running"]) {
    try { unlinkSync(markerPath(cwd, n)); } catch { /* 不存在即目标态 */ }
  }
}

function touchesWatchedPath(cfg: BobConfig, p: string): boolean {
  if (!p) return false;
  return cfg.srcPaths.some((pre) => p.startsWith(pre)) || p.includes("/test/");
}

function workflowFilePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "workflows", "bob-pipeline.js");
}

const BOB_PROMPT = (wf: string, verify: string) => `对当前编码改动跑 bob 五站流水线。按序执行：

1. 侦察（inline，自己动手，不 spawn）：\`git status --short\` + \`git diff --stat HEAD\`（含已暂存）得到改动文件；工作区干净时改用 \`git diff --name-only \$(git merge-base HEAD main)\` 看未体检的提交，基点写进 base。从改动测试标题提取 AC 标签（正则 AC-\\d+）填入 acs，没有则空数组。降级判定：凡本轮编辑过 src/ 一律走流水线；仅纯文档/配置且 ≤2 文件可降级为直接跑 \`${verify}\` 并汇报即止。
2. 启动流水线：先 \`touch .git/bob-running\`（30 分钟自动视为陈旧），然后调用 subagent 工具：workflowScriptPath: "${wf}"，args: { files, srcFiles, testFiles, acs, base }。流水线运行期间同步等待，不要空收工。
3. 汇报：确认了什么/反驳了什么/修了什么/门禁结果（表格），deferred 发现按严重度列出。
4. 独立复核：自己重跑一遍 \`${verify}\`（与流水线 QA 互为第二票），一致才可信。
5. 收尾：删除 .git/bob-pending 与 .git/bob-running，再收工。`;

export default function (pi: ExtensionAPI) {
  let cwdCache = "";

  const cfgFor = (ctx: any): BobConfig => loadConfig(ctx.cwd || cwdCache || process.cwd());

  // ① 写工具落盘即埋标记（替代 Claude Code 的 PostToolUse hook）
  pi.on("tool_call", async (event, ctx) => {
    cwdCache = ctx.cwd || cwdCache;
    if (!EDIT_TOOLS.has(event.toolName) && !(cfgFor(ctx).extraWriteTools ?? []).includes(event.toolName)) return;
    const input: any = event.input ?? {};
    const p: string = input.file_path ?? input.path ?? input.filePath ?? "";
    if (touchesWatchedPath(cfgFor(ctx), p)) markPending(ctx.cwd || process.cwd());
    return; // 不拦截，只记录
  });

  // ② 收工拦截：有未体检改动 → 注入 /bob 指令（替代 Stop hook 的 block）
  pi.on("agent_settled", async (_event, ctx) => {
    const cwd = ctx.cwd || cwdCache || process.cwd();
    if (pendingState(cwd) !== "pending") return;
    const cfg = cfgFor(ctx);
    await pi.sendUserMessage(
      `收工被 bob 门禁拦下：工作区有未体检的编码改动（本轮编辑过 ${cfg.srcPaths.join(" 或 ")}）。不得以死代码/无行为变更为由跳过。\n\n` +
      BOB_PROMPT(workflowFilePath(), cfg.verifyCommand),
      { deliverAs: "followUp", triggerTurn: true } as any,
    );
  });

  // ③ /bob 命令：手动触发体检
  pi.registerCommand("bob", {
    description: "Bob 五站流水线体检当前编码改动（侦察→对抗验证→修复→门禁）",
    handler: async (_args, ctx) => {
      const cfg = cfgFor(ctx);
      await pi.sendUserMessage(BOB_PROMPT(workflowFilePath(), cfg.verifyCommand), {
        deliverAs: "followUp",
        triggerTurn: true,
      } as any);
    },
  });

  // ④ 逃生舱：跳过门禁清标记（用户明确豁免时用）
  pi.registerCommand("bob-done", {
    description: "清掉 bob-pending/bob-running 标记（明确豁免本轮体检）",
    handler: async (_args, ctx) => {
      clearMarkers(ctx.cwd || process.cwd());
      await pi.sendUserMessage("bob 标记已清除，本轮体检豁免。", { triggerTurn: true } as any);
    },
  });
}
