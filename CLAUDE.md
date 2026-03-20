# Team Israel Tracker — Claude Code Config

## Git Permissions
Claude may perform the following git operations without asking for confirmation:
- `git status`, `git diff`, `git log`
- `git add` (specific files only, never `git add -A` or `git add .`)
- `git commit` (with a descriptive message)
- `git push`
- `git pull --rebase`

## What Still Requires Confirmation
- Force pushes (`--force`)
- `git reset --hard`
- Deleting branches (`git branch -D`)
- Any operation on a branch other than `main`

## Project Notes
- All JS files use ES modules (`import`/`export`) — no CommonJS
- GitHub Pages serves from the `main` branch root
- `data/roster.json` is the source of truth for players
- `data/weekly_reports/` is written by GitHub Actions — don't edit manually
- Python script lives in `scripts/generate_weekly_report.py`
- Workflow file: `.github/workflows/weekly_report.yml`
