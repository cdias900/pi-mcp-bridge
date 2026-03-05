# pi-mcp-bridge

MCP (Model Context Protocol) server bridge for PI. Connects to any MCP server and exposes its tools as native PI tools using the naming scheme `mcp__{server}__{tool}`.

## Install

```bash
pi install git:github.com/cdias900/pi-mcp-bridge
```

## Quick Start

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
