# Backing up ReelQueue safely

State when written (2026-10-18): the repository has **no git remote**. Nothing has been pushed anywhere. Until you do
one of the options below, the commits exist only inside the cloud workspace that produced them.

## Option A: push to a PRIVATE remote (recommended)
1. On GitHub/GitLab create an **empty private** repository (no README, no .gitignore, no license).
2. Check nothing secret is tracked or in history (from the repo root):
   ```bash
   git ls-files | grep -E '(^|/)\.env($|\.)' | grep -v '\.env\.example$'      # must print nothing
   git log --all -p | grep -nEi 'BEGIN [A-Z ]*PRIVATE KEY|(secret|token|password|api[_-]?key)[a-z_]*["'\'' ]*[:=]["'\'' ]*[A-Za-z0-9+/_-]{20,}' | head
   # review every hit by hand: test fixtures such as 'j'.repeat(40) and placeholders are expected; real values are not
   # optional, stronger: gitleaks detect --source . --log-opts="--all"
   ```
   `.gitignore` already excludes `.env` and `.env.*` (except `.env.example`, which holds only placeholders).
3. Add the remote **without a token in the URL** (URLs are stored in `.git/config` and shown in logs):
   ```bash
   git remote add origin git@github.com:<you>/reelqueue.git      # SSH key, or an https URL + a credential helper
   git remote -v
   ```
   For https use `gh auth login` or your OS credential manager; never paste a personal access token into a command line.
4. Push every branch and tag, then verify:
   ```bash
   git push -u origin --all && git push origin --tags
   git ls-remote origin            # the remote `main` hash must equal: git rev-parse main
   ```
5. If step 2 ever finds a real secret in history: do NOT push. Rotate the secret first, then rewrite history (git filter-repo) before pushing.

## Option B: complete archive (works offline)
```bash
git bundle create ../reelqueue.bundle --all
git bundle verify ../reelqueue.bundle                 # must say "okay"
git clone ../reelqueue.bundle restored-check && git -C restored-check log --oneline | head -3
sha256sum ../reelqueue.bundle > ../reelqueue.bundle.sha256
```
The bundle holds all commits and branches (no working-tree extras). Restore with `git clone reelqueue.bundle reelqueue`.
A bundle contains full history, so keep it as private as the repository itself.

## What is NOT in git (and must be backed up separately if you ever create it)
`.env`, Meta app secret, token-encryption keys (losing `TOKEN_ENCRYPTION_KEYS` makes every stored Instagram token unreadable: users must reconnect), database dumps, uploaded videos (object storage).
