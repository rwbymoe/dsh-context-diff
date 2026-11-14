# dsh-context-diff

> Only the diff, not the whole file.

A [DSH](https://github.com/deepseek-ai/deepseek-harness) plugin that rewrites repeated
`AGENTS.md` / `CLAUDE.md` injections so that only the **changed lines** are sent,
not the entire file each time.

## The problem

DSH's built-in `dsh-agent-instructions` re-renders the **full content** of an
instruction file every time it changes, wrapped in a note saying "use this
instead of what you loaded before". Earlier copies stay in the context.

Measured on one real session, at one moment — what a **single context surface**
held, not the session's whole history:

| | |
|---|---|
| Instruction copies present in that context | 37 |
| Their total size | ~988 KB (32.5% of the context) |
| **Superseded by a later version** | **36** |
| Superseded bytes still occupying context | **~932 KB** |

So about a third of that context was stale copies of one file. The 37 is the
number of copies that were still resident at that moment; across a long session
the running total of injections is much larger (this very project's session has
had 463), because a compaction clears the surface and the count starts again.

## What it does

On the `llm/stream` hook, it finds the **last** instruction-injection message and
replaces its body with a line-level diff against the previously loaded version.

```
C:\...\my-project\AGENTS.md changed (now 312 lines). Below is the diff
against what you already have, not the full file.

````text
  ## Build and test
- Run `npm test` before you commit.
+ Run `npm run check` before you commit.
  ## Style
````

`-` removed, `+` added, unprefixed lines are context anchors. Everything else is unchanged.
```

The full file always stays on disk, so the model can read it when it needs exact
wording.

**The session log is never modified** — only the outgoing request is.

## Design constraints

1. **Never touch history.** Only the last injection is rewritten, and each
   message is rewritten at most once.
2. **First load and post-compaction are full text.** Compaction rebuilds the
   context, so the baseline is cleared and the next injection re-establishes it.
3. **fail-open.** Any error returns the original request untouched and logs at
   `error` level. Spending extra tokens beats reading a wrong rule.
4. **No file IO at all.** The plugin neither reads nor writes a file — no cache,
   no state file, no log. Everything it needs comes from the message it is given,
   and everything it produces goes into the outgoing request. Its output is a
   function of its input, so the same conversation always sends the same bytes.
5. **Never worse than off.** If the rendered diff would be at least as large as
   the original text (measured in bytes), the full text is sent instead and the
   baseline still advances.

## Scope

Only messages with `source.kind === 'agent-instructions'` are touched, i.e. the
files DSH discovers as instruction files:

- `AGENTS.md`, `CLAUDE.md`
- `AGENTS.local.md`, `CLAUDE.local.md`
- user-global equivalents under `~/.dsh/` and `~/.agents/`

Conversation messages, tool calls/results, compaction summaries, subagent
notices and images are never modified.

## Install

```bash
dsh plugin --profile web add dsh-context-diff
```

Or link a local checkout:

```bash
cd ~/.dsh/profiles/web
pnpm add link:/path/to/dsh-context-diff
```

Then add it to `dsh.profile.bundles` in the profile `package.json`:

```json
"- id: dsh-context-diff\n  name: dsh-context-diff"
```

Restart DSH. To watch what it does, set `DSH_CONTEXT_DIFF_DEBUG=1` before starting
it — every injection then logs one line to the host logger: `BASELINE` on the first
one after a load or a compaction, `DIFF` for each rewrite, and `SKIP` when a rewrite
was not worth it. **The plugin writes no file of its own.**

## Algorithm

Line-level diff via **Myers (1986)** — `O((N+M)·D)` where `D` is the number of
differences. Instruction files usually change a few lines, so `D` is small and the
cost is near-linear.

No runtime dependencies. If the difference is very large (`D > 4000`), it falls
back to a set-based approximation that lists removed/added lines without
positions, and says so in the output.

## Known limits

- **Line granularity.** Changing a few characters inside one line produces one
  `-` line and one `+` line, not a character-level diff.
- **Per-file baseline.** State is keyed by the file path, not the session, so two
  sessions using the same file share one baseline. If session A advances it, the
  next injection in session B compares equal and is passed through unchanged —
  B receives the host's **full text**, so nothing is lost, but that one request
  gets no saving. The entry count stays bounded by the number of instruction
  files.
- **Approximation for huge differences.** See above.

## License

MIT
