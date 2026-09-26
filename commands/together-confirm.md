---
description: Confirm a pairing after comparing the six-digit number (Claude Together)
argument-hint: <rendezvous-id> <six digits>
---

Use the claude-together MCP server's confirm_pairing tool. The first word of "$ARGUMENTS" is the rendezvous id and the rest is the number — but if only a number was given and exactly one pairing is open in `status`, use that one.

Only do this when I have actually compared the number with the other person out of band. That number is the only thing separating the pairing from whoever else may have picked up the rendezvous id, so never guess it, never read it back from the tool output as if I had confirmed it, and never confirm on my behalf to move things along.

After confirming, tell me whether the pairing completed or is waiting on the other side, and report the peer's name and key fingerprint.
