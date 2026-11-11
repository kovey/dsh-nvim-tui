#!/usr/bin/env bash
# standards-check.sh — 把结构规范检查变成质量门禁可以直接调用的确定性命令。
#
# `standards_check` 工具回答的是"这次改动有没有引入结构违规"，但质量门禁需要的是
# 一条命令 + 一个退出码。为了让两者永远不会给出不同结论，本脚本**不重新实现规则**，
# 也不重新实现"读规范 / 读基线 / 比较 / 计数"——它调用插件自己导出的同一批函数
# （都在 packages/*/dist，模型层不参与）：
#
#   dsh-eng-core/dist/metrics.js          measureWorkspace（确定性、有上限、不跟随符号链接）
#   dsh-eng-core/dist/rule-mode.js        applyRuleModes（observe 规则只报不阻断）
#   dsh-standards-gate/dist/config.js     standardsFileOf / baselineFileOf（命名空间优先）
#   dsh-standards-gate/dist/tools.js      loadStandards（规范 + rules 模式）、artifactPathOf
#   dsh-standards-gate/dist/baseline.js   readBaseline / compareViolations（棘轮比较）
#   dsh-standards-gate/dist/rule-modes.js 规则模式与"哪些违规才算数"
#
# 为什么必须这样：**平行的第二份判定一定会分叉**。2026-11-11 的一次真实分叉里，
# 会话里的 standards_check 与这条命令给出 574 / 568 两个"已接受"——根因不是比较逻辑
# 写错，而是两者跑在不同构建的引擎上（长驻宿主进程缓存了旧的 dist）。共享同一个函数
# 只能保证"同样的输入同样的结论"；输入（=引擎构建）也要同源，见 docs/ARCHITECTURE.md §5.7.1。
# C17 用一份夹具钉住这条不变量：脚本路径与插件函数路径的三种计数必须相等。
#
# 流程（与 packages/dsh-standards-gate 的 standards_check 逐条对齐）：
#   1. 以**脚本自身位置**推导仓库根（与 scripts/verify.sh 同一写法）：被测工作区就是
#      脚本所在仓库，不存在"在别的目录里跑错了对象"这回事；
#   2. 用插件的 loadStandards 读 <布局根>/standards.json（`.dsh/engineering-suite/`
#      存在时优先；阈值归一化与 rules 模式的告警都只有那一份实现）；
#   3. 用插件的 readBaseline 读 <布局根>/standards-baseline.json——和插件读的是同一对文件；
#   4. measureWorkspace 测量，套用 `rules` 映射（observe 规则只报不阻断）；
#   5. 用插件的 compareViolations 与基线比较：新增或恶化 → 逐条列出（最多 40 条 +
#      "另有 N 条"）并 exit 1；无新增 → 打印摘要并 exit 0。
#   脚本自己只负责"把三者变成人读的输出 + 退出码"，不参与任何判定。
#
# fail closed，绝不 fail open：
#   - 没有 standards.json            → 明确提示先 standards_bootstrap，exit 1（不是"无违规"）；
#   - 没有（或无法解析）基线         → 全部违规按新增计并说明，exit 1：没有棘轮就分不清新债与存量债；
#   - 引擎未构建 / 模块加载失败      → 说明缺什么、怎么构建，exit 1。
# 配置里的 `enforce: warn|off` 只影响插件自己的门禁记录，本脚本**故意不跟随**：质量门禁里
# 标了 required 的命令不能被一个仓库文件改成"只报告"（规则模式 observe 才是那条合法通路）。
#
# usage: bash scripts/standards-check.sh [--quiet]
#   --quiet  只打印摘要与结论（质量门禁跑的就是这一种，输出可被宿主有界截断）
# exit: 0 = 无新增/恶化违规（扫描不完整时按 WARN，仍为 0）；
#       1 = 有新增/恶化违规，或缺规范/基线/引擎（结论是"无法检查"，不是"通过"）；
#       2 = 用法错误
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

