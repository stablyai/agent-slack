# Contributing to agent-slack

Thanks for contributing.

## Development

Install deps and run the CLI in dev mode:

```bash
bun install
bun run dev -- --help
```

Build and test:

```bash
bun run build
bun run test
```

Lint and format:

```bash
bun run lint
bun run format:check
```

Run the packaged entrypoints locally:

```bash
node ./bin/agent-slack.cjs --help
bun ./bin/agent-slack.bun.js --help
```

## Publishing (maintainers)

Publishing is tag-driven. Push a `vX.Y.Z` tag and the GitHub Actions `Release` workflow will:

- Build native binaries + checksums and upload them to the GitHub Release (used by `install.sh` and npm postinstall).
- Publish the npm package `agent-slack` using Bun.

Prerequisite: set the repo secret `NPM_TOKEN` to an npm automation token with publish rights.

### Release steps

1. Update `package.json` (and `bun.lock` if needed).
2. Commit, tag, and push:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

3. Wait for the `Release` workflow to finish, then verify the GitHub Release assets and npm package.
