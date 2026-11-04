# Versioning

NEXUS uses [Semantic Versioning](https://semver.org/) for releases: `MAJOR.MINOR.PATCH`.

| Bump  | When |
|-------|------|
| MAJOR | A breaking change (an API or data change that existing clients/accounts cannot absorb) |
| MINOR | A new feature, backwards compatible |
| PATCH | A bug fix or small tweak |

## Where the version lives

`package.json` is the source of truth. Everything else is kept in step by `scripts/bump-version.mjs`; do not edit them by hand:

- `package-lock.json`
- `backend/version.py` (a copy, because the backend image is built from `./backend` alone)
- `CHANGELOG.md` (the newest `## [x.y.z]` heading)

Where it shows up: `GET /health` returns `{"status": "ok", "version": "x.y.z"}`, the API docs (`/docs`) show it, and the website footer prints `vx.y.z`.

## Cutting a release

1. While working, add a line under `## [Unreleased]` in `CHANGELOG.md` (Added / Changed / Fixed).
2. Release:
   ```bash
   npm run version:bump -- minor      # or patch, major, or an explicit 1.4.0
   ```
   This updates all files above and turns `Unreleased` into `## [x.y.z] - <date>`.
3. Review, commit, and tag:
   ```bash
   git commit -am "Release x.y.z"
   git tag -a vx.y.z -m "NEXUS x.y.z"
   git push --follow-tags
   ```

`npm run version:check` exits 1 if any file disagrees with `package.json`; `npm test` also checks this.
