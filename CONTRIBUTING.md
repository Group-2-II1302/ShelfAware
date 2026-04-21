# Contributing to ShelfAware

## Prerequisites

- [npm]

```bash
apt install npm
```

- **Windows users(who dont have WSL or a ubuntu VM):** use [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install) and run all commands inside WSL. Docker Desktop integrates with WSL automatically. See the [VS Code WSL guide](https://code.visualstudio.com/docs/remote/wsl) for editor setup.

## Getting started

Clone the repo, install dependencies, and open it in your editor:

```bash
git clone git@github.com:Group-2-II1302/ShelfAware.git
cd ShelfAware
npm install
code .
```

### Environment variables

The app reads its Supabase credentials from a local `.env` file, which is git-ignored. Copy the template and fill in the values before the first `npm run dev`:

```bash
cp .env.example .env
```

Then open `.env` and set:

| Variable                   | Where to find it                                             |
| -------------------------- | ------------------------------------------------------------ |
| `PUBLIC_SUPABASE_URL`      | Supabase dashboard -> Project Settings -> API -> Project URL |
| `PUBLIC_SUPABASE_ANON_KEY` | Supabase dashboard -> Project Settings -> API -> `anon` key  |

Ask a teammate if you need the project's current values. The anon key is safe to share inside the team - it's a public key protected by RLS. Do not share or publish keys.

After editing `.env`, regenerate the SvelteKit ambient types so `$env/static/public` picks up the new variables:

```bash
npm run prepare
```

If your editor still shows `Module '$env/static/public' has no exported member ...`, restart the TypeScript server (VS Code / Cursor: `Ctrl+Shift+P` -> "TypeScript: Restart TS Server").

## Development workflow

Follow the [project workflow](https://github.com/Group-2-II1302/Documentation/blob/main/worklfow.md) and [Git Guide](https://github.com/Group-2-II1302/Documentation) for branching, commits, and code review.

1. **Pick an issue** from the [project board]() and assign yourself
2. **Branch off main:** `git checkout -b feat/task_name`
3. **Develop** -- keep changes focused on the issue
4. **Open a PR** with a Conventional Commits title: `<type> <issue-number>-short-description`
5. **Get one approval**, then [squash-merge](https://docs.gitlab.com/user/project/merge_requests/squash_and_merge/)

### Commands

| Command           | What it does                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `npm run dev`     | Start dev server (proxies to real backend)                                                             |
| `npm run preview` | preview the production build                                                                           |
| `npm run build`   | Production build                                                                                       |
| `npm run check`   | Type-check                                                                                             |
| `npm run format`  | Format with Prettier                                                                                   |
| `npm run prepare` | Regenerate SvelteKit ambient types (runs automatically on `npm install`; re-run after editing `.env`). |
