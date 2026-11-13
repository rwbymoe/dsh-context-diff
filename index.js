/**
 * dsh-context-diff —— 让 AGENTS.md 的变更只注入差异，而不是整份重贴。
 *
 * ## 问题
 *
 * DSH 的 `dsh-agent-instructions` 在指令文件变化时，每次都把**整份内容**重贴进
 * 上下文，同时加一句「用这份替换之前加载的」。实测代价：一次压缩之后累积 37 次
 * 注入、约 955 KB，其中 36 份已被后续版本作废，但仍占着上下文。
 *
 * ## 做法
 *
 * 在 `llm/stream` 上，把「还没发过的那一条」注入消息的正文换成行级 diff。
 * **不改宿主，不改会话记录，只改这一次请求的内容。**
 *
 * ## 三条硬约束
 *
 * 1. **不改任何历史** —— 只改最后一条 agent-instructions，且同一条只改一次。
 * 2. **首次 / 压缩后是全量** —— 没有 baseline 可比时原样放行；压缩会重建上下文，
 *    此时清空 baseline，下一条重新以全量为基准。
 * 3. **fail-open** —— 任何异常都原样放行，并把错误打到 logger.error 与 console.error。
 *    宁可多花 token，也不让读到的规矩是错的。
 *
 * ## 只读，不写
 *
 * **这个插件不写任何文件。** 它读取指令文件是为了拿到正文做 diff；除此之外
 * 不落盘、不改会话记录、不碰缓存文件、不写诊断日志。
 *
 * 诊断走宿主 logger（`ctx.logger`）。要更详细的逐次记录，设环境变量
 * `DSH_CONTEXT_DIFF_DEBUG=1` —— 那时也只走 logger，仍然不写文件。
 *
 * ## 依赖
 *
 * 零运行时依赖。diff 用内置的 Myers 算法（见 `diffLines`）。
 *
 * @license MIT
 */
import os from 'node:os'
import path from 'node:path'

/** 版本戳，便于确认运行的是哪份代码。 */
export const BUILD = '2026-11-13T04:00+08:00 · context-diff · Myers + 零依赖 + fail-open + read-only'

export const name = 'dsh-context-diff'
export const inject = []

/** 每处变更前后各带几行作锚点。 */
const CTX = 3

/**
 * 是否输出逐次诊断。
 *
 * **默认静默。** 只有设了 `DSH_CONTEXT_DIFF_DEBUG=1` 才往宿主 logger 写每次
 * BASELINE / DIFF / SKIP —— 仍然**不写任何文件**。
 *
 * 判据：常驻路径上不该有磁盘 I/O，也不该每次请求都往日志刷一行。
 *
 * @returns {boolean}
 */
const debugOn = () => process.env.DSH_CONTEXT_DIFF_DEBUG === '1'

/**
 * 报错必须显眼：info 级会淹没在宿主日志里。
 *
 * ⚠️ 只走 logger，不落盘。
 *
 * @param {object} ctx
 * @param {string} msg
 */
const shout = (ctx, msg) => {
  try { ctx.logger?.error?.(`[context-diff] ${msg}`) } catch { /* 忽略 */ }
  try { console.error(`[context-diff] ${msg}`) } catch { /* 忽略 */ }
}

// ═══════════════════════════════════════════════════════════
// 识别
// ═══════════════════════════════════════════════════════════

/**
 * 这条消息是不是指令文件注入。
 *
 * 判据是 `source.kind === 'agent-instructions'` —— 宿主的
 * `dsh-agent-instructions` 是唯一产出它的组件，且只覆盖 AGENTS.md /
 * CLAUDE.md / *.local.md / 用户级同名文件这一类。
 *
 * @param {object} message
 * @returns {boolean}
 */
function isInstructionMessage(message) {
  const src = message?.source
  if (src?.kind !== 'agent-instructions') return false
  return Array.isArray(src.changes) && src.changes.length > 0
}

/**
 * 取消息正文。
 * @param {object} message
 * @returns {string}
 */
function textOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

/**
 * 从渲染好的注入正文里剥出指令文件原文。
 *
 * 宿主有两种渲染形状：
 *   updated  —— `Updated instructions from: <path>` +
 *               `This file changed after it was loaded. ...` + 正文
 *   baseline —— `Instructions from: <path>` + 正文
 *
 * 都认不出来就返回 null，调用方据此 fail-open。
 *
 * @param {string} text
 * @returns {string|null}
 */
