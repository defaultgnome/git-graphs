# ggrph

A local git contribution scoreboard. Point it at a repo and it opens an interactive chart in your browser: who committed what, when, and how much.

Everything runs on your machine. No uploads, no accounts.

## Features

- Stacked bar, line, or smooth chart of activity over time, with trend lines and a log scale
- Metrics: commits, lines added/deleted, net, churn, and tickets worked on (unique `NX-<n>` keys)
- Zoom slider plus manual date range inputs
- Committer table: sortable, with rename, hide, and a searchable picker to merge aliases
- File-type filter, including presets such as "PHP app"
- Commit explorer side panel
- Option to ignore the first commit, for repos that start with a huge import
- Saved layouts. View state persists per repo.

## Install

Requires [Bun](https://bun.sh).

```sh
bun install
bun link        # makes `ggrph` available globally
```

## Usage

```sh
ggrph                      # current directory
ggrph ~/code/some-repo
ggrph . --exclude "docs/**" --exclude "*.snap"
```

ggrph reads the history, starts a server on `127.0.0.1` with a random port, and opens your browser.

Some files are excluded by default: lockfiles, `*.min.js`, `dist/`, `vendor/`, and `node_modules/`. Patterns without a `/` match at any depth.

## State

UI state (merges, view, layouts) and a cache of the raw git log live outside the repo, in
`$XDG_CONFIG_HOME/ggrph/` (default `~/.config/ggrph/`). Each repo root gets its own file.

## Development

```sh
bun src/cli.ts <path>
bun test
```
