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
- **Document the "why" and "what", not the "how"** — code shows how
- **If it's obvious, omit it** — noise degrades signal
- Omit `@param` and `@returns` when name + type make it obvious
- Do document `@throws`, side effects, and non-obvious preconditions
- Skip `@author`, `@version`, `@since` — that's what git is for
- File-level JSDoc only if purpose is non-obvious
- Document invariants and ownership on classes (e.g. "caller must call `destroy()`")
- Interfaces: document semantic contract, not the shape
- One-liner `//` comments inside function bodies for non-obvious logic only

---

# API Reference

See [API-core.md](doc/API-core.md) (IoAdapter, IoSql, Timer), [API-engine.md](doc/API-engine.md) (IoState, IoOperator, IoEngine), and [API-misc.md](doc/API-misc.md) (utilities).