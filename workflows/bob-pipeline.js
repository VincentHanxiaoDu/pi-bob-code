// Bob 五站流水线（pi-subagents workflowScript 版）
// 由 pi-bob-code 扩展的 /bob 命令经 workflowScriptPath 加载；args 由主会话侦察后传入：
//   files/srcFiles/testFiles/acs/base 同 Kingo 原版；
//   config: { verifyCommand, scoutAgent, fixerAgent, qaAgent, maxFindings, chunkSize, anchorsPath?, archRules? }
// 沙箱原语：runs.run(key,{agent,task}) / runs.all([{key,agent,task}])；子代理以纯 JSON 文本回包，这里宽松解析。

const files = (args && args.files) || []
const srcFiles = (args && args.srcFiles && args.srcFiles.length ? args.srcFiles : files.filter((f) => f.indexOf('src/') === 0))
const testFiles = (args && args.testFiles && args.testFiles.length ? args.testFiles : files.filter((f) => f.indexOf('test/') === 0))
const acs = (args && args.acs) || []
const base = (args && args.base) || '工作区未提交改动'
const cfg = (args && args.config) || {}
const VERIFY = cfg.verifyCommand || 'npm test'
const SCOUT = cfg.scoutAgent || 'scout'
const FIXER = cfg.fixerAgent || 'worker'
const QA = cfg.qaAgent || 'scout'
const CAP = cfg.maxFindings || 4
const CHUNK = cfg.chunkSize || 3
const REPO = '仓库:' + (cfg.repoPath || '当前工作目录') + '。本次改动基点:' + base + '。'
const RULES = (cfg.archRules ? '架构不变量(违反即 refuted):' + cfg.archRules + '\n' : '') +
  (cfg.anchorsPath ? '先读 ' + cfg.anchorsPath + ' 记下全部锚点行，修复必须逐字保留。\n' : '') +
  '只报工具看不见的:谎言注释、死代码、重复逻辑、误导命名、一个函数干两件事、错误信息撒谎、测试断言弱于承诺。宁缺毋滥。'

