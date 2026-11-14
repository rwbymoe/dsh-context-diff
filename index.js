/**
 * dsh-context-diff — send only the diff when an instruction file changes,
 * instead of re-sending the whole file every time.
 *
 * ## The problem
 *
 * DSH's `dsh-agent-instructions` re-renders the **full content** of an
 * instruction file each time it changes, wrapped in a note saying "use this
 * instead of what you loaded before". Measured on one real session: 37
 * injections after a compaction, about 955 KB, of which 36 were already
 * superseded by a later version but still occupied the context.
 *
 * ## What it does
 *
 * On the `llm/stream` hook it replaces the body of the **last** instruction
 * injection with a line-level diff. **It does not touch the host, does not
 * touch the session log, and changes only the content of this one request.**
 *
 * ## Three hard constraints
 *
 * 1. **Never touch history.** Only the last `agent-instructions` message is
 *    rewritten, and each message is rewritten at most once.
 * 2. **First load and post-compaction are full text.** With no baseline to
 *    compare against, the message passes through untouched. A compaction
 *    rebuilds the context, so the baseline is cleared and the next injection
 *    re-establishes it in full.
 * 3. **fail-open.** Any error lets the original request through and reports
 *    to `logger.error` and `console.error`. Spending extra tokens beats
 *    reading a wrong rule.
 *
 * ## Read only, never write
 *
 * **This plugin writes no file.** It reads nothing from disk either — the
 * body it needs is already in the message it is given. No state file, no
 * cache file, no diagnostic log.
 *
 * Diagnostics go to the host logger (`ctx.logger`). For a line per decision,
 * set `DSH_CONTEXT_DIFF_DEBUG=1` — even then it only logs, it never writes.
 *
 * ## Dependencies
 *
 * No runtime dependencies. The diff is Myers' algorithm, implemented below
 * (see `diffLines`).
 *
 * @license MIT
 */
import os from 'node:os'
import path from 'node:path'

/** Build stamp, so it is obvious which copy is running. */
export const BUILD = '2026-11-14T17:00+08:00 · context-diff · Myers + zero deps + fail-open + read-only'

export const name = 'dsh-context-diff'
export const inject = []

/**
 * Context lines kept before and after each change, as anchors.
 *
 * Two is enough: the anchors only say *where* a change sits, and the full file
 * is always on disk for the model to read when it needs exact wording. Going
 * from 3 to 2 cuts the rendered diff by 11% for a one-line change and about
 * 20% once several hunks are involved.
 */
const CTX = 2

/**
 * Whether to emit a line per decision.
 *
 * **Silent by default.** Only `DSH_CONTEXT_DIFF_DEBUG=1` makes it log each
 * BASELINE / DIFF / SKIP to the host logger — and even then it writes no file.
 *
 * A hot path should do no disk I/O and should not print a line per request.
 *
 * @returns {boolean}
 */
const debugOn = () => process.env.DSH_CONTEXT_DIFF_DEBUG === '1'

/**
 * Errors must stand out: `info` would drown in the host log.
 *
 * ⚠️ Logger only, never a file.
 *
 * @param {object} ctx
 * @param {string} msg
 */
const shout = (ctx, msg) => {
  try { ctx.logger?.error?.(`[context-diff] ${msg}`) } catch { /* ignore */ }
  try { console.error(`[context-diff] ${msg}`) } catch { /* ignore */ }
}

// ═══════════════════════════════════════════════════════════
// Identification
// ═══════════════════════════════════════════════════════════

/**
 * Is this message an instruction-file injection?
 *
 * The test is `source.kind === 'agent-instructions'` — the host's
 * `dsh-agent-instructions` is the only producer, and it covers only AGENTS.md /
 * CLAUDE.md / *.local.md and the user-global files of the same names.
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
 * The message's text.
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
 * Strip the rendered injection down to the instruction file's own text.
 *
 * The host renders two shapes:
 *   updated  —— `Updated instructions from: <path>` +
 *               `This file changed after it was loaded. ...` + body
 *   baseline — `Instructions from: <path>` + body
 *
 * Anything else returns null, and the caller fails open on that.
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
 * Resolve `source.changes[].path` to an absolute path.
 *
 * The scope prefix picks the root directory:
 *   `user-global` → `~/.dsh`
 *   `.`           → the workspace root
 *
 * @param {{path?: string, scope?: string}} change
 * @param {string} cwd workspace root, taken from ctx by the caller
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
 * Myers' difference algorithm: the shortest edit script between two line arrays.
 *
 * Where an LCS matrix costs O(m·n), Myers costs O((m+n)·D) with D the number of differences.
 * Instruction files usually change a few lines, so D is small and both time and memory stay low.
 *
 * This is the greedy version from Myers (1986), keeping only one round of V,
 * then walking back to recover the full operation sequence.
 *
 * @param {string[]} a old lines
 * @param {string[]} b new lines
 * @returns {Array<{op:'equal'|'delete'|'insert', line:string}>}
 */
