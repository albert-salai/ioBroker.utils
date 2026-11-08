# iobroker-utils

**Purpose:** project facts and the documentation rule for the shared library of the ioBroker adapters.

**Audience:** every AGENT in this repo.

**Contains:** path, documentation cross-reference rule, links to the API docs.

**Not here:** development and packaging rules (`/opt/iobroker/my_modules/CLAUDE.md`), code and comment rules
(`~/.claude/rules/code.md`), Markdown rules (`~/.claude/rules/markdown.md`).

**Path:** `/opt/iobroker/my_modules/iobroker-utils`; Linux (Raspberry Pi).

## API docs

`CLAUDE.md` is the single place for cross-references between `.md` files: the files in `doc/` must NOT reference each
other.

- [API-core.md](doc/API-core.md): `IoAdapter`, `IoSql`, `Timer`
- [API-engine.md](doc/API-engine.md): `IoState`, `IoOperator`, `IoEngine`
- [API-misc.md](doc/API-misc.md): utilities
- [API-engine-history.md](doc/API-engine-history.md): engine history mode
- [API-engine-live.md](doc/API-engine-live.md): engine live mode
