#!/usr/bin/env python3
"""Claude Code status line: model, branch, PR, usage gauges, claude-together room state.

Renders one line from two sources: the JSON payload Claude Code writes to stdin, and
the claude-together store on disk. Every segment is optional — a project with no store
shows only the left-hand part, and a payload missing a field simply omits it, because a
status line that raises leaves you with no status line at all.

Store-path derivation mirrors claude-together's src/scope.js (scopedDir/projectKey), so
if that changes this must change with it. Originally from a recipe by Ronny's session.

  --demo   render sample payloads instead of reading stdin
  CLAUDE_STATUSLINE_ASCII=1   plain glyphs, for terminals without good Unicode
  CLAUDE_STATUSLINE_DUMP=1    write the raw payload for inspecting field names
"""
import getpass
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import unicodedata
from pathlib import Path

MAX_WIDTH = int(os.environ.get("CLAUDE_STATUSLINE_WIDTH", "120"))
ONLINE_WINDOW_MS = 120_000
PREVIEW_CHARS = 36
BRANCH_CHARS = 24
PR_CACHE_SECONDS = 120
GAUGE_WIDTH = 8

ASCII = bool(os.environ.get("CLAUDE_STATUSLINE_ASCII"))


def c(code):
    return f"\033[{code}m"


RESET = c(0)
BOLD = c(1)
GREY = c("38;5;243")
SLATE = c("38;5;249")
CYAN = c("38;5;80")
BLUE = c("38;5;75")
VIOLET = c("38;5;176")
GREEN = c("38;5;114")
AMBER = c("38;5;179")
ORANGE = c("38;5;215")
RED = c("38;5;203")
TEAL = c("38;5;73")

ICONS = {
    "model": "✦", "dir": "▌", "branch": "⑂", "pr": "◉", "draft": "◔",
    "clock": "◷", "cost": "≡", "room": "⛓", "mail": "✉", "chat": "💬",
    "on": "●", "off": "○", "zap": "⚡", "sep": "│",
    "bar_full": "█", "bar_half": "▌", "bar_empty": "░",
    "cap_l": "▐", "cap_r": "▌",
}
ASCII_ICONS = {
    "model": "*", "dir": "|", "branch": "@", "pr": "#", "draft": "~",
    "clock": ">", "cost": "$", "room": "[]", "mail": "M", "chat": ">>",
    "on": "+", "off": "-", "zap": "!", "sep": "|",
    "bar_full": "#", "bar_half": "=", "bar_empty": ".",
    "cap_l": "[", "cap_r": "]",
}


def ico(name):
    return (ASCII_ICONS if ASCII else ICONS)[name]


def read_json(path, default):
    try:
        # The store writes UTF-8; utf-8-sig also tolerates a hand-edited file with a BOM.
        # Without an explicit encoding Windows reads with the locale code page.
        return json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return default


def project_dir(payload):
    workspace = payload.get("workspace") or {}
    # abspath, not resolve(): Node's path.resolve does not follow symlinks or
    # junctions, and the store key has to be computed from the same string it used.
    return Path(os.path.abspath(workspace.get("project_dir") or payload.get("cwd") or os.getcwd()))


def store_dir(project):
    override = os.environ.get("CLAUDE_TOGETHER_DIR")
    if override:
        return Path(override)
    # Mirrors projectKey() in src/scope.js, including case-folding on case-insensitive
    # filesystems. Without it, on Windows and macOS this hashed "C:\Users\...\Project"
    # while the server hashed "c:\users\...\project", and never found the store.
    key = str(project).lower() if sys.platform in ("win32", "darwin") else str(project)
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:12]
    base = re.sub(r"[^A-Za-z0-9._-]", "_", project.name or "root")[:40]
    return Path.home() / ".claude-together" / "projects" / f"{base}-{digest}"


def git(project, *args, timeout=1):
    try:
        done = subprocess.run(["git", "-C", str(project), *args],
                              capture_output=True, text=True, timeout=timeout, check=False)
        return done.stdout.strip() if done.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


def shorten(text, limit):
    return text if len(text) <= limit else text[: limit - 1] + ("…" if not ASCII else "~")


