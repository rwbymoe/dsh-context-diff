# Changelog

All notable changes to this project, newest first.

## 0.2.0

This release widens what the plugin can handle. Earlier versions assumed one
instruction file per injection; a single injection can carry several, and this
one handles that properly.

### Multiple instruction files per injection

`changes[]` is an array and the injected body is those files' sections joined
together. 0.1 keyed a single baseline on the first file and stored the whole
joined body, so a message carrying two files kept both under one entry.

0.2 splits the body into per-file sections and keeps **one baseline per file
path**. Each changed file gets its own section in the output, with its own path
and its own line count, and files are only ever compared against themselves.

A message is rewritten only when every file in it can be — if any file has no
baseline yet, has been removed, or would not gain anything from a diff, the whole
message goes out as the host wrote it. A partial rewrite would tell the model
that a file it still has is gone.

### Line endings are normalised before comparing

The same file can be rendered with CRLF on one turn and LF on another; an editor
that saves as LF is enough, and nothing warns you. Compared byte for byte, every
line then differs, and a small file is reported as entirely removed.

0.2 normalises line endings in memory before comparing. Nothing is written back —
the only thing that has to match is the two strings being compared.

### Diagnostics go to stdout

`ctx.logger` output does not reach a terminal or a file on every host, so the
debug lines were invisible in practice. They now go to `console.log`, which is
stdout, and can be captured by redirecting the host's output. `DSH_CONTEXT_DIFF_DEBUG=1`
still controls whether anything is printed, and the plugin still writes no file.

### Self-checks

The suite that ships with this project grew from 55 checks to 69, covering
per-file sectioning, line-ending normalisation, and the pass-through paths.

---

## 0.1.4

- Documentation: the DSH links point at the real repository.

## 0.1.3

- Worth-it guard: when the rendered diff would be at least as large as the
  original text, the full text is sent instead.

## 0.1.1

- First stable publish.

## 0.1.0

- Initial release: line-level diff (Myers) for repeated `AGENTS.md` / `CLAUDE.md`
  injections, per-file state, fail-open.
