# Code Mirror (代码镜子)

English | [中文](README.zh-CN.md)

Code Mirror shows the changes in a git repository side by side and sends them to a model for review. Each problem it finds is pinned under the line it refers to. Every problem can then be assigned to someone, and the whole work chain is recorded: found, assigned, fixed, rechecked. The four panels can be dragged anywhere.

It is modeled on "Review Changes" in GitLens for VS Code, and runs as a small standalone program: a local service plus a web page.

Signed: JINGLEIW=FFAX · License: MIT

> The user interface is currently in Chinese only.

---

## 1. Features

### 1.1 Seeing the changes (the mirror)

- **Two ways to compare**
  - **Two branches**, for example `main ⇄ feature/login`: shows what the right side changed relative to the left. The algorithm is the same as `git diff left...right`, which measures from the point where the two branches diverged. The header shows how many commits the right side is ahead and behind.
  - **Uncommitted changes**: the working tree compared with the last commit, including new files that are not yet tracked by git.
- **Changed files**: grouped by folder. Each file is marked added (A), modified (M), deleted (D) or renamed (R), with the number of lines added and removed, and you can search by file name. When there are 300 files or fewer, all folders start expanded.
- **Side-by-side diff**: the old version on the left, the new one on the right. Red marks removed lines, green marks added lines. Long lines wrap, and unchanged stretches are collapsed. Binary files, very large diffs (over 1.5 MB) and renames without content changes get a short explanation instead of a forced rendering.

### 1.2 Reviewing the changes

- "审查差异" (Review Changes) reviews every change. "只审这个文件" (Review This File) reviews only the open file.
- Problems are grouped into focus areas. Each one states the file, line, severity (high / medium / low), the problem, why it matters and how to fix it.
- Each problem appears right under the line it refers to in the diff. Clicking the file name on a problem opens that file, scrolls to the line and highlights it briefly.
- When not everything fits into one review (too many or too large), the page lists which files were reviewed, which were not, and why.
- Every result is saved locally. When you reopen the same comparison, the latest result comes back, labeled with the time of the review.
- If the model cannot be reached or does not exist, the page says so plainly instead of making up results.

### 1.3 Work chain

Every problem can be handed off, which records it as a work item (W1, W2, …):

| Hand to | What happens |
|---|---|
| **Claude 去改** (Claude fixes it) | The program runs Claude Code in your repository to fix this one problem, then rechecks automatically. Shown only when Claude Code is the review engine |
| **复制给别的 AI** (Copy to another AI) | The problem is written up as a prompt and copied to the clipboard for you to paste into another AI. When it is fixed, click "改好了，去复查" (Fixed, recheck) |
| **我自己改** (I'll fix it myself) | You make the fix. When it is done, click "改好了，去复查" (Fixed, recheck) |

- **Recheck**: the original problem and the full current text of the file, with line numbers, go to the reviewer with one question: is the problem still there? The verdict is "passed" or "failed", with the reason.
- Every step is recorded with its time, who acted and what they did: problem found → assigned → fixed (or no change) → recheck passed / failed → closed.
- States: unassigned, assigned, fixing, rechecking, resolved, recheck failed, no change, error, interrupted, closed. If the service stops in the middle of a step, that step is recorded as "interrupted".

### 1.4 Free drag-and-drop layout

- Four panels: changed files, side-by-side diff, review, and work chain.
- Drag a panel by its tab to any position: above, below, left, right, or stacked as tabs. Drag the gap between panels to resize them.
- The layout is remembered. "面板" (Panels) at the top brings back a closed panel, and "恢复默认布局" (Reset layout) restores the default.

---

## 2. Implementation

### Overall structure

```
Web page in the browser (React)
        │  connects only to 127.0.0.1:8795 on this machine
        ▼
Local service server.mjs (Node, no third-party packages)
        ├── git ……………………………… computes changes and per-file diffs
        ├── Claude Code CLI …………… review, automatic fixes, rechecks (default)
        └── OpenAI-compatible model service … review and rechecks (optional, e.g. a local Ollama)
        │
        ▼
Local data/ folder: review results and work chains (never uploaded)
```

### How the changes are computed

| What | git command |
|---|---|
| Lines added and removed per file | `git diff --numstat -z -M <range>` |
| Added, modified, deleted or renamed | `git diff --name-status -z -M <range>` |
| New files not yet tracked | `git ls-files --others --exclude-standard -z` |
| Commits ahead and behind | `git rev-list --left-right --count left...right` |
| The diff of one file | `git diff -M <range> -- <file>`; for an untracked file, `git diff --no-index -- /dev/null <file>` |

The range is `left...right` when comparing two branches, and `HEAD` for uncommitted changes. The page renders each file's diff as a side-by-side view with the `PatchDiff` component from `@pierre/diffs` (`diffStyle: 'split'`), and places review findings under their lines with its line annotations (`lineAnnotations`).

### How a review works

1. **Choosing the files**: code files come first, then smaller changes. Binary files, dependency lock files and deleted files are skipped. One review sends at most 200,000 characters of changes (60,000 with a local model) and looks at no more than 400 files. A single file whose diff takes more than half of that budget is left for its own review.
2. **Sending to the model**
   - **Claude Code**: `claude -p … --output-format json --json-schema <result format> --system-prompt <review rules> --tools "" --strict-mcp-config --setting-sources project --no-session-persistence --permission-prompts none`. The changes go in through standard input, and it runs in a temporary folder. All tools are off, no external services are connected and no session is kept, so it sees only the changes it was given. The result comes from the `structured_output` field, and `--json-schema` guarantees its shape.
   - **OpenAI-compatible service**: calls `/v1/chat/completions` with `stream: true`, asks for a single JSON object, and extracts it from the answer. The answer is streamed because Node's `fetch` gives up after five minutes without response headers or between body chunks (undici's `headersTimeout` and `bodyTimeout`), and a model that thinks before it answers can take longer than that. One request may take up to 15 minutes.
