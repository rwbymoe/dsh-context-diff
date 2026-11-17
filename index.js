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
 * Its state is one in-memory map, dropped on restart. Dropping it is the safe
 * direction: the next injection arrives as full text and re-establishes it.
 *
 * Diagnostics go to stdout via `console.log`, because `ctx.logger` output does
 * not reach a terminal or a file on every host. For a line per decision, set
 * `DSH_CONTEXT_DIFF_DEBUG=1` — even then it only prints, it never writes.
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
export const BUILD = '2026-11-18T01:30+08:00 · context-diff · per-file baseline + EOL-normalised + Myers + zero deps + fail-open + read-only'

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
 * Normalise line endings for in-memory comparison.
 *
 * **Never write this back to disk.** The only thing that has to match is the two
 * strings being compared.
 *
 * Why it is required: the same instruction file can arrive with CRLF on one turn
 * and LF on another — an editor that saves as LF is enough, and nothing warns
 * you. Without this every line differs, because the `\r` is part of the line.
 * Measured on a real session: seq 42281 of `~/.dsh/AGENTS.md` went CRLF → LF and
 * the diff reported 315 of 316 lines deleted and 315 added. The worth-it guard
 * happened to catch it (the rendering was larger than the original), but a
 * smaller file would have gone out as "this whole file was removed".
 *
 * `\r\n` collapses to `\n`, and a lone `\r` does too, so CRLF, LF and old-Mac CR
 * all compare equal.
 *
 * @param {string} s
 * @returns {string}
 */
function normalizeEol(s) {
  return String(s).replace(/\r\n?/g, '\n')
}

/**
 * Strip the rendered injection down to the instruction file's own text.
 *
 * The host writes four section headers (`dsh-agent-instructions/lib/index.js`):
 *   L142 `Instructions from: <path>`              — baseline
 *   L262 `Additional instructions from: <path>`   — action "set"
 *   L283 `Instructions removed: <path>`           — action "remove" (no body)
 *   L285 `Updated instructions from: <path>`      — action "replace"
 *
 * This function handles the shapes the single-section path needs — `Updated` and
 * baseline — and returns null for anything else so the caller fails open.
 * Multi-file splitting happens in `splitSections`, which is the path actually
 * used by the hook.
 *
 * @param {string} text
 * @returns {string|null}
 */
function bodyOf(text) {
  const src = normalizeEol(text)
  if (src.length === 0) return null
  const stripTail = (s) => s.replace(/<\/system-reminder>\s*$/, '').trim()

  const afterMarker = src.replace(
    /^[\s\S]*?This file changed after it was loaded\.[^\n]*\n+/,
    '',
  )
  if (afterMarker !== src) return stripTail(afterMarker)

  const afterHeader = src.replace(/^[\s\S]*?Instructions from:[^\n]*\n+/, '')
  if (afterHeader !== src) return stripTail(afterHeader)

  return null
}

/**
 * Section headers written by the host, most specific prefix first so that
 * `Additional instructions from:` and `Updated instructions from:` cannot be
 * mistaken for the bare `Instructions from:`.
 *
 * Hard-coded on purpose: the plugin cannot read the host's source at runtime.
 * It is resolved through pnpm's junction in a different node_modules tree, so
 * `require('@deepseek-ai/dsh-agent-instructions/lib/index.js')` fails with
 * MODULE_NOT_FOUND (measured). Two runtime checks make a hard-coded list safe:
 * the section count must equal `changes.length`, and each section's path must
 * equal the matching `changes[i].path`. Either check failing means the hook
 * passes the original message through untouched — so a host that renames these
 * headers loses the optimisation, it never gets a wrong diff.
 */
const SECTION_HEAD = /^(Additional instructions from|Updated instructions from|Instructions removed|Instructions from): (.+)$/

/**
 * Split an instruction injection into its per-file sections.
 *
 * A single message can carry several files: `changes[]` is an array and the body
 * is the sections joined together. Keying one baseline on the whole body mixes
 * them up — measured on a real session, 20 of 493 injections carried two files
 * (`~/.dsh/AGENTS.md` + `AGENTS.md`) under one key.
 *
 * Returns `{ sections }` on success, or `{ reason }` when the body cannot be
 * split with confidence. The caller fails open on `reason`.
 *
 * Each section: `{ path, action, text }` where `text` is the file's own content
 * with the host's framing removed, line endings normalised, and the tail marker
 * trimmed. `action` comes from `changes[i]`, not from the header wording.
 *
 * @param {string} rawText the message text
 * @param {Array<{path?: string, action?: string}>} changes `source.changes`
 * @returns {{sections: Array<{path: string, action: string, text: string}>}|{reason: string}}
 */
