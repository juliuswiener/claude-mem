# Switching the active claude-mem plugin

This documents how Claude Code picks the active `claude-mem` plugin, and the
exact commands to switch to this fork and to revert. **No switch has been
performed — these are instructions only.**

## How plugin selection actually works (three files)

1. `~/.claude/plugins/known_marketplaces.json` — registers marketplace
   *sources*. The upstream plugin comes from the `"thedotmack"` entry, whose
   source is the GitHub repo `thedotmack/claude-mem` itself (the repo doubles
   as its own marketplace — there's no separate marketplace-index repo). It is
   cloned in full to `~/.claude/plugins/marketplaces/thedotmack` (a real `.git`
   checkout) and kept in sync because `"autoUpdate": true`.

2. `~/.claude/plugins/marketplaces/<marketplace>/.claude-plugin/marketplace.json`
   — lists the plugins a marketplace offers, each with a `source` (relative
   path within that checkout). For thedotmack this is:
   ```json
   { "name": "claude-mem", "version": "13.24.1", "source": "./plugin" }
   ```
   So the *installed* plugin content is exactly the `plugin/` directory this
   repo's `npm run build` produces (`plugin/hooks`, `plugin/scripts`,
   `plugin/modes`, `plugin/skills`, `plugin/sqlite`, `plugin/.mcp.json`, etc.)
   — nothing more.

3. `~/.claude/plugins/installed_plugins.json` — records what's actually
   installed, per marketplace, as `<plugin-name>@<marketplace-name>`. On
   install/update, the `source` directory (`plugin/`) is **snapshotted** into
   `~/.claude/plugins/cache/<marketplace-name>/<plugin-name>/<version>/`
   (confirmed: the cache dir is a frozen copy from install time, e.g.
   `.../cache/thedotmack/claude-mem/13.24.1/`, currently a few commits behind
   the auto-updated marketplace checkout — files differ). **This cache path is
   what actually loads**, not the marketplace checkout.

4. `~/.claude/settings.json` → `"enabledPlugins"` — a flat map,
   `"<plugin-name>@<marketplace-name>": true|false`. Only one entry per
   `plugin-name` should be `true` at a time in practice (nothing stops two
   different marketplaces from both installing a plugin named `claude-mem`,
   but only enabled ones load hooks/skills/MCP servers).

Currently: `known_marketplaces.json` has `"thedotmack"` →
`thedotmack/claude-mem` (GitHub), `installed_plugins.json` has
`claude-mem@thedotmack` → cache path `.../cache/thedotmack/claude-mem/13.24.1`
(gitCommitSha `b6e05382e2be35e29f22335f04a6890a4c0ba976`), and
`enabledPlugins["claude-mem@thedotmack"] = true`.

## Important: name collision

This fork's `.claude-plugin/marketplace.json` still says `"name": "thedotmack"`
(inherited from the fork point) and `.claude-plugin/plugin.json` still says
`"name": "claude-mem"`. Adding this fork as a marketplace **as-is** would try
to register a second marketplace also named `"thedotmack"`, colliding with the
existing entry's key in `known_marketplaces.json`. Two options:

- **(a) Replace in place** — remove the existing `"thedotmack"` marketplace
  registration first, then add the fork under the same name. Simple, but
  reverting means re-adding the real `thedotmack/claude-mem` marketplace from
  GitHub again (fine — that's a public repo, cheap to re-add).
- **(b) Add alongside, under a distinct name** — edit the fork's
  `.claude-plugin/marketplace.json` `"name"` field to something distinct
  (e.g. `"nord-subtraktion"`) before adding it, so both marketplaces coexist
  and the switch is just toggling `enabledPlugins`. **Recommended** — it makes
  the revert a one-line settings change with no re-fetch.

The commands below use **(b)**.

## Switch: fork → active

```bash
# 0. From the fork checkout, on the reviewed branch:
cd /home/julius/00_projects/nord/claude-mem
git status   # must be clean / the intended commit
npm run build   # regenerate plugin/ from src/ (hooks, manifests, lockfile)

# 1. Avoid the marketplace-name collision (see above) — one-time, local edit,
#    not committed to git (or commit it if the owner wants the fork to
#    permanently identify as a distinct marketplace):
sed -i 's/"name": "thedotmack"/"name": "nord-subtraktion"/' .claude-plugin/marketplace.json

# 2. Register the fork checkout itself as a marketplace source (local path,
#    no push needed):
claude plugin marketplace add /home/julius/00_projects/nord/claude-mem

# 3. Install claude-mem from the new marketplace:
claude plugin install claude-mem@nord-subtraktion

# 4. Flip enabled plugins: disable upstream, enable the fork.
claude plugin disable claude-mem@thedotmack
claude plugin enable claude-mem@nord-subtraktion

# 5. Stop the currently-running worker daemon. This step is NOT optional:
#    the worker is a long-lived background process independent of which
#    plugin is "enabled" in settings.json, and CLAUDE_MEM_WORKER_PORT is
#    derived from the OS uid (not the plugin/marketplace identity), so the
#    OLD worker is still listening on the SAME port the new hooks will probe.
#    ensureWorkerStarted() treats an already-healthy port as "nothing to do"
#    — without this step the fork's worker-service.cjs never actually spawns,
#    and the old thedotmack code keeps serving hooks silently.
bun /home/julius/.claude/plugins/cache/thedotmack/claude-mem/13.24.1/scripts/worker-service.cjs stop
# (or: kill the pid recorded in ~/.claude-mem/worker.pid)

# 6. Restart Claude Code (or start a new session). The next SessionStart hook
#    now resolves through the fork's cache install
#    (~/.claude/plugins/cache/nord-subtraktion/claude-mem/<version>/) and
#    spawns a fresh worker from THAT script, confirmable via:
#    cat ~/.claude-mem/worker.pid   # new pid, new startedAt
```

### What happens to the database

**Shared, not fresh.** `CLAUDE_MEM_DATA_DIR` (currently
`/home/julius/.claude-mem`, per `~/.claude-mem/settings.json`) is resolved
independently of which plugin/marketplace is active — nothing in `paths.ts`
keys off plugin identity. The fork's worker opens the exact same
`~/.claude-mem/claude-mem.db` the old worker was using. On first open, the
`SessionStore` constructor's migration chain runs (idempotent — see Task 3);
the only migration that actually does anything on this DB is
`addObservationWhereWhyColumns()` (schema v51: `ALTER TABLE observations ADD
COLUMN where_field TEXT`, `ADD COLUMN why TEXT`), verified against a copy to
be a pure additive change (no row rewrite, no data loss, all ~25.7k existing
observation rows keep every existing column value and get `NULL`
`where_field`/`why`).

## Revert: fork → thedotmack 13.24.1

```bash
# 1. Flip enabled plugins back.
claude plugin disable claude-mem@nord-subtraktion
claude plugin enable claude-mem@thedotmack

# 2. Stop the fork's worker daemon (same reasoning as step 5 above, reversed —
#    otherwise the fork's worker keeps answering the shared port and the
#    re-enabled upstream hooks never get a chance to spawn the old one).
cat ~/.claude-mem/worker.pid   # note the fork's pid
bun /home/julius/00_projects/nord/claude-mem/plugin/scripts/worker-service.cjs stop

# 3. Optional cleanup — uninstall the fork plugin and remove its marketplace
#    registration entirely (not required; leaving it installed-but-disabled
#    is harmless and makes switching back later a two-command operation):
claude plugin uninstall claude-mem@nord-subtraktion
claude plugin marketplace remove nord-subtraktion

# 4. Restart Claude Code / start a new session. The old cache install
#    (~/.claude/plugins/cache/thedotmack/claude-mem/13.24.1/) spawns a worker
#    against the same shared DB. The where_field/why columns stay in the
#    schema (SQLite ALTER TABLE has no "down" migration and the old code
#    never asked to drop them) — the old code's queries name explicit column
#    lists everywhere observed in this codebase, so the extra columns should
#    be inert to it, but this has NOT been verified by running the actual
#    upstream 13.24.1 code against the migrated DB — only inferred from
#    reading the fork's own query code.
```

## Summary of the mapping (for reference)

| Concept | Path |
|---|---|
| Marketplace source registration | `~/.claude/plugins/known_marketplaces.json` |
| Marketplace's plugin listing | `<marketplace-checkout>/.claude-plugin/marketplace.json` |
| Installed plugin record (version, cache path) | `~/.claude/plugins/installed_plugins.json` |
| What's actually loaded each session | `~/.claude/settings.json` → `enabledPlugins["<name>@<marketplace>"]` |
| Frozen install snapshot (what hooks/worker actually run) | `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` |
| Fork's build output that becomes that snapshot | `plugin/` (this repo, produced by `npm run build`) |
| Shared data (DB, settings, .env, logs, pid) | `~/.claude-mem/` (via `CLAUDE_MEM_DATA_DIR`) |
