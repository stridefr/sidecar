# Sidecar

A translucent, always-on-top companion for the Claude Code sessions you already
have open in Antigravity. Read what any of them is doing, answer what they're
blocked on, approve their edits, and send prompts into whichever one you
choose — without pulling the IDE forward and burying everything else.

> Windows only, for now. The window-targeting and keystroke delivery are
> written against Win32 APIs.

## What it does

- **Reads your sessions live.** Tails `~/.claude/projects/**/*.jsonl`, so the
  transcript, title, and status come straight from disk. No API calls.
- **Tells you who needs you.** Derives *Running*, *Thinking*, *Answer*,
  *Review*, and *Idle* from the last record in each transcript.
- **Sends prompts** into any open session, with screenshots pasted or dragged
  in, and optional dictation.
- **Answers multiple-choice questions** without opening the IDE.
- **Shows real usage** — tokens and cost counted from transcripts and priced
  per model, alongside your plan's session/weekly percentages.
- **Reads *and* sends independently.** Watch one session grind through a long
  task while typing into another.

## Running from source

```bash
cd app
npm install
npm start
```

`Ctrl+Alt+Space` opens the prompt box from anywhere; `Ctrl+Alt+S` shows or
hides the main window. Both are rebindable in Settings. It lives in the tray.

## One-time setup

Sidecar types into Antigravity the way you would: it brings the window
forward, focuses Claude's input box, pastes, and presses Enter.

Focusing *the input box specifically* needs a keyboard shortcut, and the
Claude Code extension's built-in one only fires when an editor already has
focus — never true when the keystroke arrives from another app. So Sidecar
adds three shortcuts to Antigravity's own `keybindings.json`:

| Shortcut | Command |
| --- | --- |
| `Ctrl+Alt+Shift+0` | `claude-vscode.focus` — focus Claude's input |
| `Ctrl+Alt+Shift+Y` | `claude-vscode.acceptProposedDiff` |
| `Ctrl+Alt+Shift+N` | `claude-vscode.rejectProposedDiff` |

**Settings → Sending & approving → Add shortcuts.** Your existing file is
backed up first, and the installer refuses to touch a file it can't parse.

## Building an installer

```bash
cd app
npm run dist        # builds dist/Sidecar Setup <version>.exe, publishes nothing
```

Releases are built by CI, not by hand. Pushing a `v*.*.*` tag is what triggers
a build — that's the whole mechanism, so bumping the version *is* cutting the
release:

```bash
cd app
npm run release:patch    # or release:minor / release:major
```

That runs `npm version`, which bumps `package.json`, commits, tags `vX.Y.Z`,
and pushes both. [`.github/workflows/release.yml`](.github/workflows/release.yml)
sees the tag, builds the Windows installer on a GitHub-hosted runner, and
uploads it plus a `latest.yml` manifest to a matching GitHub Release —
publicly visible under [Releases](https://github.com/stridefr/sidecar/releases)
the moment it finishes. It also refuses to publish if the tag and
`package.json`'s version ever disagree.

Installed copies check on launch and then daily, show a banner when a new
version appears, and **never download without asking**.

`npm run dist` still exists for a local build with nothing published — useful
for testing packaging changes without creating a public release.

Auto-update only works in a packaged build — running from source there is no
installer to replace, and Settings says so rather than reporting a fake
"up to date".

## What it deliberately doesn't do

- **No API calls.** Everything comes from files Claude Code already wrote.
- **No writing to transcripts.** Sidecar only ever reads them.
- **No fake plan numbers.** Session/weekly percentages come from a cache
  Claude Code refreshes on its own schedule; when it's stale the UI says how
  old it is instead of implying it's live, and shows a *measured* figure
  counted from transcripts beside it.

## Known limits

- **Antigravity surfaces briefly when sending.** Windows only delivers
  synthesised keystrokes to the foreground window. Sidecar restores whatever
  was in front afterwards (and re-minimises Antigravity if it started
  minimised), but it cannot avoid the moment itself.
- **Shift+Enter as "queue"** is inferred from the transcript format, not
  confirmed against the extension. It's labelled `⇧↵ queue?` for that reason.
- **Dictation** uses the Web Speech API, which is not reliably backed in every
  Electron build. If it fails it says so and points at `Win+H`.
- **Clear window mode has no blur.** Only the OS compositor can blur what sits
  behind a window; CSS can't reach it. Glass mode has real blur but obeys
  Windows' *Transparency effects* switch.

## Layout

```
app/
  main.js            window lifecycle, hotkeys, IPC, update checks
  preload.js         the contextBridge surface
  lib/
    sessions.js      transcript tailing, status, paging, edit extraction
    controller.js    grouping and policy — what's shown, and how
    windows.js       finds live Antigravity windows (lock files + pid + title)
    send.js          the whole send sequence, in one PowerShell pass
    keybindings.js   installs the shortcuts into Antigravity
    plan.js          plan usage from ~/.claude.json
    pricing.js       per-model cost maths
    diff.js          line diffs for the Edits panel
    updater.js       GitHub release checks
    store.js         settings, pins, hues, read state
  renderer/          both windows' UI
mockups.html         the design the app was built from
```

## License

MIT
