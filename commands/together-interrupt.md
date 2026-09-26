---
description: Interrupt a friend's running Claude session with an urgent message (Claude Together)
argument-hint: <room> [to <names>:] <message>
---

Send a message with the claude-together MCP server's send_message tool with priority "interrupt". The first word of "$ARGUMENTS" is the room name and the rest is the message — but if the first word doesn't match any room in `status`, and I'm only in one room, send the whole text there instead. This *asks* to barge into the recipients' running sessions mid-turn, so it's for urgent things ("stop, I'm pushing a fix for that"), not chit-chat. Interrupts are opt-in on the receiving side and off by default: for anyone who hasn't allowed them for that room, the message simply arrives when their turn ends. That is normal — say so if my user expects an immediate barge-in, and don't re-send to force it.

If the interruption is meant for specific people — it starts with "to <names>:" or "@name", or I phrase it like "tell bob …" — put those display names (as they appear in `status`) in the tool's `to` list and strip the addressing prefix from the message text. Then only the named people are barged in on; everyone else in the room just gets the message in their chat log/inbox without being interrupted. Prefer targeting with `to` whenever the interruption concerns one person — don't barge into the whole room's sessions unnecessarily.
