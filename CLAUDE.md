# Project Configuration

## Project Overview
**ioBroker.utils** — Shared utilities for ioBroker adapter development. Superseded by `iobroker-io-lib` at `../ioBroker.io-lib/`.

## Development Notes
- **Location**: `/opt/iobroker/my_modules/ioBroker.utils`
- **Platform**: Linux (Raspberry Pi)
- **Execute as user**: `iobroker` — all commands must use `sudo -u iobroker <command>`

## Documentation Rules

### Markdown / API Docs
- `CLAUDE.md` is the single place for cross-references between `.md` files
- Individual `.md` files (API-core, API-engine, API-misc, etc.) must NOT reference each other
- Documentation must be AI-friendly: compact, relevant, redundant-free — optimized for AI context window usage, not human narrative prose
- Omit filler, repetition, and obvious statements; every line must carry information density

### TypeScript Code Comments
- **Types are documentation** — leverage them; don't repeat them in prose
- **Names are documentation** — if you need a comment to explain a name, rename it first
- **Prefer longer, unambiguous names** — `srcStates` not `src`; avoid negated booleans (`isReady` not `isNotPending`)
- Do document `@throws`, side effects, and non-obvious preconditions
- Document invariants and ownership on classes (e.g. "caller must call `destroy()`")
- Interfaces: document semantic contract, not the shape
- **Document decision points** — when a threshold or value was derived or sourced, say so (`// see <url>`); when an alternative was consciously rejected, note the tradeoff
- **Extract before commenting** — replace a complex condition or expression with a named variable or function; reach for a comment only if the name still isn't enough
- **Label logical groups** — a single `// phase: description` line above a block of related statements is preferable to per-line comments
- **Document async contracts** — note whether a Promise resolves before or after side effects, and whether arguments are mutated

---

# API Reference

See [API-core.md](doc/API-core.md) (IoAdapter, IoSql, Timer), [API-engine.md](doc/API-engine.md) (IoState, IoOperator, IoEngine), and [API-misc.md](doc/API-misc.md) (utilities).