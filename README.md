# NILO

An AI Minecraft bot powered by a [Letta](https://letta.ai) memory agent. NILO lives in your world, understands natural language, remembers what you teach it, and acts autonomously.

## Features

- **Natural language commands** — talk to NILO in-game in English or Portuguese (pt-BR)
- **Letta memory brain** — persistent memory and reasoning across sessions
- **Modded block support** — auto-maps Fabric registry sync packets so NILO knows modded block names and state IDs without hardcoding anything
- **Block physics teaching** — say "X is passable" or "X is solid" and NILO updates its pathfinding knowledge instantly
- **Entity teaching** — say "X is hostile" or "X is not hostile" and NILO remembers for combat
- **Multi-server switching** — named server profiles in `servers.json`; switch in-game or via CLI flag
- **EasyAuth support** — auto-registers and logs in on EasyAuth servers
- **Discord bridge** — chat with NILO and issue commands from Discord
- **Autonomous behaviors** — farming, fishing, combat, crafting, exploration, skill learning
- **Skill engine** — Voyager-style LLM-generated JS skills; learn, run, forget, and queue autonomously
- **Trust system** — only trusted players can give orders; MASTER has full control
- **SQLite knowledge base** — block physics, state ID mappings, entity hostility, named locations, and teaching history persisted in `nilo.db`
- **Fabric handshake handling** — responds to `owo:handshake`, `forgeconfigapiport`, and unknown plugin channels so Fabric servers don't kick the bot

## Requirements

- Node.js 18+
- A running Letta agent (set `LETTA_URL` env var)
- Minecraft server — Fabric 1.20.1 recommended (Prominence II modpack)
- (Optional) Discord bot token for the Discord bridge

## Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Set environment variables (or create a `.env` file):
   ```
   LETTA_URL=http://localhost:8283/v1/agents/<your-agent-id>/messages
   MASTER=YourMinecraftUsername
   DISCORD_TOKEN=...          # optional
   DISCORD_CHANNEL_ID=...     # optional
   DISCORD_MASTER_ID=...      # optional
   NILO_PASSWORD=nilo123      # for EasyAuth servers
   NILO_CODE_MODEL=llama3.1:8b  # Ollama model for skill generation
   ```

3. Edit `servers.json` to add your server:
   ```json
   {
     "myserver": {
       "host": "localhost",
       "port": 25565,
       "version": "1.20.1",
       "auth": "offline",
       "log_path": "/path/to/logs/latest.log",
       "description": "My server"
     }
   }
   ```

4. Start the bot:
   ```
   node nilo.js
   node nilo.js --server=myserver   # pick a specific profile
   ```

## In-Game Commands (MASTER only, no prefix needed)

### Navigation
`follow`, `come here`, `closer`, `stop`, `stay`, `unstuck`, `wander`, `explore`, `stop exploring`

### Combat
`attack`, `defensive`, `passive`, `use bow`, `shoot that`, `defend me`

### Activities
`fish`, `farm`, `build shelter`, `sleep`, `dance`, `collect my grave`

### Registry & Teaching
- `scan [radius]` — count all nearby blocks
- `echo scan [N]` — replay last scan to chat
- `blockmap <stateId> <mod:block>` — manually map a state ID
- `id <stateId>` — find where a state ID is in the world
- `<block> is <other block>` — alias one block name to another
- `<mob> is hostile` / `<mob> is not hostile` — teach entity hostility
- `<block> is solid` / `<block> is passable` — teach block physics
- `what do you know about <X>` — query NILO's knowledge

### "this" / "what is this"
Point at something and ask. NILO reports:
- Block: `oak_log at X Y Z [sid:1234]`
- Entity: `zombie (hostile mob [hostile] hp:18)`

### Server Switching
- `list servers` — show all profiles in servers.json
- `current server` — show active profile
- `switch server <name>` — disconnect and reconnect to a different profile
- `save server as <name>` — save the current connection as a named profile

### Skills
`learn <task>`, `do <skill>`, `forget <skill>`, `list skills`, `queue <task>`, `autonomous on/off`

### Other
`restart`, `trust <name>`, `untrust <name>`, `who do you trust`

## Architecture

See `agent/map.txt` for the full module map and dependency order.
See `agent/CHANGELOG.txt` for what was built in each session.