3. **Cleaning up the result**: only high, medium and low count as severities (anything else is recorded as unmarked). Each finding's file is checked against the files in this review. The result is saved as `data/runs/<id>.json`.

### How the work chain is recorded

- One record per repository: `data/work/<fingerprint of the repository path>.json`. It holds the list of work items. Each item keeps the problem itself, the review it came from, its state, who it was assigned to, and a list of events (time, who, what, details).
- Writes to one repository's record are serialized, so a background job and a page request never overwrite each other.
- **Claude fixes it**: runs `claude -p <the problem and fix instructions> --tools Read,Edit,Glob,Grep --permission-mode acceptEdits --permission-prompts none --strict-mcp-config --setting-sources project` in the repository folder. It can only read and edit files: no shell commands, no commits. A fingerprint of the file is taken before and after, to tell whether it really changed anything. The session is kept and its ID is written into the chain, so it can be traced later.
- **Recheck**: the original problem and the full current text of the file, numbered line by line so the reason cites the right lines (up to 150,000 characters), go to the reviewer, which answers in the form `{ fixed: true/false, reason: "…" }`.
- The page refreshes background jobs every 3 seconds. After a service restart, unfinished jobs are recorded as "interrupted".

### How the drag-and-drop layout works

It uses the open-source dockview (`dockview-react`, MIT). The four panels are registered as components, and the default layout is placed in `onReady`. Whenever the layout changes it is saved with `toJSON()` into the browser's local storage, and the next time it is restored with `fromJSON()`.

### Local service API

| Method | Path | What it does |
|---|---|---|
| GET | `/api/config` | Default repository and review engine |
| GET | `/api/model` | Whether the reviewer is available |
| GET | `/api/repo?path=` | Repository root, current branch, branch list |
| GET | `/api/changes?path=&mode=&base=&head=` | Changed files and totals |
| GET | `/api/patch?path=&mode=&base=&head=&file=` | The diff of one file |
| POST | `/api/review` | Run a review (all files or selected ones) |
| GET | `/api/runs?path=`, `/api/runs/<id>` | Earlier review results |
| GET | `/api/work?path=` | The work chain |
| POST | `/api/work/from-run` | Record review findings as work items |
| POST | `/api/work/<item>/assign`, `done`, `recheck`, `close` | Assign, report fixed, recheck, close |

### Files

| File | What it does |
|---|---|
| `server.mjs` | Local service: git, review, work chain, API, serves the page |
| `web/src/App.tsx` | Main page: state, top bar, puts the panels together |
| `web/src/Workspace.tsx` | Drag-and-drop panel layout |
| `web/src/FileTree.tsx` | Changed files |
| `web/src/DiffPane.tsx` | Side-by-side diff, findings on lines, jump to a line |
| `web/src/ReviewPane.tsx` | Review results, assign buttons, copy to an agent |
| `web/src/WorkPane.tsx` | Work chain |
| `web/src/api.ts` | The page's calls to the local service, and data types |
| `web/src/styles.css` | Styles |