function myersDiff(a, b) {
  const n = a.length
  const m = b.length
  const max = n + m
  // Past this edit distance give up on the exact answer and let the caller take
  // its approximate branch.
  //
  // D counts the lines that genuinely changed, so D ≈ 2 × (lines changed).
  // Measured cost on a 400-line file: D=200 took 2.3 ms, D=800 took 8.8 ms, and
  // a 1000-line file rewritten end to end (D=2000) took 137 ms. This runs before
  // every request, so the ceiling is about latency, not memory.
  //
  // 1000 ≈ a 500-line file changing everywhere. By that point the rendering is
  // already far larger than the original, so the caller's worth-it guard would
  // throw it away — paying for an exact answer there buys nothing.
  const LIMIT = 1000

  if (n === 0 && m === 0) return []
  if (n === 0) return b.map((line) => ({ op: 'insert', line }))
  if (m === 0) return a.map((line) => ({ op: 'delete', line }))

  const offset = max
  const v = new Int32Array(2 * max + 2)
  /** One snapshot of V per round, kept for the walk back */
  const trace = []

  let found = false
  let dFinal = 0

  for (let d = 0; d <= max; d++) {
    if (d > LIMIT) break
    // Snapshot only the slice the walk back can read
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1]           // down: an insertion
      } else {
        x = v[offset + k - 1] + 1        // right: a deletion
      }
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) { x++; y++ }
      v[offset + k] = x
      if (x >= n && y >= m) { found = true; dFinal = d; break }
    }
    if (found) break
  }

  if (!found) return null   // too different; caller takes the approximate branch

  // Walk back
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
 * A line-level diff, as runs of changes with context anchors.
 *
 * Two branches:
 *   exact — Myers gives the minimal script, cut into hunks with CTX lines of context
 *   approx — when the difference is too large, list removed/added lines without positions
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

  // Cut the operation sequence into runs of changes
  const hunks = []
  let i = 0
  let ai = 0   // current line number in the old text
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
    // Skip the equal run that follows; the hunk already carries its context
    while (i < ops.length && ops[i].op === 'equal') { ai++; i++ }
  }

  return { kind: 'exact', hunks }
}

/**
 * Render a diff as text meant to be read.
 *
 * @param {string} sourcePath absolute path
 * @param {{kind:string, hunks:Array}} diff
 * @param {number} newLen line count of the new version
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
// The plugin
// ═══════════════════════════════════════════════════════════

/**
 * @param {object} ctx
 */
export function apply(ctx) {
  /**
   * Per-file state.
   *
   * Keyed by the instruction file's path, so a file that two sessions both
   * use shares one baseline. The entry count is therefore bounded by the
   * number of instruction files — it does not grow with sessions.
   *
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

  /** State key: the file path itself. The file count is fixed, so `states` is bounded. */
  const keyOf = (msg) => {
    const p = msg?.source?.changes?.[0]?.path
    return typeof p === 'string' && p.length > 0 ? p : '(unknown)'
  }

  /** Best-effort working directory; fullPathOf falls back to process.cwd(). */
  const cwdOf = () => {
    try {
      const wd = ctx.get?.('workingDirectory')
      return typeof wd?.root === 'string' ? wd.root : ''
    } catch { return '' }
  }

  // ── A compaction invalidates every baseline: the next injection is full text ──
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

      // Only the last instruction injection is rewritten
      let idx = -1
      for (let i = messages.length - 1; i >= 0; i--) {
        if (isInstructionMessage(messages[i])) { idx = i; break }
      }
      if (idx < 0) return next()

      const msg = messages[idx]
      const st = stateOf(keyOf(msg))

      // Each message is rewritten at most once
      const msgId = String(msg?.id ?? '')
      if (msgId !== '' && st.injected.has(msgId)) return next()

      const text = textOf(msg)
      const body = bodyOf(text)
      if (body === null) {
        if (debugOn()) ctx.logger?.info?.(`[context-diff] SKIP unrecognized shape (len=${text.length})`)
        return next()
      }

      // First time: full text, and this becomes the baseline
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

      // ── Worth-it guard: if the diff is no shorter than the original, pass the original ──
      //
      // When a file changes almost everywhere, every hunk still carries CTX lines of
      // context, so the rendering can come out longer than the full text: a 383-line
      // file changed into 334 lines gave 101 hunks and 41,865 characters against 12,901.
      //
      // Compare in bytes, not characters: one CJK character is three bytes in UTF-8.
      // Send the original and still advance the baseline, or the next call compares the old one.
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
      // fail-open: pass the original through, and make the error visible
      shout(ctx, `rewrite failed, falling back to full text: ${e?.message ?? e}`)
      return next()
    }
  })

  ctx.logger?.info?.(`[context-diff] loaded ${BUILD}`)
}

// For tests; does not affect plugin loading
export const __test = { bodyOf, diffLines, myersDiff, renderDiff, fullPathOf, isInstructionMessage }