// 宽松 JSON 提取：剥 ``` 围栏，取首个平衡的 {} 或 []。子代理不守格式时返回 null（调用方降级）。
function jparse(text, fallback) {
  if (!text) return fallback
  let s = String(text).replace(/```(json)?/g, '').trim()
  const starts = [s.indexOf('{'), s.indexOf('[')].filter((i) => i >= 0)
  if (!starts.length) return fallback
  const open = s[starts[0] === -1 ? s.indexOf('[') : Math.min.apply(null, starts)]
  const close = open === '{' ? '}' : ']'
  const end = s.lastIndexOf(close)
  if (end <= starts[0]) return fallback
  try { return JSON.parse(s.slice(s.indexOf(open), end + 1)) } catch { return fallback }
}

if (files.length === 0) return { note: '无改动文件，流水线未启动' }

const finders = []
if (acs.length) {
  finders.push({ key: 'findAcAudit', prompt: '规格站:本次改动新增/修改了验收承诺:' + acs.join(', ') + '。读 test/acceptance.md 对应行的 Given/When/Then(若有)，再 grep 测试里挂这些标签的用例，逐条判断断言是否真实验证了承诺的每个子句(含失败路径)；标题挂 AC 但断言弱=high。' })
} else if (testFiles.length) {
  finders.push({ key: 'findTestStrength', prompt: '规格站:本次改动了测试 ' + testFiles.join(', ') + '。逐个判断新/改用例:断言是否真实验证被测行为的核心承诺(只查 ok:true、只测 happy path、恒真断言、注释承诺但断言缺失=发现,弱断言=high)。' })
}
if (srcFiles.length <= CHUNK) {
  for (const f of srcFiles) {
    finders.push({ key: 'findClean' + f.split('/').pop().replace(/[^a-zA-Z0-9]/g, ''), prompt: '清洁站:通读 ' + f + ' 全文，重点审查本次改动函数与相邻代码的一致性。透镜:谎言注释、死代码、重复、命名失真、错误信息撒谎。' })
  }
} else {
  for (let i = 0; i < srcFiles.length; i += CHUNK) {
    finders.push({ key: 'findClean' + (i / CHUNK + 1), prompt: '清洁站:通读 ' + srcFiles.slice(i, i + CHUNK).join('、') + ' 的本次改动部分及直接相邻代码。透镜:谎言注释、死代码、重复、命名失真、错误信息撒谎。' })
  }
}
const WRITE_PATH = cfg.writePaths || ['src/api/', 'src/db/', 'src/runner', 'src/executor/', 'src/verifier/']
if (srcFiles.some((f) => WRITE_PATH.some((p) => f.indexOf(p) === 0))) {
  finders.push({ key: 'findHarden', prompt: '硬化站(对抗):审查本次改动的并发/边界/取消/幂等语义:乐观锁窗口、UNIQUE 竞争、事务边界、NULL 谓词、取消信号窗口、幂等键冲突、重入。只报能给出具体触发序列的。' })
}

const found = (await runs.all(finders.map((f) => ({
  key: f.key,
  agent: SCOUT,
  task: '你是只读侦察员:禁止编辑或新建文件，只用 Read/Grep 与 git diff 类只读命令收集证据。' + REPO + RULES + '\n\n' + f.prompt + '\n\n只输出 JSON(不要围栏不要解释):{"findings":[{"file","line","title","evidence"(逐字复制自源码),"why","fix","severity":"high|medium|low"}]}。零发现输出 {"findings":[]}。',
})))).map((r) => jparse(r && r.output, { findings: [] }).findings || []).flat()

if (found.length === 0) return { total: 0, confirmed: [], deferred: [], fix: null, qa: null, note: '零发现，代码未动' }

const seen = new Set()
const deduped = []
for (const f of found) {
  const k = ((f.file || '') + '|' + (f.title || '')).toLowerCase().slice(0, 80)
  if (f.file && f.title && !seen.has(k)) { seen.add(k); deduped.push(f) }
}
const rank = { high: 0, medium: 1, low: 2 }
deduped.sort((a, b) => ((rank[a.severity] ?? 3) - (rank[b.severity] ?? 3)))
const capped = deduped.slice(0, CAP)
const deferred = deduped.slice(CAP)

const verifyResults = await runs.all(capped.map((f, i) => ({
  key: 'verify' + (i + 1),
  agent: SCOUT,
  task: '你是对抗验证者，任务是反驳下面这条代码审查发现，不是同意它。' + REPO + (cfg.anchorsPath ? '先读 ' + cfg.anchorsPath + ' 记下全部锚点行。\n' : '') + '发现:\n' + JSON.stringify(f, null, 1) + '\n反驳清单(任一不过即 real:false):\n1) Grep 验证 evidence 引文逐字存在于该文件，查不到=refuted。\n2) 通读上下文判断 why 是否成立；与本次改动无关的历史问题=refuted。\n3) fix 改动锚点行=refuted。\n4) fix 违反架构不变量=refuted。' + (cfg.archRules ? '不变量:' + cfg.archRules : '') + '\n5) fix 是否真比现状好？为改而改=refuted。\n不确定=real:false。只有你愿为修复结果背书才 real:true，并把 revised_fix 写到精确可执行。\n只输出 JSON:{"real":bool,"reason":"...","revised_fix":"..."}。',
})))

const confirmed = []
for (let i = 0; i < capped.length; i++) {
  const v = jparse(verifyResults[i] && verifyResults[i].output, null)
  if (v && v.real === true) confirmed.push({ f: capped[i], v })
}

if (confirmed.length === 0) return { total: deduped.length, confirmed: [], deferred, fix: null, qa: null, note: '全部发现被怀疑者反驳，代码未动' }

const fixIn = JSON.stringify(confirmed.map((x) => ({
  severity: x.f.severity, file: x.f.file, line: x.f.line, title: x.f.title,
  evidence: x.f.evidence, why: x.f.why, fix: x.v.revised_fix || x.f.fix, verify_reason: x.v.reason,
})), null, 1)
const fixRules = '铁律:1) ' + (cfg.anchorsPath ? '先读 ' + cfg.anchorsPath + '，锚点行逐字保留。\n2) ' : '') + '行为保持不变，除非该发现本身是行为 bug——修 bug 必须同步补强测试断言。\n3) 风格与周围代码一致。\n4) 不要运行任何测试(门禁阶段统一跑)。\n5) 单条修复牵连过大宁可 skipped 并写明原因，不留半成品。'
const fixOut = await runs.run('fix', {
  agent: FIXER,
  task: '你是修复者。' + REPO + '逐条落地以下已确认的审查发现:\n' + fixIn + '\n\n' + fixRules + '\n只输出 JSON:{"applied":[{"file","change"}],"skipped":[{"title","reason"}]}',
})
const fixReport = jparse(fixOut && fixOut.output, { applied: [], skipped: [] })

const qaOnce = () => runs.run('qa', {
  agent: QA,
  task: '你是 QA 门禁。' + REPO + '在仓库根执行: ' + VERIFY + ' 。严禁并发重跑。命令全绿=passed:true;任一红=passed:false，failures 贴关键报错(文件:行)。summary 写:测试数/通过数/typecheck 结果。\n只输出 JSON:{"passed":bool,"summary":"...","failures":"..."}',
})
let qa = jparse((await qaOnce()).output, { passed: false, summary: 'QA 未返回有效 JSON', failures: 'QA 输出不可解析' })
let attempts = 0
while (qa && qa.passed === false && attempts < 2) {
  attempts++
  const repair = await runs.run('repair' + attempts, {
    agent: FIXER,
    task: '你是修复者(门禁修复环，第 ' + attempts + ' 轮)。' + REPO + '此前为落地审查发现改了代码，现在门禁红了:\n' + (qa.failures || qa.summary) + '\n本会话修复明细:\n' + JSON.stringify(fixReport, null, 1) + '\n原始任务:\n' + fixIn + '\n\n' + fixRules + '\n最小改动原则:优先修到绿。\n只输出 JSON:{"applied":[{"file","change"}],"skipped":[{"title","reason"}]}',
  })
  jparse(repair && repair.output, { applied: [], skipped: [] })
  qa = jparse((await qaOnce()).output, qa)
}

return {
  total: deduped.length,
  confirmed: confirmed.map((x) => ({ severity: x.f.severity, file: x.f.file, title: x.f.title })),
  deferred: deferred.map((f) => ({ severity: f.severity, file: f.file, title: f.title })),
  fix: fixReport,
  qa: qa,
  attempts: attempts,
}
