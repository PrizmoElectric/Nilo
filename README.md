# NILO

An AI Minecraft bot for Mineflayer powered by a Letta memory agent. NILO lives in your world, understands natural language, and can act autonomously.

## Features

- Natural language commands via in-game chat
- AI brain powered by [Letta](https://letta.ai) (persistent memory and reasoning)
- Autonomous behaviors: farming, combat, pathfinding, crafting
- Discord bridge — chat with NILO from Discord
- Trust system — only trusted players can give orders
- Skill engine — modular, extensible skill files

## Requirements

- Node.js 18+
- A running Letta agent
- Minecraft server (offline mode, 1.20.1)
- (Optional) Discord bot token for the Discord bridge

## Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in your values:
   ```
   cp .env.example .env
   ```

3. Edit `config.js` to set your server host, port, and Letta agent URL.

4. Start the bot:
   ```
   node nilo.js
   ```

## Usage

In-game, talk to NILO by name or whisper to it. Trusted players can issue commands directly. The bot reads the server log and reacts to nearby players automatically.