QUIET=0
usage() {
  # Print the comment block above, without the `set -euo pipefail` line: the header
  # IS the help text (same rule as verify.sh), so there is no second copy to drift.
  sed -n '2,/^set -euo pipefail$/p' "$0" | sed '$d'
}
for argument in "$@"; do
  case "$argument" in
    -q|--quiet) QUIET=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      printf 'unknown argument: %s\n' "$argument" >&2
      printf 'usage: bash scripts/standards-check.sh [--quiet]\n' >&2
      exit 2
      ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  printf 'standards-check.sh: 找不到 node（本脚本用 dist 里的引擎测量工作区）\n' >&2
  exit 1
fi

# stdin, not a temp file: a temp .mjs would have to be attributed to a path (and the
# gate that guards writes has no business seeing one for a read-only measurement).
node --input-type=module - "$ROOT" "$QUIET" <<'NODE'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** 最多逐条打印多少条违规；其余只报数量。 */
const MAX_ROWS = 40

const root = path.resolve(process.argv[2] ?? '.')
const quiet = process.argv[3] === '1'

const print = (line = '') => {
  process.stdout.write(`${line}\n`)
}
const rel = (file) => {
  const relative = path.relative(root, file)
  return (relative === '' ? '.' : relative).split(path.sep).join('/')
}

/**
 * "无法检查"（缺规范 / 缺基线 / 缺引擎）的失败输出。
 *
 * 与"有违规"分开：前者是配置不完整，结论必须是"无法检查"，不能读成"没有违规"。
 * quiet 模式只留一行，保证质量门禁的输出里仍有一句可读的结论。
 */
const unableToCheck = (quietLine, lines) => {
  if (quiet) {
    print(quietLine)
    return
  }
  for (const line of lines) print(line)
}

/** Engine location: this repository is the consumer, not the suite checkout.
 *  Prefer an explicit DSH_ENGINE_ROOT, then the installed profile's hoisted
 *  engine packages, then the suite-repo layout for self-tests. Every candidate
 *  must actually contain the compiled engine — naming a path that does not is
 *  the same "cannot check" condition as a missing dist. */
const candidates = [
  process.env.DSH_ENGINE_ROOT,
  path.join(process.env.HOME ?? '', '.dsh/profiles/tui/node_modules'),
  path.join(process.env.HOME ?? '', '.dsh/profiles/nvim-tui/node_modules'),
  path.join(process.env.HOME ?? '', '.dsh/profiles/node_modules'),
  path.join(root, 'packages'),
].filter((candidate) => typeof candidate === 'string' && candidate !== '')
const packages = candidates.find((candidate) =>
  fs.existsSync(path.join(candidate, 'dsh-eng-core/dist/metrics.js')) &&
  fs.existsSync(path.join(candidate, 'dsh-standards-gate/dist/config.js')),
) ?? path.join(root, 'packages')
const entryOf = (pkg, file) => path.join(packages, pkg, 'dist', file)
const ENTRIES = [
  ['dsh-eng-core', 'metrics.js'],
  ['dsh-eng-core', 'paths.js'],
  ['dsh-eng-core', 'rule-mode.js'],
  ['dsh-standards-gate', 'config.js'],
  ['dsh-standards-gate', 'baseline.js'],
  ['dsh-standards-gate', 'rule-modes.js'],
  ['dsh-standards-gate', 'tools.js'],
  ['dsh-standards-gate', 'index.js'],
]
const label = ([pkg, file]) => `packages/${pkg}/dist/${file}`

const loadEngine = async () => {
  const load = async (pkg, file) => import(pathToFileURL(entryOf(pkg, file)).href)
  return {
    metrics: await load('dsh-eng-core', 'metrics.js'),
    paths: await load('dsh-eng-core', 'paths.js'),
    ruleMode: await load('dsh-eng-core', 'rule-mode.js'),
    config: await load('dsh-standards-gate', 'config.js'),
    baseline: await load('dsh-standards-gate', 'baseline.js'),
    ruleModes: await load('dsh-standards-gate', 'rule-modes.js'),
    tools: await load('dsh-standards-gate', 'tools.js'),
    plugin: await load('dsh-standards-gate', 'index.js'),
  }
}