def heat(percent):
    """Colour by how much trouble the number represents, not by which number it is."""
    if percent >= 95:
        return RED
    if percent >= 80:
        return ORANGE
    if percent >= 50:
        return AMBER
    return GREEN


def gauge(percent, width=GAUGE_WIDTH):
    """A fill bar. Any non-zero value shows at least a half block: a 7% window that
    renders as an empty bar reads as "nothing used", which is the wrong impression to
    give about a limit that is already ticking."""
    pct = max(0.0, min(100.0, float(percent)))
    exact = pct / 100 * width
    full = int(exact)
    half = full < width and ((exact - full) >= 0.5 or (full == 0 and pct > 0))
    filled = ico("bar_full") * full + (ico("bar_half") if half else "")
    empty = ico("bar_empty") * (width - full - (1 if half else 0))
    tone = heat(pct)
    return (f"{GREY}{ico('cap_l')}{RESET}{tone}{filled}{RESET}"
            f"{GREY}{empty}{ico('cap_r')}{RESET}")


def percent_text(percent):
    pct = int(round(percent))
    return f"{heat(pct)}{BOLD}{pct}%{RESET}"


def clock(epoch_seconds):
    return time.strftime("%H:%M", time.localtime(epoch_seconds))


def head_segment(payload, project):
    parts = []
    model = (payload.get("model") or {}).get("display_name", "")
    if model:
        parts.append(f"{CYAN}{ico('model')} {BOLD}{model}{RESET}")
    parts.append(f"{BLUE}{ico('dir')}{RESET}{BLUE}{BOLD}{project.name}{RESET}")
    branch = git(project, "rev-parse", "--abbrev-ref", "HEAD")
    if branch:
        parts.append(f"{VIOLET}{ico('branch')} {shorten(branch, BRANCH_CHARS)}{RESET}")
    pr = pr_segment(project, branch)
    if pr:
        parts.append(pr)
    return " ".join(parts)


def pr_segment(project, branch):
    """PR for the current branch, from a cache a detached refresh keeps warm.

    Never queries the network inline: a status line that waits on gh is one that
    stutters. A cold cache shows nothing this refresh and is right on the next.
    """
    if not branch or branch == "HEAD":
        return ""
    cache = pr_cache_path(project)
    cached = read_json(cache, {})
    fresh = cached.get("branch") == branch and time.time() - cached.get("at", 0) < PR_CACHE_SECONDS
    if not fresh:
        # Claim the refresh first, so the renders that follow in the next second see a
        # fresh entry instead of each starting another one.
        write_json_atomic(cache, {"branch": branch, "at": time.time(),
                                  "pr": cached.get("pr") if cached.get("branch") == branch else None})
        spawn_pr_refresh(project, branch, cache)
    pr = cached.get("pr") if cached.get("branch") == branch else None
    if not pr:
        return ""
    draft = bool(pr.get("draft"))
    tone = AMBER if draft else GREEN
    return f"{tone}{ico('draft') if draft else ico('pr')}{pr['number']}{RESET}"


def pr_cache_path(project):
    """One cache per project: a single shared file meant two repos both on "main"
    showed each other's PR, and sessions on different branches kept invalidating it."""
    key = str(project).lower() if sys.platform in ("win32", "darwin") else str(project)
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:12]
    return Path.home() / ".claude" / f"claude-together-statusline-pr-{digest}.json"


def write_json_atomic(path, value):
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(value), encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        pass


def spawn_pr_refresh(project, branch, cache):
    """Refresh the PR cache in a detached copy of this script.

    No shell, on purpose. This used to be `bash -lc "<string>"` with the project path
    and branch name interpolated into it: a branch named x$(touch${IFS}pwned) is a
    valid git ref and ran on the first render in a cloned repo. And on Windows,
    "bash" resolves to WSL's System32\\bash.exe before Git Bash, which read the Windows
    cache path as a relative Linux filename, wrote junk into the project, and never
    updated the real cache, so every render started another login shell.
    """
    args = [sys.executable, os.path.abspath(__file__), "--refresh-pr", str(project), branch, str(cache)]
    kwargs = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL,
              "stderr": subprocess.DEVNULL, "close_fds": True}
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    try:
        subprocess.Popen(args, **kwargs)
    except OSError:
        pass


