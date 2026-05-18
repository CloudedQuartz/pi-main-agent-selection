# pi-main-agent-selection

Standalone main-agent selector for [pi](https://github.com/earendil-works/pi). It replaces the bundled `pi-agent-suite` selector with a configurable shortcut and integrated coloured footer status, without depending on pi-agent-suite's runtime composition system.

## Features

- `/agent` command and configurable keyboard shortcut
- Default shortcut: `Alt+A`, because many terminals cannot distinguish `Ctrl+Shift+letter` from `Ctrl+letter`
- Scrollable agent selector
- Direct prompt, model, thinking, and tool application from agent definitions
- Footer status showing the active agent
- Custom footer colours with deterministic SHA-256 hash colour fallback
- Session persistence through pi custom session entries

## Installation

Place or clone this directory at:

```text
~/.pi/agent/extensions/main-agent-selection/
```

Disable the bundled pi-agent-suite selector in `~/.pi/agent/agent-suite/agent-selection/config.json`:

```json
{ "enabled": false }
```

Then remove `"extensions/main-agent-selection/index.ts"` from the `pi-agent-suite` package entry in `~/.pi/agent/settings.json`, or set that package's `extensions` array to `[]`.

If you previously used `~/.pi/agent/extensions/current-agent-status.ts`, disable it too; this extension includes footer status.

Run `/reload` in pi after changing extension or config files.

## Configuration

Edit `~/.pi/agent/extensions/main-agent-selection/config.json`:

```json
{
  "enabled": true,
  "command": "agent",
  "shortcut": "alt+a",
  "footer": {
    "enabled": true,
    "statusKey": "current-agent",
    "prefix": "Agent:",
    "colors": {},
    "noneColor": "#6B7280"
  }
}
```

| Key                | Default           | Description                                       |
| ------------------ | ----------------- | ------------------------------------------------- |
| `enabled`          | `true`            | Enables this extension                            |
| `command`          | `"agent"`         | Slash command name, without `/`                   |
| `shortcut`         | `"alt+a"`         | Shortcut key; set to `null` to disable            |
| `footer.enabled`   | `true`            | Shows agent status in the footer                  |
| `footer.statusKey` | `"current-agent"` | Status segment key passed to `ctx.ui.setStatus()` |
| `footer.prefix`    | `"Agent:"`        | Text before the agent name                        |
| `footer.colors`    | `{}`              | Agent ID to `#RRGGBB` colour map                  |
| `footer.noneColor` | `"#6B7280"`       | Colour used when no agent is selected             |

Unlisted agents get a deterministic colour from a SHA-256 hash of the agent ID.

Shortcut values use pi's key format, for example `alt+a`, `ctrl+f2`, `f2`, or `escape`. Avoid `Ctrl+Shift+letter` in terminals that use legacy VT input, including Windows Terminal.

## Agent definitions

Agent definitions are loaded from the first available directory:

1. `~/.pi/agent/agent-suite/agent-selection/agents/*.md`
2. `~/.pi/agent/agents/*.md` legacy fallback

The filename without `.md` is the agent ID. Only agents with `type: main` or `type: both` are shown.

```markdown
---
type: both
description: Fast exploration agent
model:
  id: opencode-go/glm-5.1
  thinking: low
tools:
  - read
  - grep
  - find
  - ls
---

You are a fast exploration agent.
```

Used frontmatter:

| Field            | Description                                                           |
| ---------------- | --------------------------------------------------------------------- |
| `type`           | `main`, `subagent`, or `both`; this extension shows `main` and `both` |
| `description`    | Selector description                                                  |
| `model.id`       | Exact `provider/model`, `provider/query`, or fuzzy model reference     |
| `model.thinking` | `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`                 |
| `tools`          | Tool whitelist; supports `*` wildcards but not bare `*`               |

Other metadata, including `agents`, is allowed and ignored by this extension.

## State persistence

Selection is written to the pi session as a custom entry:

```ts
pi.appendEntry("main-agent-selection", { agentId });
```

On session start, the extension reads `ctx.sessionManager.getEntries()` backwards and restores the latest `main-agent-selection` entry. No external state files or in-process handoff map are used.

## Development

```bash
npm install
npx tsc --noEmit
```

The package and TypeScript config are for LSP/type checking. At runtime, pi resolves its own bundled packages through jiti/import aliases.

## Credits

Based on the `main-agent-selection` extension from [pi-agent-suite](https://github.com/earendil-works/pi-agent-suite). Footer status replaces the earlier standalone `current-agent-status` extension.

## License

MIT
