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
- Document invariants and ownership on classes (e.g. "caller must call `destroy()`")
- Interfaces: document semantic contract, not the shape
- **Document decision points** — when a threshold or value was derived or sourced, say so (`// see <url>`); when an alternative was consciously rejected, note the tradeoff
- **Label logical groups** — a single `// phase: description` line above a block of related statements is preferable to per-line comments
- **Document async contracts** — note whether a Promise resolves before or after side effects, and whether arguments are mutated

---

# API Reference

See [API-core.md](doc/API-core.md) (IoAdapter, IoSql, Timer), [API-engine.md](doc/API-engine.md) (IoState, IoOperator, IoEngine), and [API-misc.md](doc/API-misc.md) (utilities). Engine mode details: [API-engine-history.md](doc/API-engine-history.md) (history mode), [API-engine-live.md](doc/API-engine-live.md) (live mode).