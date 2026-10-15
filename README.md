# opencode-autocompact

An [OpenCode](https://opencode.ai) **V2** plugin that gives you Claude Code's
autocompact behaviour with a per-session knob: compact a session *before* the
model's real context limit, at a number you choose.

```
/autocompact 500k      # compact this session (and its children) once the live context reaches 500k tokens
/autocompact 500000    # same, plain count
/autocompact 1m        # suffix form
/autocompact           # report the effective threshold and the model's limit
/autocompact off       # revert this session (and descendants) to normal auto
```

With no `/autocompact` set for a session, the plugin does nothing and OpenCode's
own automatic compaction applies as usual.

## Install

From this repository (not published to npm yet):

```jsonc
// ~/.config/opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-autocompact",
      "options": {
        "minCheckIntervalMs": 2000,
        "compactionTimeoutMs": 300000,
        "debugEvents": false
      }
    }
  ]
}
```

Run `bun install` once in the plugin directory (the loader does not install
dependencies for local-path entries). Source and config edits are hot-reloaded;
changes to an unwatched local dependency may need `opencode2 service restart`.

Once published to npm, prefer:

```sh
opencode plugin add opencode-autocompact
```

## Why a plugin

OpenCode's compaction settings are global config only:

```jsonc
{
  "compaction": {
    "auto": true,
    "keep": { "tokens": 15000 },
    "buffer": 20000        // tokens kept free below the model limit
  }
}
```

There is no per-session compaction setting, so `/autocompact <n>` is implemented
by requesting compaction through the session API when the live context reaches
the threshold (`ctx.session.compact({ sessionID })`). Compaction is admitted
immediately and runs at the next safe point, so the session is trimmed well
before the model nears its limit. `/autocompact off` stores an explicit marker
that stops inheritance so the session falls back to normal auto-compaction.

## Scope and inheritance

A threshold is stored against the session where it was set and inherited by that
session's descendants via the `parentID` chain:

```
main  ── /autocompact 500k ──▶ threshold 500k
 └─ subagent ────────────────▶ inherits 500k
     └─ sub-subagent ────────▶ inherits 500k
```

`off` on a descendant overrides an inherited limit for that branch.

## How the check works

`Session.Info.tokens` (and the `session.usage.updated` event) are *cumulative*
session usage — they keep growing. The live context size is instead the newest
assistant message's prompt size:

```
used = tokens.input + tokens.cache.read + tokens.cache.write
```

read from `ctx.session.context({ sessionID })`. The watcher reacts to
`session.usage.updated`, coalesces checks per session, and requests compaction
when `used >= threshold`. A compaction in flight (`session.compaction.started` …
`.ended`/`.failed`) blocks further requests; a timeout releases the guard if
those events are missed. Session deletion clears the stored threshold.

`/autocompact` validates the value against the model's `limit.context` (from
`ctx.model.list()`), refusing anything at or above it.

## Options

Set in `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/home/nikolas/git/autocompact",
      "options": {
        "enabled": true,
        "minCheckIntervalMs": 2000,
        "compactionTimeoutMs": 300000,
        "debugEvents": false
      }
    }
  ]
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch; when false the plugin loads but does nothing. |
| `minCheckIntervalMs` | `2000` | Coalescing window between usage-driven checks per session. |
| `compactionTimeoutMs` | `300000` | Releases the in-flight guard if compaction events are missed. |
| `debugEvents` | `false` | Log every raw event (payload verification aid). |

## Feedback

The command is silent in the TUI (by design). Its outcome is written to
`<data>/opencode/log/autocompact.log` under the `[autocompact]` prefix, e.g.
`compaction requested (ses_…) — used 512340 >= threshold 500000`.

## Layout

```
index.ts            root shim -> src/index.ts
src/index.ts        plugin entry: options, command, watcher, event loop, cleanup
src/command.ts      /autocompact handling (set / status / off + validation)
src/thresholds.ts   storage + parent-chain inheritance resolver (+ cache)
src/used.ts         live context size from session messages
src/watch.ts        event stream -> threshold check -> session.compact
src/parse.ts        argument parsing + token formatting
src/options.ts      ctx.options parsing
src/log.ts          daemon-safe file + stderr logging
```

## Development

```sh
bun install
bun test
bun run typecheck
```

Local changes under `~/git/autocompact` are outside OpenCode's watched config
directories, so the running V2 service must be restarted to pick them up:

```sh
opencode2 service restart
```

## Notes / limitations

- Multiple plugin instances (one per location, plus roles) may each request
  compaction for the same session. Concurrent requests merge in OpenCode, so
  this is harmless; the in-flight guard only de-duplicates within an instance.
- The threshold is not re-validated against the model limit at check time, so if
  you switch a session to a model with a smaller limit, re-run `/autocompact`.
- Runtime payload shapes (`ctx.session.context` assistant `tokens`, the
  `session.compaction.*` events) follow the published V2 schema; re-verify with
  `debugEvents: true` if the runtime changes.
