# rules

The `.yenarules` engine of yena, the index of the paths the rules close, the export lists and the `rules` command.

- Engine (`src/engine.ts`): parses `.yenarules` files (sections `[deny read]`, `[ask read]`, `[deny write]`, `[ask write]`, `[deny export]`; gitignore patterns), judges a path (`rulesVerdict`) and expands the rules into concrete paths. Format: `/data/md/architecture/claude/rules-files.md`.
- `@` lines: a leading `@` (after an optional `!`) means "relative to this module's data folder". Valid only in a module repo's root `.yenarules` (the parent folder is `modules` and `yena.json` is there); a malformed line anywhere else. `@/x` is malformed, `\@x` is a literal `@x`.
- `[deny export]`: marks the module's export list. Its `@` lines name data files that are not exported, its other lines name code files that are not packed; every `[deny read]` path is also never exported. No header means no data is exported; an empty header means all of it may be. Until a module has the header the old `export.deny` list of its `yena.json` is used.
- Index (`src/index-store.ts`): `<YENA_DATA>/rules/index.json` (0600, folder 0700, paths only), rebuilt at start, when a watched file or folder changes, when older than 15 s for chat use and on `rules index`.
- `rules index`: rebuild the index and list the rules files with their state. `rules add [--file <path> | --project <name>] <section> <pattern>…`: append lines that close more (never `!`). Both are `safe`.
- At start, a module whose root `.yenarules` has no `[deny export]` header and whose `yena.json` still has `export.deny` gets the header and one `@` line per pattern (only when its code folder is writable).
- The export filters are registered with the host (`registerRulesProvider`, only this module may); without this module no module data is exported.
- Public entry `src/public.ts` (pure): the engine, the index reader and `rulesLists`; claude imports it through `src/deps/rules.ts`.
- Export: the index under `<YENA_DATA>/rules/` is not meant for export; the module's root `.yenarules` gets `[deny export]` with `@**` from the user, and without the section nothing of its data is exported anyway.