---

## 3. Getting started

You need Node 22 or later and git. To review with Claude Code, the Claude Code CLI must be installed and signed in.

```bash
npm install
npm run build
npm start
```

Then open http://127.0.0.1:8795 in a browser, enter the full path of a repository folder, and click "打开" (Open).

### Settings (environment variables at startup)

| Variable | Meaning | Default |
|---|---|---|
| `MIRROR_ENGINE` | `claude` or `openai` | `claude` if the `claude` command is found |
| `MIRROR_CLAUDE_BIN` | Location of the `claude` command | Found automatically (PATH, `~/.local/bin`) |
| `MIRROR_CLAUDE_MODEL` | Model for Claude Code, e.g. `sonnet` | Empty: the account's default |
| `MIRROR_MODEL_URL` | OpenAI-compatible service address (up to `/v1`) | `http://127.0.0.1:11434/v1` |
| `MIRROR_MODEL` | Model name in that service | `nemotron-3.5-bolt:e4b` |
| `MIRROR_MODEL_KEY` | Only for services that need a key | Empty |
| `MIRROR_REVIEW_BUDGET` | Most characters of changes sent per review | 200000 for Claude, 60000 otherwise |
| `MIRROR_REPO` | Repository opened by default | Empty |
| `PORT` | Port | `8795` |

---

## 4. Security

- The service listens only on `127.0.0.1` and rejects requests whose Host is not this machine, so other computers cannot connect.
- Viewing, reviewing and rechecking only read the repository. Claude edits files in the repository only after you click "Claude fixes it" on a problem. Even then it can only read and edit files, never run commands or commit; the fix is rechecked automatically, and every step goes into the work chain.
- git is called without a shell, with file names after `--`. Untracked files are checked to make sure they really belong to the repository.
- When Claude Code does the review, the changes are sent to Anthropic's servers. To keep code on your machine, use a local model instead (`MIRROR_ENGINE=openai`).

---

## 5. Development status (2026-11-20, first version)

| Part | Status |
|---|---|
| Side-by-side changes (two branches, uncommitted) | Done; tested on a Mac (a 6,240-file comparison; 7 and 16 uncommitted files) |
| Review with Claude Code | Done; tested: one file in 3 to 18 seconds, 16 files in about 2 minutes |
| Findings on their lines, click to jump | Done; tested |
| Work chain (assign, automatic fix, recheck, close) | Done; tested in a throwaway repository: "Claude fixes → recheck passed" and "reported fixed but not changed → recheck failed" |
| Drag-and-drop panels, resizing, remembered layout | Done; tested with simulated mouse drags in a built-in browser; not yet tested by hand |
| Review with a local model (OpenAI-compatible, e.g. Ollama) | Done; tested on a Mac with Ollama and gemma4:12b: a one-file review in 14 seconds (it found 1 problem where Claude Code found 5 in the same change), and a recheck. Answers are streamed, so a model that thinks for more than five minutes still gets through (tested with a stand-in service that answered after 330 seconds) |
| Keeping "Claude fixes it" when reviews use a local model | Not done: review and automatic fixes currently share one switch, so with a local model the button is hidden |
| Running on Windows | Not tested |
| VS Code extension; plugging into other platforms | Not done |
| English user interface | Not done; the interface is in Chinese |

---

## 6. License

This project is released under the MIT License; see `LICENSE`.

Open-source components it uses (downloaded by npm at install time, not included in this repository):

| Component | Used for | License |
|---|---|---|
| React, React DOM | The web interface | MIT |
| @pierre/diffs | Side-by-side diff rendering | Apache-2.0 |
| dockview-react, dockview-core | Drag-and-drop panel layout | MIT |
| Vite, @vitejs/plugin-react | Building the page | MIT |
| TypeScript | Type checking | Apache-2.0 |

Official documentation consulted: diffs.com (@pierre/diffs), dockview.dev, Claude Code's "Run Claude Code programmatically" and CLI reference, Ollama's OpenAI compatibility guide, and the GitLens documentation.
