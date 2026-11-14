# Verifying a release

`a.js` runs inside your pages, so you can check that what we serve is exactly what this repository's
source builds to. Every release is built reproducibly: the same commit, built again anywhere, gives
the same bytes. Each one is published with its provenance.

## What is published

On the collection host (`https://eu.serversider.com` by default, or your `data-endpoint`):

| Object                               | What                                                    | Cached        |
| ------------------------------------ | ------------------------------------------------------- | ------------- |
| `a.<version>.js`                     | the core, immutable: its bytes never change             | 1 year        |
| `adapters/<version>/<name>.js`       | each consent-manager adapter built with that core       | 1 year        |
| `a.<version>.provenance.json`        | the release's provenance                                | 1 year        |
| `a.js`                               | the evergreen URL: a copy of the current stable build   | 5 minutes     |

The first line of `a.js` names the version it is, as `/*! amandatracker-tag <version> */`, and its
bytes are those of `a.<version>.js`.

A release tag `v<version>` publishes `<version>` (such as `0.3.0`). A build of each merge to `main`
is published to the dev environment only, as `<next patch>-dev.<commit time>.g<short sha>`.

## The provenance

`a.<version>.provenance.json` is an [in-toto](https://in-toto.io/) statement with a
[SLSA v1 provenance](https://slsa.dev/spec/v1.0/provenance) predicate:

- `subject`: each published file, by its object name and SHA-256;
- `predicate.buildDefinition.externalParameters`: the repository, the ref (`refs/tags/v<version>`,
  or `refs/heads/main` for a dev build), the version and the environment;
- `predicate.buildDefinition.resolvedDependencies`: the commit, the SHA-256 of `pnpm-lock.yaml`, and
  the toolchain (esbuild, which alone shapes the output; pnpm with its hash; Node).

It carries no build id or time, so it is itself reproducible. It is not signed: its proof is that you
can rebuild what it names and compare.

## Reproduce a release

You need git, Node.js 20 or later and pnpm 9.

```sh
VERSION=0.3.0
curl -fsSO "https://eu.serversider.com/a.$VERSION.provenance.json"
git clone https://github.com/Amanda-AI-AB/amandatracker-tag && cd amandatracker-tag
git checkout "v$VERSION"            # the commit the provenance names
pnpm install --frozen-lockfile
pnpm reproduce "../a.$VERSION.provenance.json"
```

`pnpm reproduce` refuses a checkout of another commit or another lockfile, rebuilds the release into a
directory of its own, and compares every file with the SHA-256 the provenance names. It prints
`<version>: all <n> published files reproduced byte for byte`, or each file that differs and exits 1.

Then check that the files served are those the provenance names:

```sh
curl -fsS "https://eu.serversider.com/a.$VERSION.js" | sha256sum
```

and compare the hash with the subject `a.<version>.js` in the provenance. For the evergreen `a.js`,
read its version from its first line, and compare its hash in the same way.

The release pipeline (`cloudbuild/release.yaml`) runs the same `pnpm reproduce` on every release, a
second build from scratch, and uploads nothing unless it matches.
