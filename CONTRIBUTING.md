# Contributing to DockPulse

## Prerequisites

- [NPM] (frontend)
- **Windows users(who dont have WSL or VM):** use [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install) and run all commands inside WSL. Docker Desktop integrates with WSL automatically. See the [VS Code WSL guide](https://code.visualstudio.com/docs/remote/wsl) for editor setup.

## Getting started

```bash
git clone git@github.com:Group-2-II1302/ShelfAware.git
cd ShelfAware
```

## Development workflow

Follow the [project workflow](https://github.com/Group-2-II1302/Documentation/blob/main/worklfow.md) and [Git Guide](https://github.com/Group-2-II1302/Documentation) for branching, commits, and code review.

1. **Pick an issue** from the [project board]() and assign yourself
2. **Branch off main:** `git checkout -b feat/task_name`
3. **Develop** -- keep changes focused on the issue
4. **Open a PR** with a Conventional Commits title: `<type> <issue-number>-short-description`
5. **Get one approval**, then squash-merge

### Commands

| Command            | What it does                               |
| ------------------ | ------------------------------------------ |
| `bun run dev`      | Start dev server (proxies to real backend) |
| `bun run dev:mock` | Start dev server with mock API             |
| `bun run build`    | Production build to `dist/`                |
| `bun run check`    | Type-check with tsc                        |
| `bun run lint`     | Lint with Biome                            |
| `bun run lint:fix` | Lint + auto-fix                            |
| `bun run format`   | Format with Biome                          |
