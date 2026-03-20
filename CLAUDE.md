# Team Israel Tracker — Claude Code Config

## Allowed Commands (within this project folder only)
All commands below are permitted without confirmation, provided they operate
inside `/Users/simonrosenbaum/Documents/ai_coding_projects/team-israel-tracker/`.

### Navigation & inspection
- `cd` (only into subdirectories of this project)
- `ls`, `pwd`
- `cat`, `head`, `tail`

### File operations
- `cp`, `mv` (within the project folder)
- `mkdir` (within the project folder)
- `touch`

### Git
- `git status`, `git diff`, `git log`
- `git add` (specific files only, never `git add -A` or `git add .`)
- `git commit` (with a descriptive message)
- `git push`
- `git pull --rebase`

### Python / Node
- `python scripts/generate_weekly_report.py` (dry-run / local testing)
- `node` one-liners for quick debugging

## What Still Requires Confirmation
- Force pushes (`--force`)
- `git reset --hard`
- Deleting branches (`git branch -D`)
- Any operation on a branch other than `main`
- `rm` / `rmdir` (any deletion)
- Any command that navigates outside this project folder

## Project Notes
- All JS files use ES modules (`import`/`export`) — no CommonJS
- GitHub Pages serves from the `main` branch root
- `data/roster.json` is the source of truth for players
- `data/weekly_reports/` is written by GitHub Actions — don't edit manually
- Python script lives in `scripts/generate_weekly_report.py`
- Workflow file: `.github/workflows/weekly_report.yml`
