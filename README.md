# pi-mcp-bridge

`pi-mcp-bridge` is a PI extension that connects to one or more MCP (Model Context Protocol) servers and exposes each MCP tool as a PI tool using the naming scheme `mcp__{server}__{tool}`. It supports stdio- and HTTP-based MCP servers and includes a disk cache so tool lists can be registered immediately while servers connect in the background.

## Install

```bash
pi install git:github.com/cdias900/pi-mcp-bridge
```

## Configuration

PI MCP config files:

1. Global: `~/.pi/mcp.json`
2. Project-local (overrides global per server name): `.pi/mcp.json` (relative to the project root / current working directory)

Both files use the same format:

### stdio example

```json
{
  "my-server": {
    "type": "stdio",
    "command": "uvx",
    "args": ["some-mcp"],
    "env": {
      "MY_TOKEN": "..."
    }
  }
}
```

### HTTP example (Streamable HTTP with SSE fallback)

```json
{
  "remote-server": {
    "type": "http",
    "url": "https://example.com/mcp"
  }
}
```

## Commands

- `/mcp` — list servers, connection status, and tool counts
- `/mcp-reload [server-name]` — reconnect a single server or all servers
- `/mcp-cache-clear` — clear the on-disk tool cache

## Environment Overrides

- `PI_MCP_CONFIG=/path/to/mcp.json` — load **only** this config file (no global/project merging). This is useful for subagent scoping.

## Caching

Discovered tool lists are cached to `~/.pi/mcp-cache.json` (per server, with a config hash + TTL). On `session_start`, cached tools are registered immediately (marked as “cached — connecting...”) so they appear in PI right away, while the bridge connects to servers in the background and refreshes tool definitions once live discovery succeeds.
