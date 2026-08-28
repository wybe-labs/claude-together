---
description: Hand off this Claude Code session to a friend's machine (Claude Together)
argument-hint: <room> [title]
---

Hand off the current session with the claude-together MCP server's offer_handoff tool. The first word of "$ARGUMENTS" is the room name and any rest is the title — but if the first word doesn't match any room in `status`, and I'm only in one room, use that room and treat the whole text as the title.

Before calling the tool, tell me exactly what leaves this machine: the full user/assistant conversation text of this session (tool calls and thinking are stripped) goes to every peer currently connected in that room, and ask me to confirm. After sending, report how many peers received the offer and remind me they each have to explicitly import it (with /together-import) on their side.