function bodyOf(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  const stripTail = (s) => s.replace(/<\/system-reminder>\s*$/, '').trim()

  const afterMarker = text.replace(
    /^[\s\S]*?This file changed after it was loaded\.[^\n]*\n+/,
    '',
  )
  if (afterMarker !== text) return stripTail(afterMarker)

  const afterHeader = text.replace(/^[\s\S]*?Instructions from:[^\n]*\n+/, '')
  if (afterHeader !== text) return stripTail(afterHeader)

  return null
}

/**
 * 把 `source.changes[].path` 补成完整路径。
 *
 * scope 前缀决定根目录（实测）：
 *   `user-global` → `~/.dsh`
 *   `.`           → 工作区根
 *
 * @param {{path?: string, scope?: string}} change
 * @param {string} cwd 工作区根，由调用方从 ctx 取
 * @returns {string}
 */
function fullPathOf(change, cwd) {
  const raw = String(change?.path ?? 'AGENTS.md')
  const scope = String(change?.scope ?? '')
  const home = os.homedir()

  if (path.isAbsolute(raw)) return raw

  if (scope.startsWith('user-global') || raw.startsWith('~')) {
    const rel = raw.replace(/^~[\\/]/, '')
    return path.join(home, ...rel.split(/[\\/]/))
  }
  const base = cwd && cwd.length > 0 ? cwd : process.cwd()
  return path.join(base, ...raw.split(/[\\/]/))
}

// ═══════════════════════════════════════════════════════════
// diff —— Myers O(ND)
// ═══════════════════════════════════════════════════════════

/**
 * Myers 差异算法：求两行序列的最短编辑脚本。
 *
 * 相比 LCS 的 O(m·n) 矩阵，Myers 的复杂度是 O((m+n)·D)，D 是差异数。
 * 指令文件绝大多数时候只改几行，D 很小，因此内存与时间都远低于矩阵法。
 *
 * 实现取自 Myers 1986 论文的贪心版本（只保留当前一轮的 V 数组），
 * 再回溯出完整的编辑操作序列。
 *
 * @param {string[]} a 旧行
 * @param {string[]} b 新行
 * @returns {Array<{op:'equal'|'delete'|'insert', line:string}>}
 */
function myersDiff(a, b) {
  const n = a.length
  const m = b.length
  const max = n + m
  // 差异超过这个规模就别算精确解了，交给调用方的近似分支
  const LIMIT = 4000

  if (n === 0 && m === 0) return []
  if (n === 0) return b.map((line) => ({ op: 'insert', line }))
  if (m === 0) return a.map((line) => ({ op: 'delete', line }))

  const offset = max
  const v = new Int32Array(2 * max + 2)
  /** 每一步的 V 快照，供回溯使用 */
  const trace = []

  let found = false
  let dFinal = 0

  for (let d = 0; d <= max; d++) {
    if (d > LIMIT) break
    // 快照：只存会被读取的那一段
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1]           // 向下（插入）
      } else {
        x = v[offset + k - 1] + 1        // 向右（删除）
      }
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) { x++; y++ }
      v[offset + k] = x
      if (x >= n && y >= m) { found = true; dFinal = d; break }
    }
    if (found) break
  }

  if (!found) return null   // 差异太大，调用方走近似分支

  // 回溯
  const ops = []
  let x = n
  let y = m
  for (let d = dFinal; d > 0; d--) {
    const snap = trace[d]
    const getV = (k) => snap[k + d + 1]
    const k = x - y
    const prevK = (k === -d || (k !== d && getV(k - 1) < getV(k + 1))) ? k + 1 : k - 1
    const prevX = getV(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x--; y--
      ops.push({ op: 'equal', line: a[x] })
    }
    if (d > 0) {
      if (x === prevX) { y--; ops.push({ op: 'insert', line: b[y] }) }
      else { x--; ops.push({ op: 'delete', line: a[x] }) }
    }
  }
  while (x > 0 && y > 0) { x--; y--; ops.push({ op: 'equal', line: a[x] }) }
  while (x > 0) { x--; ops.push({ op: 'delete', line: a[x] }) }
  while (y > 0) { y--; ops.push({ op: 'insert', line: b[y] }) }

  return ops.reverse()
}

