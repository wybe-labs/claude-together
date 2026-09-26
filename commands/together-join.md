---
description: Answer a friend's pairing rendezvous (Claude Together)
argument-hint: <rendezvous-id>
---

Use the claude-together MCP server's join_room tool with the id "$ARGUMENTS".

This does NOT join the room by itself. It connects and comes back with a six-digit number. Show that number to me prominently and tell me to compare it with my friend **out of band** — on a call or in person, not in the channel where the id was shared. Do not call confirm_pairing until I tell you the numbers matched, and pass exactly the number I confirm.

If more than one peer answered, show me every number with the name, host and key fingerprint beside it, and say plainly that only one of them is my friend. If the numbers do not match, do not confirm anything: tell me someone else answered, and offer cancel_pairing.

There is no timeout. If nobody has answered yet, say the rendezvous is open and that I will be told when they appear — do not retry or ask for a new id.
