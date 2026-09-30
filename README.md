# pi-mcp-bridge

> **Deprecated:** use Pi's built-in MCP support instead. The migration below is tested with Pi **0.99.1**. New setups should not install this package.
>
> The bridge remains functional for existing installations; it does not automatically change configuration or disable itself. Its `/mcp` command replaces Pi's built-in MCP extension, so only one implementation should be loaded.

## Migrate to built-in MCP

1. **Check native support and back up your configuration.** Run `pi --version` and `pi mcp --help`. If native MCP commands are unavailable, update Pi through your installation's supported workflow before migrating. Back up both global and project MCP files and your Pi settings.
2. **Convert every bridge configuration you use.** The global file moves from `~/.pi/mcp.json` to `~/.pi/agent/mcp.json`; project files stay at `.pi/mcp.json`. Wrap the flat server map in `mcpServers` and add `"exposure": "direct"` to migrated entries to preserve the bridge's direct tool access:

   ```json
   {
     "mcpServers": {
       "my-server": {
         "type": "stdio",
         "command": "npx",
         "args": ["-y", "some-mcp-package@latest"],
         "exposure": "direct"
       },
       "remote-server": {
         "type": "http",
         "url": "https://example.com/mcp",
         "exposure": "direct"
       }
     }
   }
   ```

   If `PI_CODING_AGENT_DIR` is set, the bridge's global file is `mcp.json` in its parent directory, and the native file is `mcp.json` inside that agent directory. If you use `PI_MCP_CONFIG`, migrate that file too and update its caller: native MCP does **not** use that override. SDK clients can supply scoped servers through `createMcpExtension({ loadConfig })`.

   Preserve commands, arguments, environment variables, URLs, unrelated native entries and existing exposure choices. If a native file already exists, merge under `mcpServers`; resolve same-name conflicts deliberately instead of overwriting it. Project entries replace global entries with the same name, and native Pi reads project configuration only after project trust is granted.