/**
 * 行级 diff，输出带上下文锚点的变更段。
 *
 * 两条路：
 *   精确 —— Myers 求最小编辑脚本，再按 CTX 切出 hunks
 *   近似 —— 差异过大时只报「删了哪些行 / 加了哪些行」，不保证位置
 *
 * @param {string} oldText
 * @param {string} newText
 * @returns {{kind:'exact'|'approx', hunks: Array<{before:string[],removed:string[],added:string[],after:string[]}>}}
 */
function diffLines(oldText, newText) {
  const A = oldText.split('\n')
  const B = newText.split('\n')

  const ops = myersDiff(A, B)

  if (ops === null) {
    const setA = new Set(A)
    const setB = new Set(B)
    const removed = A.filter((l) => !setB.has(l))
    const added = B.filter((l) => !setA.has(l))
    if (removed.length === 0 && added.length === 0) return { kind: 'approx', hunks: [] }
    return { kind: 'approx', hunks: [{ before: [], removed, added, after: [] }] }
  }

  // 把操作序列按「变更块」切分
  const hunks = []
  let i = 0
  let ai = 0   // 当前在旧文本中的行号
  while (i < ops.length) {
    if (ops[i].op === 'equal') { ai++; i++; continue }

    const startA = ai
    const removed = []
    const added = []
    while (i < ops.length && ops[i].op !== 'equal') {
      if (ops[i].op === 'delete') { removed.push(ops[i].line); ai++ }
      else added.push(ops[i].line)
      i++
    }
    hunks.push({
      before: A.slice(Math.max(0, startA - CTX), startA),
      removed,
      added,
      after: A.slice(startA + removed.length, startA + removed.length + CTX),
    })
    // 跳过紧跟的 equal 段（收集上下文即可，hunk 本身已带上）
    while (i < ops.length && ops[i].op === 'equal') { ai++; i++ }
  }

  return { kind: 'exact', hunks }
}

/**
 * 把 diff 渲染成给人读的文本。
 *
 * @param {string} sourcePath 完整路径
 * @param {{kind:string, hunks:Array}} diff
 * @param {number} newLen 新版行数
 * @returns {string}
 */
function renderDiff(sourcePath, diff, newLen) {
  if (diff.hunks.length === 0) {
    return `${sourcePath} changed, but no line-level difference (whitespace/newline only). No action needed.`
  }

  const out = []
  out.push(`${sourcePath} changed (now ${newLen} lines). Below is the diff against what you already have, not the full file.`)
  if (diff.kind === 'approx') {
    out.push('WARNING: file too large for an exact diff; removed/added lines are listed without positions. Read the file on disk if unsure.')
  }
  out.push('')
  diff.hunks.forEach((h, idx) => {
    if (diff.hunks.length > 1) out.push(`# Hunk ${idx + 1}`)
    out.push('````text')
    for (const l of h.before) out.push(`  ${l}`)
    for (const l of h.removed) out.push(`- ${l}`)
    for (const l of h.added) out.push(`+ ${l}`)
    for (const l of h.after) out.push(`  ${l}`)
    out.push('````')
    out.push('')
  })
  out.push('`-` removed, `+` added, unprefixed lines are context anchors. Everything else is unchanged.')
  return out.join('\n')
}

// ═══════════════════════════════════════════════════════════
// 插件
// ═══════════════════════════════════════════════════════════

/**
 * @param {object} ctx
 */
