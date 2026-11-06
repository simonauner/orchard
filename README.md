# Agent Workspace

Minimal Electron-app som startar flera Claude Code-processer och strömmar svaren till ett chattgränssnitt.

## Kom igång

```bash
npm install
npm start
```

Kräver att `claude` finns i PATH och att du är inloggad (kör `claude` en gång i terminalen).

## Agenter och worktrees

Ange ett uppgiftsnamn, klicka "+ Ny agent" och välj ett git-repo. Appen kör
`git worktree add -b agent/<uppgift> <repo>-worktrees/<uppgift>` och startar claude där.
Claude körs med `--permission-mode acceptEdits`: filändringar i worktreen godkänns direkt,
andra verktyg (t.ex. Bash) nekas och visas som "⛔ nekad" i chatten.

"×" stoppar agenten och kör `git worktree remove` (utan `--force`). Har worktreen ändringar
som inte är committade vägrar git, och worktreen ligger kvar. Grenen `agent/<uppgift>` behålls alltid.
Worktrees tas inte bort när appen avslutas.

## Struktur

- `agent.js` – `createWorktree`/`removeWorktree` och en `Agent` = en `claude -p --input-format stream-json --output-format stream-json --verbose`-process. Läser JSON-rader från stdout, skriver JSON-rader till stdin. Ingen Electron-beroende, går att testa själv (`npm test`).
- `main.js` – Electron-huvudprocess. Håller listan över agenter, startar dem, skickar händelser till gränssnittet via IPC, visar skrivbordsnotis när en agent blir klar och stoppar alla processer vid avslut.
- `preload.js` – smal brygga (`window.agents`) mellan gränssnittet och huvudprocessen.
- `renderer/` – sidolista med status + chattvy.

## Nästa steg

1. Behörighetsfrågor som knappar (kräver Agent SDK eller `--permission-prompt-tool`).
2. Diffvy per agent.
3. Spara sessioner (`sessionId` finns redan på `Agent`) och återuppta med `--resume`.