function splitSections(rawText, changes) {
  if (!Array.isArray(changes) || changes.length === 0) return { reason: 'no changes' }

  /* Normalise first: the header regex uses `$` in multiline mode, and a stray
   * `\r` would sit between the path and the line end. */
  const text = normalizeEol(rawText)

  /* Collect every header with its offset. */
  const heads = []
  const re = new RegExp(SECTION_HEAD.source, 'gm')
  let m
  while ((m = re.exec(text)) !== null) {
    heads.push({ keyword: m[1], path: m[2].trim(), start: m.index, after: m.index + m[0].length })
  }
  if (heads.length === 0) return { reason: 'no section header' }
  if (heads.length !== changes.length) {
    return { reason: `section count ${heads.length} != changes ${changes.length}` }
  }

  /* Paths must line up with `changes` in order — this is what makes a
   * hard-coded header list safe. */
  for (let i = 0; i < heads.length; i++) {
    if (heads[i].path !== String(changes[i]?.path ?? '')) {
      return { reason: `path mismatch at ${i}: ${heads[i].path} != ${changes[i]?.path}` }
    }
  }

  const sections = []
  for (let i = 0; i < heads.length; i++) {
    const head = heads[i]
    const end = i + 1 < heads.length ? heads[i + 1].start : text.length
    let body = text.slice(head.after, end)

    /* Header-specific preamble the host adds after the title. Strip it so every
     * section's `text` is the file content alone:
     *   "set"      → blank, applicability sentence, blank
     *   "replace"  → blank, "This file changed after it was loaded. …", blank
     *   baseline   → blank                                        (nothing extra)
     *   "remove"   → blank, "The previously loaded instructions …" (no content) */
    if (head.keyword === 'Additional instructions from') {
      body = body.replace(/^\n+/, '')
      /* Drop the guidance paragraph: first paragraph after the title. */
      const paras = body.split('\n\n')
      paras.shift()
      body = paras.join('\n\n')
    } else if (head.keyword === 'Updated instructions from') {
      body = body.replace(/^\n+/, '')
      body = body.replace(/^This file changed after it was loaded\.[^\n]*\n+/, '')
    } else {
      body = body.replace(/^\n+/, '')
    }

    body = body.replace(/<\/system-reminder>\s*$/, '').trim()

    sections.push({
      path: String(changes[i].path),
      action: String(changes[i].action ?? 'replace'),
      text: body,
    })
  }

  return { sections }
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
   * Keyed by **one file path**. A single injection message can carry several
   * files (`changes[]` is an array), and each one gets its own entry, so their
   * baselines never mix.
   *
   * This was wrong before: the key was `changes[0].path` and the baseline was
   * the whole joined body, so a message carrying `~/.dsh/AGENTS.md` + `AGENTS.md`
   * stored both under the first path. The next message carrying only one of them
   * compared a single file against the joined pair and reported the other file
   * as deleted. Measured on a real session: 20 of 493 injections were affected.
   *
   * A file that two sessions both use still shares one baseline. The entry count
   * is therefore bounded by the number of instruction files, not by sessions.
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

  /**
   * Message ids already rewritten, so one message is never rewritten twice.
   *
   * This is separate from the per-path baselines above: a message can carry
   * several files, so "seen this message" is not the same as "seen this file".
   * Kept in memory only — a restart just re-establishes baselines from the
   * next full-text injection, which is the safe direction.
   *
   * @type {Set<string>}
   */
  const injectedMessages = new Set()

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
      if (debugOn()) console.log(`[context-diff] COMPACTION reset ${n} baseline(s) (${String(session?.id ?? '').slice(0, 8)})`)
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

      // Each message is rewritten at most once. Track that on a marker keyed by
      // the message id alone, because the per-file states below are keyed by path.
      const msgId = String(msg?.id ?? '')
      if (msgId !== '' && injectedMessages.has(msgId)) return next()

      const text = textOf(msg)
      const changes = msg?.source?.changes
      const split = splitSections(text, changes)
      if (split.reason !== undefined) {
        if (debugOn()) console.log(`[context-diff] SKIP cannot split: ${split.reason} (len=${text.length})`)
        return next()
      }

      /* ── Decide, per file, what this turn looks like ──
       *
       * Every section is handled on its own baseline. A file can be:
       *   first    — no baseline yet, or the baseline was cleared by a compaction
       *   same     — byte-identical after EOL normalisation
       *   changed  — a real diff exists
       *   removed  — `action: "remove"`; the file is gone, so there is no body
       *
       * The whole message is rewritten only if **every** section is either
       * `same` or `changed`-and-worth-it. If any file is `first` or `removed`, or
       * its diff is not worth the bytes, the message goes out untouched — a
       * partial rewrite would tell the model that a file it has is gone.
       */
      const plans = []
      let mustPassThrough = false

      for (const section of split.sections) {
        const st = stateOf(section.path)

        if (section.action === 'remove') {
          /* The file is gone. Drop the baseline; the `Instructions removed:`
           * header the host already wrote is the whole message for this file. */
          st.baseline = null
          plans.push({ path: section.path, kind: 'removed' })
          mustPassThrough = true
          continue
        }

        if (st.baseline === null) {
          st.baseline = section.text
          plans.push({ path: section.path, kind: 'first', len: section.text.length })
          mustPassThrough = true
          continue
        }

        if (st.baseline === section.text) {
          plans.push({ path: section.path, kind: 'same' })
          continue
        }

        const diff = diffLines(st.baseline, section.text)
        const rendered = renderDiff(section.path, diff, section.text.split('\n').length)
        plans.push({
          path: section.path,
          kind: 'changed',
          st,
          sectionText: section.text,
          diff,
          rendered,
          renderedBytes: Buffer.byteLength(rendered, 'utf8'),
          fullBytes: Buffer.byteLength(section.text, 'utf8'),
        })
      }

      /* Worth-it guard, per file: if this file's diff is not shorter than the
       * file's own text there is nothing to gain, so the whole message passes
       * through. Rewriting only the profitable files would still describe the
       * others against a baseline the model keeps — but the header would claim
       * they changed, which is the misleading part we are fixing. */
      for (const plan of plans) {
        if (plan.kind !== 'changed') continue
        if (plan.renderedBytes >= plan.fullBytes) {
          plan.kind = 'not-worth-it'
          mustPassThrough = true
        }
      }

      const changedPlans = plans.filter((p) => p.kind === 'changed')

      /* Nothing changed at all: leave the message alone. Baselines already match. */
      if (plans.every((p) => p.kind === 'same')) {
        if (msgId !== '') injectedMessages.add(msgId)
        if (debugOn()) console.log('[context-diff] SKIP identical to baseline')
        return next()
      }

      /* Baseline bookkeeping, done once and in one place: every file we saw the
       * current text of advances its baseline, whether or not the message gets
       * rewritten. `first` and `remove` already updated theirs above. */
      const commitBaselines = () => {
        for (const plan of plans) {
          if (plan.st !== undefined && plan.sectionText !== undefined) {
            plan.st.baseline = plan.sectionText
          }
        }
      }

      if (mustPassThrough || changedPlans.length === 0) {
        commitBaselines()
        if (msgId !== '') injectedMessages.add(msgId)
        if (debugOn()) {
          const why = plans
            .filter((p) => p.kind !== 'same')
            .map((p) => `${p.path.slice(-26)}:${p.kind}`)
            .join(' ')
          console.log(`[context-diff] PASS THROUGH (${why})`)
        }
        return next()
      }

      /* Every section is `same` or a worth-it `changed`: rewrite the message.
       * The header names every file that changed, and each file gets its own
       * section with its own line count — the old single header named only
       * `changes[0].path` and used the joined line count for all of them. */
      const totalFull = changedPlans.reduce((n, p) => n + p.fullBytes, 0)
      const totalDiff = changedPlans.reduce((n, p) => n + p.renderedBytes, 0)

      const header = changedPlans.length === 1
        ? `1 file changed: ${changedPlans[0].path}. Below is the diff against what you already have, not the full file.`
        : `${changedPlans.length} files changed. Each section below holds one file's diff against what you already have, not the full file.`

      const out = [header, '']
      for (const plan of changedPlans) {
        out.push(`## ${plan.path}`)
        out.push('')
        /* renderDiff returns its own first line (a per-file header) and its own
         * trailing legend. Drop both here: the path is already in the `## ` line
         * above and the legend is printed once at the end. */
        const lines = plan.rendered.split('\n')
        const body = lines
          .slice(1)                                            // drop its header line
          .filter((l) => !/^`-` removed, `\+` added,/.test(l))  // drop its legend
          .join('\n')
          .trim()
        out.push(body)
        out.push('')
      }
      out.push('`-` removed, `+` added, unprefixed lines are context anchors. Everything else is unchanged.')

      const rendered = out.join('\n')
      const nextMessages = messages.slice()
      nextMessages[idx] = { ...msg, content: [{ type: 'text', text: rendered }] }

      commitBaselines()
      for (const plan of changedPlans) plan.st.rewritten++
      if (msgId !== '') injectedMessages.add(msgId)

      if (debugOn()) {
        console.log(
          `[context-diff] DIFF ${changedPlans.length} file(s): `
          + changedPlans.map((p) => `${p.path.slice(-22)} ${p.diff.hunks.length}h`).join(', ')
          + ` | file text ${totalFull}B -> diff ${totalDiff}B, message ${Buffer.byteLength(rendered, 'utf8')}B`,
        )
      }

      return next({ ...options, messages: nextMessages })
    } catch (e) {
      // fail-open: pass the original through, and make the error visible
      shout(ctx, `rewrite failed, falling back to full text: ${e?.message ?? e}`)
      return next()
    }
  })

  console.log(`[context-diff] loaded ${BUILD} (debug=${debugOn() ? 'on' : 'off'})`)
}

// For tests; does not affect plugin loading
export const __test = { bodyOf, diffLines, myersDiff, renderDiff, fullPathOf, isInstructionMessage, normalizeEol, splitSections }