def refresh_pr(project, branch, cache):
    pr = None
    try:
        done = subprocess.run(["gh", "pr", "view", "--json", "number,state,isDraft"],
                              cwd=project, capture_output=True, text=True, encoding="utf-8",
                              timeout=20, **({"creationflags": subprocess.CREATE_NO_WINDOW}
                                             if sys.platform == "win32" else {}))
        if done.returncode == 0:
            data = json.loads(done.stdout)
            pr = {"number": data.get("number"), "state": data.get("state"), "draft": bool(data.get("isDraft"))}
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass  # no gh, no PR, offline: cache "no PR" rather than retrying every render
    write_json_atomic(Path(cache), {"branch": branch, "at": time.time(), "pr": pr})


def usage_segments(payload):
    segments = []
    context = payload.get("context_window") or {}
    if "used_percentage" in context:
        size = context.get("context_window_size") or 0
        scale = f"{GREY}/{int(size / 1000)}k{RESET}" if size else ""
        segments.append(f"{gauge(context['used_percentage'])} "
                        f"{percent_text(context['used_percentage'])}{scale} {GREY}ctx{RESET}")
    limits = payload.get("rate_limits") or {}
    for key, label in (("five_hour", "5h"), ("seven_day", "7d")):
        window = limits.get(key) or {}
        if "used_percentage" not in window:
            continue
        reset = (f" {GREY}{ico('clock')}{clock(window['resets_at'])}{RESET}"
                 if window.get("resets_at") else "")
        segments.append(f"{SLATE}{label}{RESET} {gauge(window['used_percentage'], 5)} "
                        f"{percent_text(window['used_percentage'])}{reset}")
    cost = (payload.get("cost") or {}).get("total_cost_usd")
    if cost is not None:
        segments.append(f"{TEAL}{ico('cost')}{cost:.2f}{RESET}")
    return segments


def rooms_segment(store, config):
    now = time.time() * 1000
    parts = []
    for room_id, room in (config.get("rooms") or {}).items():
        members = read_json(store / "members" / f"{room_id}.json", {})
        who = []
        for name, m in members.items():
            online = now - m.get("lastSeen", 0) < ONLINE_WINDOW_MS
            dot = f"{GREEN}{ico('on')}" if online else f"{GREY}{ico('off')}"
            who.append(f"{dot}{SLATE}{name}{RESET}")
        zap = f"{AMBER}{ico('zap')}{RESET}" if room.get("allowInterrupt") else ""
        crowd = " ".join(who) if who else f"{GREY}empty{RESET}"
        parts.append(f"{TEAL}{room.get('name', room_id)}{RESET}{zap} {crowd}")
    return f"{TEAL}{ico('room')}{RESET} " + f" {GREY}{ico('sep')}{RESET} ".join(parts) if parts else ""


def unread_segment(store):
    inbox = store / "inbox"
    count = len(list(inbox.glob("*.json"))) if inbox.is_dir() else 0
    return f"{AMBER}{BOLD}{ico('mail')}{count}{RESET}" if count else ""


def last_incoming_segment(store, me):
    logs = store / "log"
    latest = None
    for log in sorted(logs.glob("*.jsonl")) if logs.is_dir() else []:
        try:
            lines = log.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for line in lines:
            try:
                message = json.loads(line)
            except ValueError:
                continue
            if message.get("kind") == "presence" or message.get("from") == me:
                continue
            if latest is None or message.get("ts", 0) > latest.get("ts", 0):
                latest = message
    if not latest:
        return ""
    age = max(0, int(time.time() - latest.get("ts", 0) / 1000))
    age_text = f"{age}s" if age < 60 else f"{age // 60}m" if age < 3600 else f"{age // 3600}h"
    text = str(latest.get("text", "")).replace("\n", " ")
    return (f"{ico('chat')} {VIOLET}{latest.get('from', '?')}{RESET} "
            f"{SLATE}{shorten(text, PREVIEW_CHARS)}{RESET} {GREY}{age_text}{RESET}")


