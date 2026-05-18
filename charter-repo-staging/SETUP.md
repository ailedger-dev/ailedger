# Charter repo setup instructions (Jake)

Vernier prepared this staging directory autonomously 2026-05-12 because the `jakejjoyner` GitHub account doesn't have access to the `ailedger` GitHub org (org exists at github.com/ailedger, but jakejjoyner isn't a member).

## Files staged

- `CHARTER.md` — copied verbatim from `~/workspace/dev/ailedger/CHARTER.md` (Charter v1.0)
- `README.md` — repository README per the publication handoff
- `LICENSE` — Creative Commons Attribution 4.0 International (CC BY 4.0)

## Setup steps (when you have org access)

1. **Get org access.** Either add `jakejjoyner` to the `ailedger` GitHub org, OR authenticate `gh` to an account that's already a member of the `ailedger` org. The simplest path: log into `github.com/ailedger` directly and add `jakejjoyner` as an owner/admin.

2. **Create the public repo at `ailedger/charter`:**

   ```bash
   gh repo create ailedger/charter --public --description "AILedger Charter — public commitment document" --disable-issues --disable-wiki
   ```

   (Note: the `--disable-issues` and `--disable-wiki` flags signal that this is a publication repo, not a collaboration repo. PRs are still enabled by default for amendment proposals — which is correct.)

3. **Stage the content and push:**

   ```bash
   cd ~/workspace/dev/ailedger/charter-repo-staging
   git init
   git remote add origin git@github.com:ailedger/charter.git
   git add CHARTER.md README.md LICENSE
   git commit -m "Publish AILedger Charter v1.0"
   git branch -M main
   git push -u origin main
   ```

4. **Tag v1.0:**

   ```bash
   git tag -a v1.0 -m "Charter v1.0 — initial public publication"
   git push origin v1.0
   ```

5. **Verify:**

   - Visit https://github.com/ailedger/charter
   - Confirm `CHARTER.md` renders correctly
   - Confirm the v1.0 tag is visible in the Releases sidebar
   - Confirm the repo is public + accessible without login

## Alternative if `ailedger` org access is blocked

If you can't get org access easily, the fallback canonical location is `jakejjoyner/ailedger-charter` (private user, public repo). All marketing and reference links would point there instead of `github.com/ailedger/charter`. The Charter text and discoverability are identical; only the URL prefix differs.

To set up the fallback:

```bash
gh repo create jakejjoyner/ailedger-charter --public --description "AILedger Charter — public commitment document" --disable-issues --disable-wiki
cd ~/workspace/dev/ailedger/charter-repo-staging
git init
git remote add origin git@github.com:jakejjoyner/ailedger-charter.git
git add CHARTER.md README.md LICENSE
git commit -m "Publish AILedger Charter v1.0"
git branch -M main
git push -u origin main
git tag -a v1.0 -m "Charter v1.0 — initial public publication"
git push origin v1.0
```

Then update the marketing site + jakejoyner.com references to point at `github.com/jakejjoyner/ailedger-charter` instead of `github.com/ailedger/charter`.

## After the repo is live

- Update `ailedger.dev/charter` to render this repo (Cloudflare Pages route or static page; see `~/workspace/dev/ailedger/landing/CHARTER-PAGE-STAGING.md` if Vernier created one).
- Update `jakejoyner.com` to include the single-line reference (needs clone of `jakejjoyner/homepage` repo + edit + push; not done autonomously because the homepage repo wasn't cloned locally at staging time).
- Update marketing-quote-bank.md QA-17 references and PITCH-ONE-PAGER.md "github.com/ailedger/charter" mention if the fallback URL was used.

## Vernier's record

This directory was staged by Vernier autonomously on 2026-05-12 during Jake's overnight move. The content is final; only execution is blocked. Jake's "do the stuff for putting the charter online" directive translates to running the steps above once org access is resolved.