3. **Check compatibility before removing the bridge.**
   - Native MCP supports stdio and Streamable HTTP, **not legacy SSE or HTTP-to-SSE fallback**. An `http` entry may have relied on that fallback. Verify its server supports Streamable HTTP; do not simply relabel an SSE endpoint.
   - Bridge OAuth credentials under `~/.pi/mcp-oauth/` are not automatically imported. Native Pi uses its own `mcp-auth.json` store; sign in again with `pi mcp login <server>` or `/mcp login <server>` as needed. Native sessions report servers needing sign-in rather than automatically opening the browser at startup.
   - Native MCP defaults to **codemode** exposure. The explicit `direct` setting above retains existing tool calls and the `mcp__<server>__<tool>` names. You can adopt codemode or deferred discovery later through `/mcp`.
   - If you use [`pi-subagent`](https://github.com/cdias900/pi-subagent), update Pi first and use `pi-subagent` v3/native-only support before using `mcps` scoping. Scoped children use Pi's native MCP runtime and credential store, including codemode, discovery and resources; do not retain a bridge config for an older subagent backend. Native Pi 0.99.1 has a startup-cancellation limitation: initializing connections can outlive cancellation until native cleanup completes. See that package's compatibility and startup-cancellation sections. Other consumers of the flat configuration need their own migration.
4. **Remove the bridge from each scope where it is installed.**

   ```bash
   pi remove git:github.com/cdias900/pi-mcp-bridge
   # Also run this if the project declares the package:
   pi remove --local git:github.com/cdias900/pi-mcp-bridge
   ```

   Remove manually loaded bridge copies from `extensions` settings or extension-directory symlinks as well. Do not remove a global installation as part of project-only setup without agreeing on the global migration.
5. **Enable built-in MCP.** In `pi config`, enable `mcp` under Built-in extensions, or merge `"+builtin:mcp"` into the relevant settings file's `extensions` array. Preserve other extension filters. Restart Pi or run `/reload` so the bridge is unloaded and native MCP takes over.
6. **Verify connections and real calls.** `pi mcp list` connects all enabled configured servers and reports errors; a nonzero exit can indicate an unavailable server, not a malformed migration. Use `/mcp` to inspect, sign in and reconnect, then make a bounded read-only call through each server you use. Once successful, retire the old flat config and cache while keeping your backups.

Native commands replace `/mcp-reload` with `/mcp reconnect <server>`; `/mcp-cache-clear` is no longer needed. Native Pi also supports HTTP headers, environment/command-based secrets, MCP resources and per-tool exposure. See the installed Pi documentation (`docs/mcp.md`) for the full contract.

## Legacy bridge reference

The sections below describe the deprecated bridge only, not native Pi configuration.

### Install (legacy only)

```bash
pi install git:github.com/cdias900/pi-mcp-bridge
```

### Quick Start (legacy only)

1. Create `~/.pi/mcp.json`:

```json
{
  "my-server": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "some-mcp-package@latest"]
  }
}
```

2. Start PI — your MCP tools appear automatically.
3. Run `/mcp` to see connection status.

## Configuration

Config files (both use the same format):

| File | Scope | Behavior |
|------|-------|----------|
| `~/.pi/mcp.json` | Global | Loaded for every project |
| `.pi/mcp.json` | Project-local | Merged over global (per server name) |

### Config Format

The config file is a flat JSON object. Each key is a server name, each value describes how to connect.

```json
{
  "server-name": {
    "type": "stdio | http | sse",
    "command": "(stdio only) command to spawn",
    "args": ["(stdio only)", "command", "arguments"],
    "env": { "(stdio only) extra env vars": "passed to the process" },
    "url": "(http/sse only) server URL"
  }
}
```

### stdio Servers

Stdio servers run as a local child process. The bridge spawns the process and communicates over stdin/stdout.

**Minimal:**

```json
{
  "my-server": {
    "type": "stdio",
    "command": "uvx",
    "args": ["some-mcp"]
  }
}
```

**With environment variables:**

```json
{
  "my-server": {
    "type": "stdio",
    "command": "uvx",
    "args": ["some-mcp-bridge"],
    "env": {
      "MCP_TARGET_URL": "https://api.example.com/mcp",
      "MCP_API_TOKEN": "your-token-here"
    }
  }
}
```

**Using npx (auto-install on first run):**

```json
{
  "slack": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@example/slack-mcp@latest"]
  }
}
```

**Using a local script or binary:**

```json
{
  "local-server": {
    "type": "stdio",
    "command": "node",
    "args": ["/path/to/my-mcp-server/build/index.js"]
  }
}
```

### HTTP Servers

HTTP servers are remote MCP endpoints. The bridge tries Streamable HTTP first, then falls back to SSE automatically.

```json
{
  "remote-server": {
    "type": "http",
    "url": "https://example.com/mcp"
  }
}
```

**Localhost (e.g. a desktop app exposing an MCP endpoint):**

```json
{
  "local-app": {
    "type": "http",
    "url": "http://127.0.0.1:3845/mcp"
  }
}
```

### SSE Servers

Force SSE transport (skip Streamable HTTP negotiation):

```json
{
  "sse-server": {
    "type": "sse",
    "url": "https://example.com/mcp/sse"
  }
}
```

### Full Example

A realistic `~/.pi/mcp.json` with multiple servers:

```json
{
  "code-search": {
    "type": "http",
    "url": "https://search.example.com/mcp"
  },
  "slack": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@example/slack-mcp@latest"]
  },
  "calendar": {
    "type": "stdio",
    "command": "uvx",
    "args": ["calendar-mcp"]
  },
  "figma": {
    "type": "http",
    "url": "http://127.0.0.1:3845/mcp"
  },
  "database": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@example/postgres-mcp"],
    "env": {
      "DATABASE_URL": "postgres://user:pass@localhost:5432/mydb"
    }
  }
}
```

## Commands

| Command | Description |
|---------|-------------|
| `/mcp` | List all servers with connection status (🟢/🟡/🔴/⚪) and tool counts |
| `/mcp-reload [server]` | Reconnect one server or all servers |
| `/mcp-cache-clear` | Clear the on-disk tool cache and reconnect |

## How It Works

### Startup

1. Reads `~/.pi/mcp.json` + `.pi/mcp.json`
2. Loads tool cache from `~/.pi/mcp-cache.json`
3. For each server:
   - If cache is valid → registers tools immediately (model can see them right away)
   - If no cache → registers a `connecting` placeholder
4. Connects to all servers in background (4 at a time)
5. When a server connects → replaces cached/placeholder tools with live ones, updates cache

### Tool Execution

- When a tool is called, the bridge looks up the server by name (not a captured reference — reconnect-safe)
- If the server is still connecting, waits up to 30 seconds before failing
- All text responses are truncated to PI's limits (50KB / 2000 lines)

### Reconnection

- If a server dies mid-session, the bridge detects it via `transport.onclose`
- Schedules reconnection with exponential backoff (1s → 2s → 4s → 8s → 15s → 30s cap)
- Up to 5 retry attempts before giving up
- `/mcp-reload` resets retries and reconnects immediately

### Cache Invalidation

- **Config change**: if a server's config changes, its cache is invalidated via SHA-256 hash comparison
- **TTL**: cache entries expire after 24 hours
- **Server notification**: if the MCP server supports `listChanged`, the bridge auto-refreshes tools in real-time
- **Manual**: `/mcp-cache-clear` wipes the cache

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `PI_MCP_CONFIG` | Override all config file loading — read only this file, no merging. Useful for scoping which MCPs a specific PI process gets access to. |

## Package Structure

```
pi-mcp-bridge/
├── package.json          # PI package manifest + @modelcontextprotocol/sdk dep
├── README.md
├── index.ts              # Entry point: lifecycle, tool registration, output truncation
├── types.ts              # Shared types and constants
├── cache.ts              # Disk cache (SHA-256 hash + TTL)
├── schema.ts             # JSON Schema → TypeBox conversion
├── server-manager.ts     # Connection lifecycle, reconnection, process cleanup
└── commands.ts           # /mcp, /mcp-reload, /mcp-cache-clear
```

## License

MIT
