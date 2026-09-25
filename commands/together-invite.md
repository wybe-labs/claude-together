---
description: Create a room invite code to share with a friend (Claude Together)
argument-hint: <room-name>
---

Use the claude-together MCP server's create_invite tool with room_name "$ARGUMENTS" (if no name was given, use a short sensible name based on what we're working on). Show me the invite code prominently and remind me it's single-use, expires after the window the tool reports back (default 30 minutes, set by CLAUDE_TOGETHER_INVITE_TTL_MIN), and that I must keep this session open until my friend joins.
