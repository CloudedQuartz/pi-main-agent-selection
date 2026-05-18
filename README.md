# pi-main-agent-selection

Configurable agent selection extension for [pi](https://github.com/earendil-works/pi) — replaces the bundled `pi-agent-suite` main-agent-selection extension with a Windows-compatible default shortcut and coloured footer status.

## Why this exists

The bundled `pi-agent-suite` extension uses `Ctrl+Shift+A` as its default shortcut. This key combination **does not work on Windows Terminal** (and many other terminals) because those terminals send the same raw byte (`\x01`) for both `Ctrl+A` and `Ctrl+Shift+A` — the Shift modifier is lost. Only terminals supporting the Kitty keyboard protocol or xterm modifyOtherKeys can distinguish the two.

This extension fixes the problem by defaulting to `Alt+A` and making every aspect configurable.

## Features

- **Configurable shortcut** — defaults to `Alt+A`; change to any key combo or disable entirely
- **Configurable command** — defaults to `/agent`; rename if you prefer `/switch`, `/model`, etc.
- **Coloured footer status** — shows the active agent in the footer with per-agent customisable colours
- **Configurable footer prefix and "none" colour** — personalise the status line format
- **Full parity** with the bundled extension:
  - Searchable agent selector UI with type-to-filter
  - Persisted agent selection per working directory
  - Session replacement handoff (`/new`, `/fork`, `/resume`)
  - Model, thinking level, and tools application from agent definitions
  - Runtime composition (system prompt injection, active tool management)
- **Self-contained** — no imports from the `pi-agent-suite` package; all shared logic is inlined

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
    "colors": {
      "Explore": "#50B868",
      "Plan": "#F8C038"
    },
    "noneColor": "#6B7280"
  }
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | `boolean` | `true` | Disable the entire extension |
| `command` | `string` | `"agent"` | Slash command name (without `/`) |
| `shortcut` | `string \| null` | `"alt+a"` | Keyboard shortcut. Set to `null` to disable. See [Key format](#key-format) |
| `footer.enabled` | `boolean` | `true` | Show agent status in the footer |
| `footer.statusKey` | `string` | `"current-agent"` | `ctx.ui.setStatus()` key |
| `footer.prefix` | `string` | `"Agent:"` | Text before the agent name |
| `footer.colors` | `object` | `{}` | Map agent IDs to `#RRGGBB` colours. Unlisted agents get a deterministic hash colour |
| `footer.noneColor` | `string` | `"#6B7280"` | Colour when no agent is selected |

Run `/reload` after editing config.

### Key format

Uses the same key format as pi's `keybindings.json`:

- **Letters:** `a`–`z`
- **Modifiers:** `ctrl+`, `shift+`, `alt+` (combinable)
- **Special keys:** `escape`, `enter`, `tab`, `f1`–`f12`, etc.
- Examples: `alt+a`, `ctrl+shift+p`, `f2`

> **Windows Terminal users:** `Ctrl+Shift+letter` combos cannot be distinguished from `Ctrl+letter`. Use `alt+` combos or function keys instead.

## Installation

### 1. Add the extension

Place this directory at `~/.pi/agent/extensions/main-agent-selection/` (or clone it there).

### 2. Disable the bundled extension

Edit `~/.pi/agent/agent-suite/agent-selection/config.json`:

```json
{ "enabled": false }
```

### 3. Remove the bundled extension from settings

In `~/.pi/agent/settings.json`, remove `"extensions/main-agent-selection/index.ts"` from the `pi-agent-suite` package entry, or set its extensions array to `[]`.

### 4. Disable the standalone current-agent-status extension (if present)

If you previously used the standalone `current-agent-status.ts` extension (which this replaces), disable it:

```bash
mv ~/.pi/agent/extensions/current-agent-status.ts ~/.pi/agent/extensions/current-agent-status.ts.disabled
mv ~/.pi/agent/extensions/current-agent-status.json ~/.pi/agent/extensions/current-agent-status.json.disabled
```

### 5. Reload

Run `/reload` in pi.

## Agent definitions

Agent definitions are read from:

1. `~/.pi/agent/agent-suite/agent-selection/agents/*.md` (suite directory, preferred)
2. `~/.pi/agent/agents/*.md` (legacy fallback)

Each `.md` file defines one agent. The filename (minus `.md`) becomes the agent ID.

Example (`~/.pi/agent/agent-suite/agent-selection/agents/explore.md`):

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

You are a fast exploration agent. Focus on understanding code structure
and finding relevant files. Do not edit or write files.
```

### Agent frontmatter fields

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"main"` \| `"subagent"` \| `"both"` | Where this agent can be used |
| `description` | `string` | Shown in the selector |
| `model.id` | `string` | `provider/model` format (e.g., `anthropic/claude-sonnet-4-5`) |
| `model.thinking` | `"off"` \| `"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` | Thinking level |
| `tools` | `string[]` | Tool whitelist (supports `*` wildcards, but not bare `*`) |
| `agents` | `string[]` | Subagent IDs this agent can invoke |

## Footer colour hashing

Agent IDs not listed in `footer.colors` get a deterministic colour derived from a SHA-256 hash of the name. The hue, saturation, and lightness are spread across the colour space so different agents are visually distinct.

## State persistence

Selected agent state is stored per working directory in:

```
~/.pi/agent/agent-suite/agent-selection/state/<sha256(cwd)>.json
```

With legacy fallback to:

```
~/.pi/agent/agent-selection/state/<sha256(cwd)>.json
```

State is automatically restored on startup, `/reload`, and `/resume`. Session replacement flows (`/new`, `/fork`) carry the selected agent forward via an in-process handoff.

## Development

Install dependencies for LSP/type checking:

```bash
cd ~/.pi/agent/extensions/main-agent-selection
npm install
```

Type check:

```bash
npx tsc --noEmit
```

The `tsconfig.json` uses path mappings that point to your local pi installation's type declarations, so `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui` resolve correctly.

> **Note:** At runtime, pi uses jiti with import aliases — it resolves these packages from its own bundled copies, not from the extension's `node_modules`. The `package.json` dependencies and `tsconfig.json` paths are for **development-time LSP only**.

## Credits

Based on the `main-agent-selection` extension from [pi-agent-suite](https://github.com/earendil-works/pi-agent-suite) by Earendil Works.

Agent status footer adapted from the `current-agent-status` standalone extension by the same author.

## License

MIT