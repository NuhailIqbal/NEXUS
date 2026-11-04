"""
Release version of the NEXUS backend (semantic versioning: MAJOR.MINOR.PATCH).

Kept in step with the frontend's `package.json` version by `scripts/bump-version.mjs`, so do not edit
it by hand; run `npm run version:bump -- <patch|minor|major|x.y.z>` instead. It lives in its own module
(not read from `package.json`) because the backend Docker image is built from `./backend` alone and
cannot see files outside it. Reported by `GET /health` and used as the FastAPI app version.
"""
__version__ = "1.0.0"
