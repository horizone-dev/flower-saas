# Git workflow

## Repository

- Root: `C:\Users\EXPERT\Desktop\Flower SaaS`. Origin:
  `https://github.com/horizone-dev/flower-saas.git`. Default branch: **`main`**.
- **Completely isolated from the Salon SaaS project** — never operate on that repo
  or its data.

## Branching — trunk-based

- Short-lived branches: **`phase-<n>/<task>-<slug>`** (e.g. `phase-0/0.2-config`).
- One branch per task (0.1 … 0.13, then per phase task). A self-review PR runs the
  CI gate; merge to `main` when **its verification is green**.
- **Never commit a red state to `main`.** `main` is always buildable.
- **No history rewrite. No force-push.** Recovery is **revert-forward** only.
  Force-push requires explicit written owner authorization.

## Commits — Conventional Commits (commitlint-enforced)

```
<type>(<scope>): <subject>

<body — what was verified, why>

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AFzqSMQyTq2ryPLcHbbeax
```

- Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `build`, `ci`, `perf`.
- Scope: the package / app / module (`db`, `api`, `config`, `money`, `phase-0`).
- **One commit per completed, verified task.** The body records the verification
  output (what ran, actual results).
- The two trailers are mandatory on every commit.

## PRs

- Title: the same Conventional Commit subject.
- Body: what changed, how it was verified (commands + results), which checklist
  items it satisfies, any deviation + its ADR.
- Footer: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- CI must be green. For a phase task, the relevant isolation/financial/concurrency
  suites must pass.

## Checkpoint tags (annotated)

| Tag                  | When                                                                    |
| -------------------- | ----------------------------------------------------------------------- |
| `spec-frozen-v0.4`   | after the docs + `CLAUDE.md` commit (Phase 0 steps 1–2)                 |
| `phase-0-infra`      | after Task 0.9 (docker infra verified)                                  |
| `phase-0-ci`         | after Task 0.10 (CI green)                                              |
| `phase-0-complete`   | after Task 0.13 (full checklist green); references `PHASE-0-RESULTS.md` |
| `phase-<n>-complete` | thereafter, one per phase — then **STOP for owner approval**            |

## Never committed

Secrets, `.env` (only `.env.example`), `node_modules`, build output (`dist`,
`.next`, `build`), `.turbo`, coverage, generated Prisma client. The RLS spike code
(`tooling/spikes/rls`) is committed once for the record, then may be removed in a
later commit.

## Remote reconciliation

Before the first push: verify repo root, current branch, `git status`,
`git remote -v`, and that **no Salon SaaS files are staged**. The remote is
currently **empty** → push `main` normally. If the remote ever contains commits we
did not make, **stop and report** — do not overwrite, reset or force-push.
