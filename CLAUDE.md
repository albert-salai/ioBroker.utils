# Project Configuration

## Project Overview
**ioBroker.utils** — Shared utilities for ioBroker adapter development. Superseded by `iobroker-io-lib` at `../ioBroker.io-lib/`.

## Development Notes
- **Location**: `/opt/iobroker/my_modules/ioBroker.utils`
- **Platform**: Linux (Raspberry Pi)
- **Execute as user**: `iobroker` — all commands must use `sudo -u iobroker <command>`

## Documentation Rules
- `CLAUDE.md` is the single place for cross-references between `.md` files
- Individual `.md` files (API-core, API-engine, API-misc, etc.) must NOT reference each other
- Documentation must be AI-friendly: compact, relevant, redundant-free — optimized for AI context window usage, not human narrative prose
- Omit filler, repetition, and obvious statements; every line must carry information density

---

# API Reference

See [API-core.md](API-core.md) (IoAdapter, IoSql, Timer), [API-engine.md](API-engine.md) (IoState, IoOperator, IoEngine), and [API-misc.md](API-misc.md) (utilities).