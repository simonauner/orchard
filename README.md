# Agent Workspace

Minimal Electron app that runs several Claude Code processes and streams their replies to a chat UI.

## Getting started

```bash
npm install
npm start
```

Requires `claude` on your PATH and a logged-in session (run `claude` once in a terminal).

## Agents and worktrees

Enter a task name, click "+ Ny agent" and pick a git repo. The app runs
`git worktree add -b agent/<task> <repo>-worktrees/<task>` and starts claude there.
Claude runs with `--permission-mode acceptEdits`: file edits inside the worktree are approved
automatically, other tools (e.g. Bash) are denied and shown as "⛔ nekad" in the chat.

"×" stops the agent and runs `git worktree remove` (without `--force`). If the worktree has
uncommitted changes, git refuses and the worktree stays. The `agent/<task>` branch is always kept.
Worktrees are not removed when the app quits.

## Structure

- `agent.js` – `createWorktree`/`removeWorktree` and an `Agent` = one `claude -p --input-format stream-json --output-format stream-json --verbose` process. Reads JSON lines from stdout, writes JSON lines to stdin. No Electron dependency, testable on its own (`npm test`).
- `main.js` – Electron main process. Keeps the list of agents, starts them, forwards events to the UI over IPC, shows a desktop notification when an agent finishes and stops all processes on quit.
- `preload.js` – thin bridge (`window.agents`) between the UI and the main process.
- `renderer/` – sidebar with status + chat view.

## Next steps

1. Permission prompts as buttons (needs the Agent SDK or `--permission-prompt-tool`).
2. Diff view per agent.
3. Persist sessions (`sessionId` already exists on `Agent`) and resume with `--resume`.
