---
description: Create a room invite code to share with a friend (Claude Together)
argument-hint: <room-name>
---

Use the claude-together MCP server's create_invite tool with room_name "$ARGUMENTS" (if no name was given, use a short sensible name based on what we're working on). Show me the invite code prominently and remind me: it's single-use, it expires after the number of minutes the tool reports, I should send it to my friend privately (anyone holding it can join), and I must keep this session open until they have joined. There is nothing to confirm afterwards — once they say "join room <code>", they're in.