export function apply(ctx) {
  /**
   * 按文件路径存状态。同一份文件在不同会话里内容相同，
   * 用路径当 key 保证 diff 比的是同一个文件的前后版本。
   * @type {Map<string, {baseline: string|null, injected: Set<string>, rewritten: number}>}
   */
  const states = new Map()

  const stateOf = (key) => {
    let s = states.get(key)
    if (s === undefined) {
      s = { baseline: null, injected: new Set(), rewritten: 0 }
      states.set(key, s)
    }
    return s
  }

  const keyOf = (msg) => {
    const p = msg?.source?.changes?.[0]?.path
    return typeof p === 'string' && p.length > 0 ? p : '(unknown)'
  }

  /** 尽力取当前工作目录；拿不到就交给 fullPathOf 用 process.cwd() 兜底。 */
  const cwdOf = () => {
    try {
      const wd = ctx.get?.('workingDirectory')
      return typeof wd?.root === 'string' ? wd.root : ''
    } catch { return '' }
  }

  // ── 压缩后清空 baseline：下一条注入必须以全量为基准 ──
  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type !== 'compaction/end') return
      const n = states.size
      for (const s of states.values()) {
        s.baseline = null
        s.injected.clear()
      }
      if (debugOn()) ctx.logger?.info?.(`[context-diff] COMPACTION reset ${n} baseline(s) (${String(session?.id ?? '').slice(0, 8)})`)
    } catch (e) {
      shout(ctx, `compaction listener failed: ${e?.message ?? e}`)
    }
  })

  ctx.on('llm/stream', (options, next) => {
    try {
      const messages = options?.messages
      if (!Array.isArray(messages) || messages.length === 0) return next()

      // 只找最后一条指令注入
      let idx = -1
      for (let i = messages.length - 1; i >= 0; i--) {
        if (isInstructionMessage(messages[i])) { idx = i; break }
      }
      if (idx < 0) return next()

      const msg = messages[idx]
      const st = stateOf(keyOf(msg))

      // 同一条消息只改一次
      const msgId = String(msg?.id ?? '')
      if (msgId !== '' && st.injected.has(msgId)) return next()

      const text = textOf(msg)
      const body = bodyOf(text)
      if (body === null) {
        if (debugOn()) ctx.logger?.info?.(`[context-diff] SKIP unrecognized shape (len=${text.length})`)
        return next()
      }

      // 首次：全量，记基准
      if (st.baseline === null) {
        st.baseline = body
        if (msgId !== '') st.injected.add(msgId)
        if (debugOn()) ctx.logger?.info?.(`[context-diff] BASELINE ${body.length} chars (${keyOf(msg)})`)
        return next()
      }

      if (st.baseline === body) {
        if (msgId !== '') st.injected.add(msgId)
        if (debugOn()) ctx.logger?.info?.('[context-diff] SKIP identical to baseline')
        return next()
      }

      const diff = diffLines(st.baseline, body)
      const newLen = body.split('\n').length
      const rendered = renderDiff(fullPathOf(msg?.source?.changes?.[0], cwdOf()), diff, newLen)

      // ── 收益守卫：diff 不比原文短，就原样放行 ──
      //
      // 文件大改时（几乎每行都变），每个 hunk 还带 CTX 行上下文，
      // 渲染出来可能**比全文还长**。实测一份 383 行文件改成 334 行，
      // 101 个 hunk 渲染出 41,865 字符，而原文才 12,901 —— 反而多花 3 倍 token。
      //
      // 判据：**按字节比**，不是按字符（中文一字 3 字节）。
      // 不划算就用原文，同时把 baseline 推到新版（否则下次还在比旧版）。
      const textBytes = Buffer.byteLength(text, 'utf8')
      const renderedBytes = Buffer.byteLength(rendered, 'utf8')
      if (renderedBytes >= textBytes) {
        st.baseline = body
        if (msgId !== '') st.injected.add(msgId)
        if (debugOn()) {
          ctx.logger?.info?.(
            `[context-diff] SKIP not worth it: diff ${renderedBytes}B >= full ${textBytes}B `
            + `(${diff.hunks.length} hunk(s), ${diff.kind})`,
          )
        }
        return next()
      }

      const saved = textBytes - renderedBytes

      const nextMessages = messages.slice()
      nextMessages[idx] = { ...msg, content: [{ type: 'text', text: rendered }] }

      st.baseline = body
      if (msgId !== '') st.injected.add(msgId)
      st.rewritten++

      if (debugOn()) {
        ctx.logger?.info?.(
          `[context-diff] DIFF ${diff.hunks.length} hunk(s) (${diff.kind}) `
          + `${textBytes} -> ${renderedBytes} bytes, saved ${saved}`,
        )
      }

      return next({ ...options, messages: nextMessages })
    } catch (e) {
      // fail-open：原样放行，错误必须可见
      shout(ctx, `rewrite failed, falling back to full text: ${e?.message ?? e}`)
      return next()
    }
  })

  ctx.logger?.info?.(`[context-diff] loaded ${BUILD}`)
}

// 供测试使用（不影响插件加载）
export const __test = { bodyOf, diffLines, myersDiff, renderDiff, fullPathOf, isInstructionMessage }
