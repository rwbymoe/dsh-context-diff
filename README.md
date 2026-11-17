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
number of copies still resident at that moment, not the session's running total of
injections: a compaction clears the surface and the count starts again, so across
a long session far more than 37 injections will have happened.

## What it does

On the `llm/stream` hook, it finds the **last** instruction-injection message and
replaces its body with a line-level diff against the previously loaded version of
each file the message carries.

A message can carry more than one file: `changes[]` is an array and the body is
those files' sections joined together. Each file is diffed against **its own**
baseline and gets its own section in the output.

````
2 files changed. Each section below holds one file's diff against what you
already have, not the full file.

## ~/.dsh/AGENTS.md

```text
  
  be short
- ask first
+ ask before deleting
  
  ## voice
```

## AGENTS.md

```text
  
  - task1
- - task2
+ - task2 done
  
```

`-` removed, `+` added, unprefixed lines are context anchors. Everything else is unchanged.
````

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
   no state file, no log. Everything it needs comes from the messages it is given,
   and everything it produces goes into the outgoing request. Its state is one
   in-memory map that a restart simply drops, and dropping it is the safe
   direction: the next injection arrives as full text and re-establishes it.
5. **Never worse than off.** If the rendered diff would be at least as large as
   the original text (measured in bytes), the full text is sent instead and the
   baseline still advances.
6. **All or nothing per message.** A message carrying several files is rewritten
   only if every one of them can be. If any file has no baseline yet, was removed,
   or would not gain anything, the whole message goes out as the host wrote it. A
   partial rewrite would have to tell the model that a file it still has is gone.

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

Then add `dsh-context-diff` to the `dsh.profile.bundles` array in the profile's
`package.json`. The plugin ships its own `cordis.patch.yml` (referenced from
`dsh.bundle.patch`), so that is the only entry needed — no separate Host row.

Restart DSH. To watch what it does, set `DSH_CONTEXT_DIFF_DEBUG=1` before starting
it. One line per decision then goes to **stdout** (and so to whatever captures the
host's output — redirect it to a file if you want to keep it):

| Line | Meaning |
|---|---|
| `loaded …` | the plugin is in, with its build stamp |
| `SKIP identical to baseline` | every file compared equal; message untouched |
| `PASS THROUGH (path:first …)` | no baseline yet (first load, or after a compaction) |
| `PASS THROUGH (path:not-worth-it …)` | the diff would not be smaller than the file |
| `PASS THROUGH (path:removed …)` | the file is gone; nothing to diff against |
| `DIFF 2 file(s): … 1h, 1h \| file text 46577B -> diff 1263B` | rewritten, with the saving |
| `COMPACTION reset N baseline(s)` | baselines cleared; the next injection is full text |

**The plugin writes no file of its own** — that output is the host's stdout, not a
file this plugin opens.

## Algorithm

Line-level diff via **Myers (1986)** — `O((N+M)·D)` where `D` is the number of
differences. Instruction files usually change a few lines, so `D` is small and the
cost is near-linear.

No runtime dependencies. If the difference is very large (`D > 1000` — roughly a
500-line file changing everywhere), it falls back to a set-based approximation
that lists removed/added lines without positions, and says so in the output. At
that size the rendered diff is already larger than the original, so the
never-worse-than-off guard would discard it anyway.

## Known limits

- **Line granularity.** Changing a few characters inside one line produces one
  `-` line and one `+` line, not a character-level diff.

- **Baseline is per file path, not per session.** Two sessions that use the same
  file share one baseline, and the entry count stays bounded by the number of
  instruction files rather than by sessions. The usual consequence is benign:
  once one session has advanced the baseline, the other's injection compares
  equal and is passed through, so it receives the host's **full text** — nothing
  is lost, that one request just gets no saving. The narrow exception is two
  sessions injecting the same file in the same moment as an edit lands, where one
  of them can be shown a diff relative to the version the other one loaded. When
  it matters, read the file; the copy on disk is authoritative.

- **Approximation for huge differences.** See `Algorithm`.

- **Section headers are matched literally.** The plugin recognises the four
  headers DSH's `dsh-agent-instructions` writes (`Instructions from:`,
  `Additional instructions from:`, `Updated instructions from:`,
  `Instructions removed:`). It cannot read that package at runtime, so they are
  written into this plugin. Two checks run on every message before a rewrite is
  attempted — the section count must equal `changes.length`, and each section's
  path must equal the matching `changes[i].path`. If either fails the message is
  passed through untouched. **A host that renames those headers loses the
  optimisation; it never gets a wrong diff.**

## License

MIT