def together_segments(project):
    store = store_dir(project)
    config = read_json(store / "config.json", None)
    if config is None:
        return []
    # The display name lives in the machine-wide identity file, not the project store
    # (unless CLAUDE_TOGETHER_DIR points everything at one store). $USER is usually
    # unset on Windows, and wrong for anyone who used set_display_name.
    identity = config if os.environ.get("CLAUDE_TOGETHER_DIR") else \
        read_json(Path.home() / ".claude-together" / "config.json", {})
    me = identity.get("name") or config.get("name") or getpass.getuser()
    return [s for s in (rooms_segment(store, config),
                        unread_segment(store),
                        last_incoming_segment(store, me)) if s]


ANSI_RE = re.compile(r"\033\[[0-9;]*m")


def visible_width(text):
    """Columns the text occupies: escape codes are free, wide glyphs cost two."""
    bare = ANSI_RE.sub("", text)
    width = 0
    for ch in bare:
        if unicodedata.combining(ch):
            continue
        width += 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
    return width


def pack(segments, limit):
    """Greedily fill lines up to the limit, never splitting a segment.

    Wrapping inside a gauge or a name would be worse than a short line, so a segment
    that cannot fit anywhere gets a line of its own and is allowed to overflow.
    """
    joiner = f" {GREY}{ico('sep')}{RESET} "
    joiner_width = visible_width(joiner)
    lines, current, width = [], [], 0
    for segment in segments:
        seg_width = visible_width(segment)
        extra = seg_width + (joiner_width if current else 0)
        if current and width + extra > limit:
            lines.append(joiner.join(current))
            current, width = [segment], seg_width
        else:
            current.append(segment)
            width += extra
    if current:
        lines.append(joiner.join(current))
    return lines


def render(payload):
    project = project_dir(payload)
    segments = [s for s in (head_segment(payload, project),
                            *usage_segments(payload),
                            *together_segments(project)) if s]
    return "\n".join(pack(segments, MAX_WIDTH))


DEMOS = {
    "typical": {
        "model": {"display_name": "Opus 5 (1M context)"},
        "workspace": {"project_dir": "/home/kacper/code/zivid-sdk"},
        "context_window": {"used_percentage": 67.4, "context_window_size": 1000000},
        "rate_limits": {"five_hour": {"used_percentage": 7, "resets_at": time.time() + 7000},
                        "seven_day": {"used_percentage": 29, "resets_at": time.time() + 90000}},
        "cost": {"total_cost_usd": 0.5612},
    },
    "getting warm": {
        "model": {"display_name": "Opus 5"},
        "workspace": {"project_dir": "/home/kacper/code/zivid-sdk"},
        "context_window": {"used_percentage": 84, "context_window_size": 1000000},
        "rate_limits": {"five_hour": {"used_percentage": 62, "resets_at": time.time() + 3000},
                        "seven_day": {"used_percentage": 55}},
        "cost": {"total_cost_usd": 4.2},
    },
    "in trouble": {
        "model": {"display_name": "Opus 5"},
        "workspace": {"project_dir": "/home/kacper/code/zivid-sdk"},
        "context_window": {"used_percentage": 97, "context_window_size": 1000000},
        "rate_limits": {"five_hour": {"used_percentage": 91, "resets_at": time.time() + 600},
                        "seven_day": {"used_percentage": 99, "resets_at": time.time() + 40000}},
        "cost": {"total_cost_usd": 31.07},
    },
    "empty payload": {},
}


def main():
    # Claude Code reads the status line from a pipe, and on Windows Python encodes a
    # pipe with the locale code page (cp1252 here): the first ✦ or peer emoji raised
    # UnicodeEncodeError and there was no status line at all.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
    if len(sys.argv) >= 5 and sys.argv[1] == "--refresh-pr":
        refresh_pr(sys.argv[2], sys.argv[3], sys.argv[4])
        return
    if "--demo" in sys.argv:
        for label, payload in DEMOS.items():
            print(f"{GREY}{label}:{RESET}")
            print(render(payload))
        return
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        payload = {}
    if os.environ.get("CLAUDE_STATUSLINE_DUMP"):
        try:
            (Path.home() / ".claude" / "claude-together-statusline-last.json").write_text(
                json.dumps(payload, indent=2))
        except OSError:
            pass
    # A status line that raises leaves nothing on screen; fall back to the model name.
    try:
        line = render(payload)
    except Exception:
        line = str((payload.get("model") or {}).get("display_name") or "")
    print(line)


if __name__ == "__main__":
    main()