async function main() {
  const missing = ENTRIES.filter(([pkg, file]) => !fs.existsSync(entryOf(pkg, file)))
  if (missing.length > 0) {
    unableToCheck(`结构规范检查：无法检查 — 引擎未构建（缺 ${missing.map(label).join('、')}）`, [
      '## 结构规范检查（dsh-standards-gate）— 无法检查（引擎未构建）',
      `缺少：${missing.map(label).join('、')}`,
      '',
      '本脚本不重新实现规则，它调用本套件自己的引擎：dsh-eng-core 的 measureWorkspace，',
      'dsh-standards-gate 的基线与规则模式。所以必须先构建：`bash scripts/build-all.sh`',
      '（`bash scripts/verify.sh` 也会先构建）。在引擎存在之前，结论只能是"无法检查"，不是"没有违规"。',
    ])
    return 1
  }

  let engine
  try {
    engine = await loadEngine()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    unableToCheck(`结构规范检查：无法检查 — 引擎模块加载失败（${reason}）`, [
      '## 结构规范检查（dsh-standards-gate）— 无法检查（引擎模块加载失败）',
      reason,
      '',
      '先构建并链接依赖：`bash scripts/build-all.sh`（依赖链接见 scripts/link-deps.sh），',
      '再重跑本脚本。加载失败时不能给出任何违规结论。',
    ])
    return 1
  }

  const { measureWorkspace } = engine.metrics
  const { resolveLayout } = engine.paths
  const { applyRuleModes } = engine.ruleMode
  const { resolveConfig, standardsFileOf, baselineFileOf } = engine.config
  const { readBaseline, compareViolations } = engine.baseline
  const {
    configuredRuleIds,
    enforcingViolations,
    isObserve,
    renderObservations,
    ruleModeRules,
    ruleVerdicts,
  } = engine.ruleModes
  // 插件自己的规范读取与路径解析：阈值归一化、rules 模式、产物路径只有一份实现。
  const { artifactPathOf, loadStandards } = engine.tools
  const { resolveEffectiveConfig } = engine.plugin

  // 与插件同一条配置解析路径：profile 是上限，仓库的 <布局根>/standards-gate.json
  // 只能细化被允许的键（否则本命令会和 standards_check 读到不同的文件）。
  const configProblems = []
  const effective = resolveEffectiveConfig(resolveConfig({}), resolveLayout(root, {}), {
    warn: (message) => configProblems.push(message),
  })
  const config = effective.config

  // --- 规范文件与规则模式（插件同源：loadStandards） --------------------------
  // 解析、阈值归一化、`rules` 模式的合法性告警都由插件的 loadStandards 决定：脚本
  // 不再拼第二份 standards 对象（以前那 70 行就是分叉的温床）。脚本只保留"无法检查"
  // 的诊断文案——质量门禁的输出里必须能读出为什么不能检查，而插件的 problem 只有一句。
  const standardsRel = standardsFileOf(root, config)
  const standardsPath = artifactPathOf(root, standardsRel)
  const loaded = loadStandards(root, standardsRel)
  if (loaded.standards === undefined) {
    const exists = fs.existsSync(standardsPath)
    const incomplete = (loaded.problem ?? '').includes('languages')
    if (!exists) {
      unableToCheck(
        `结构规范检查：无法检查 — 没有 ${rel(standardsPath)}（下一步：standards_bootstrap({ action: "measure" }) → freeze，需人工批准）`,
        [
          '## 结构规范检查（dsh-standards-gate）— 无法检查（没有规范文件）',
          '',
          `没有找到结构规范文件：${standardsPath}`,
          '',
          '规范由目标仓库自己拥有，本脚本不会替你猜阈值。下一步（任选其一）：',
          '  1. 会话里运行 `standards_bootstrap({ action: "measure" })` 看现状与建议阈值，',
          '     确认后 `standards_bootstrap({ action: "freeze" })` 写进仓库（需要人工批准）；',
          '  2. 或由人手工创建（形如 { "languages": { "ts": { "maxFileLines": 300 } } }）。',
          '',
          '在规范出现之前，结论只能是"无法检查"，不是"没有违规"。',
        ],
      )
    } else if (incomplete) {
      unableToCheck(`结构规范检查：无法检查 — ${rel(standardsPath)} 缺少 languages 段`, [
        '## 结构规范检查（dsh-standards-gate）— 无法检查（规范文件不完整）',
        '',
        `${standardsPath} 缺少 languages 段（形如 { "languages": { "ts": { "maxFileLines": 300 } } }）。`,
        '',
        '下一步：`standards_bootstrap({ action: "measure" })` 看建议值，确认后 `freeze`（需要人工批准）。',
      ])
    } else {
      // 文件在、但插件读不出来（绝大多数是 JSON 坏了）：把插件的原话带出来。
      unableToCheck(`结构规范检查：无法检查 — ${rel(standardsPath)} 不是合法 JSON`, [
        '## 结构规范检查（dsh-standards-gate）— 无法检查（规范文件损坏）',
        '',
        `${standardsPath} 不是合法 JSON（${loaded.problem ?? '无法解析'}）。`,
        '',
        '修好它，或用 `standards_bootstrap({ action: "freeze" })` 重写（需要人工批准）。',
        '在此之前，结论只能是"无法检查"，不是"没有违规"。',
      ])
    }
    return 1
  }
  const standards = loaded.standards
  const modes = loaded.modes

  // --- 测量 -------------------------------------------------------------------
  const result = measureWorkspace({
    cwd: root,
    standards,
    maxFiles: config.maxFiles,
    maxFileBytes: config.maxFileBytes,
  })

  // --- 基线（棘轮） -----------------------------------------------------------
  const baselinePath = artifactPathOf(root, baselineFileOf(root, config))
  const baselineExists = fs.existsSync(baselinePath)
  const baseline = baselineExists ? readBaseline(baselinePath) : undefined
  const baselineUnreadable = baselineExists && baseline === undefined
  const comparison = compareViolations(result.violations, baseline)
  const baselineMissing = comparison.present === false

  const configured = configuredRuleIds(standards, modes)
  const folded = applyRuleModes(ruleModeRules(configured, modes), ruleVerdicts(comparison, configured))
  const enforcingAdded = enforcingViolations(comparison.added, modes)
  const enforcingWorsened = enforcingViolations(comparison.worsened, modes)
  const failed = enforcingAdded.length + enforcingWorsened.length
  const shadow = comparison.added.length + comparison.worsened.length - failed
  const truncated = result.stats.truncated === true
  const accepted = comparison.known.length
  const verdict = baselineMissing ? 'BLOCK（基线缺失）' : failed > 0 ? 'BLOCK' : truncated ? 'WARN' : 'PASS'

  let reason
  if (baselineMissing) {
    reason =
      `没有基线，全部按新增计（${comparison.added.length} 项）——` +
      '没有棘轮就无法区分新债与存量债，按失败处理（fail closed）'
  } else if (failed > 0) {
    reason = `新增 ${enforcingAdded.length} 项、恶化 ${enforcingWorsened.length} 项规范违规（基线已接受 ${accepted} 项）`
  } else if (shadow > 0) {
    reason = `无新增/恶化违规；${shadow} 项来自 observe 规则（只记录，不计入裁决）`
  } else if (truncated) {
    reason = `无新增/恶化违规，但本次扫描达到文件上限（${config.maxFiles}）：覆盖面不完整（WARN，不阻断）`
  } else {
    reason = `无新增/恶化违规（基线已接受 ${accepted} 项，本次扫描 ${result.stats.filesScanned} 个文件）`
  }
  const exitCode = baselineMissing || failed > 0 ? 1 : 0

  // 两个结论方向必须由不同的条件决定，绝不由"输出是否好看"决定：
  // 有新增/恶化（enforcing）或缺基线 ⇒ 非 0；否则 0（扫描不完整也只是 WARN）。
  const problems = [...configProblems, ...loaded.problems, ...folded.problems]
  for (const problem of problems) print(`配置问题：${problem}`)

  if (quiet) {
    print(`结构规范检查：${verdict} — ${reason}`)
    if (!baselineMissing && exitCode !== 0) {
      print('逐条列表：bash scripts/standards-check.sh（不带 --quiet）')
    }
    if (baselineMissing) {
      print('下一步（需人工批准）：会话里 `standards_check({ accept: true, note: "存量债务" })` 冻结基线')
    }
    if (truncated) {
      print(`注意：扫描达到文件上限（${config.maxFiles}），"无新增"可能只是没扫到`)
    }
    return exitCode
  }

  const languages = Object.entries(result.stats.languages)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([language, count]) => `${language} ${count}`)
    .join('、')
  print(`## 结构规范检查（dsh-standards-gate）— ${verdict}`)
  print('')
  print(`工作区：${root}`)
  print(`规范  ：${rel(standardsPath)}`)
  print(
    `基线  ：${
      baselineMissing
        ? `${rel(baselinePath)}（**缺失**${baselineUnreadable ? '：文件存在但无法解析' : ''}；没有基线，全部按新增计）`
        : `${rel(baselinePath)}（已接受 ${accepted} 项）`
    }`,
  )
  print(
    `扫描  ：${result.stats.filesScanned} 个文件（豁免 ${result.stats.exempted} 个` +
      `${truncated ? `；**已达上限 ${config.maxFiles}，结论不完整**` : ''}）` +
      `${languages === '' ? '' : `；语言：${languages}`}`,
  )
  print(`结论  ：${reason}`)
  if (config.enforce !== 'gate') {
    // 说清楚为什么不跟随：否则一个 enforce=warn 的仓库会以为这条命令也该放行。
    print(
      `注意  ：仓库的 enforce=${config.enforce} 只作用于插件门禁记录；本命令是质量门禁里的棘轮，` +
        '有新增/恶化即失败（要"只报告"请把规则改成 observe）。',
    )
  }

  const shadowLines = renderObservations(folded.observations, folded.effective.state, rel(standardsPath))
  if (shadowLines.length > 0) {
    print('')
    for (const line of shadowLines) print(line)
  }

  // 逐条列表：新增在前、恶化在后；每行都标出规则类别与"影子"身份，读的人不用猜
  // 哪一条才真正让门禁失败。
  const rows = [
    ...comparison.added.map((violation) => ({ kind: '新增', violation })),
    ...comparison.worsened.map((violation) => ({ kind: '恶化', violation })),
  ]
  if (rows.length > 0) {
    const shown = rows.slice(0, MAX_ROWS)
    print('')
    print(
      `### 违规明细（新增 ${comparison.added.length} 项 / 恶化 ${comparison.worsened.length} 项` +
        `${shadow === 0 ? '' : `；其中 ${shadow} 项来自 observe 规则，只记录`}）`,
    )
    print('')
    for (const row of shown) {
      const observe = isObserve(modes, row.violation.rule) ? '·影子 would=BLOCK，不阻断' : ''
      print(`- [${row.kind}${observe}] ${row.violation.detail}`)
    }
    const rest = rows.length - shown.length
    if (rest > 0) {
      print(`- …另有 ${rest} 条（本脚本最多列 ${MAX_ROWS} 条；完整清单见会话里的 standards_check 度量明细）`)
    }
  }

  if (baselineMissing) {
    print('')
    print('### 没有基线（fail closed）')
    print('')
    print('- 基线缺失 = 没有棘轮：静默通过等于把仓库里所有违规合法化，所以本次按失败处理；')
    print(
      `- 下一步（需要人）：会话里运行 \`standards_check({ accept: true, note: "存量债务" })\`，` +
        `把当前 ${comparison.added.length} 项冻结进基线（**人工批准**后才会写入）；`,
    )
    print('- 之后只挡新增/恶化；改代码消除的违规会在下一次 accept 后从基线里收紧。')
  } else if (failed > 0) {
    print('')
    print('### 怎么办')
    print('')
    print('1. 优先改代码：拆文件/拆函数（早返回替代深层嵌套）、抽掉超长 if 分支、收敛导出面、修正依赖方向；')
    print(
      `2. 确有理由（表格型代码、生成代码、大 switch）→ 由人在 \`${rel(standardsPath)}\` 的 \`exempt\` 里排除，` +
        '或按语言/目录放宽阈值；',
    )
    print('3. 存量债务确实要带着走 → 会话里 `standards_check({ accept: true, note: "原因" })`：写入基线需要**人工批准**；')
    print('   本脚本只读：它不改阈值、不改基线，也不碰 `.dsh/**`（信任根）。')
    print('')
    print('（`observe` 规则的新增/恶化只记录、不阻断——要真正拦住它们，由人在规范文件的 `rules` 里改成 `enforce`。）')
  }

  if (truncated && failed === 0 && !baselineMissing) {
    print('')
    print(`注意：扫描达到文件上限（${config.maxFiles}），"无新增"可能只是没扫到——结论按 WARN 处理，不阻断。`)
  }

  return exitCode
}

process.exitCode = await main()
NODE
