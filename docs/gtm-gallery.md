# The Community Template Gallery

How `template.tpl` reaches Google Tag Manager's Community Template Gallery, and how each new version
of it is released there. The gallery reads this repository from GitHub: its root holds what it needs.

## The package

| File                                    | What                                                                  |
| --------------------------------------- | --------------------------------------------------------------------- |
| `template.tpl`                          | the template, as GTM's template editor exports it, with the gallery's terms of service first |
| `metadata.yaml`                         | the gallery's metadata: homepage, documentation and the versions      |
| `LICENSE`                               | Apache-2.0, which the gallery requires                                |
| `README.md`                             | the repository's readme                                               |
| [`docs/google-tag-manager.md`](google-tag-manager.md) | the documentation `metadata.yaml` links: install, consent, fields, permissions |

`metadata.yaml` lists the versions newest first, each a commit on `main` whose `template.tpl` is that
version, with its change notes:

```yaml
homepage: "https://serversider.com"
documentation: "https://github.com/Amanda-AI-AB/amandatracker-tag/blob/main/docs/google-tag-manager.md"
versions:
  - sha: <full sha of a commit on main>
    changeNotes: What changed for the template's users.
```

`pnpm gtm:check` checks it: the format, that each version is on `origin/main` (or `--ref <ref>`),
newest first, with a `template.tpl`, and that the newest version's `template.tpl` is the checkout's.
`test/gtm-gallery.test.ts` checks the format, the licence, the template's header and the
documentation link on every pull request; the history needs git, so only `pnpm gtm:check` checks it.

## Submitting (once)

The first submission is a person's (AAI-159), from a clone of `main` once the template's first
version is on it:

1. `git fetch origin && pnpm install && pnpm gtm:check` passes.
2. Import `template.tpl` into a test container (*Templates*, *New*, the menu's *Import*), run its
   tests in the template editor's *Tests* tab, and check a tag of each event type in Preview.
3. Submit the repository's URL, `https://github.com/Amanda-AI-AB/amandatracker-tag`, with Google's
   gallery submission form, linked from the *Submit a template* section of
   [Community Template Gallery](https://developers.google.com/tag-manager/templates/gallery).
4. Answer the gallery's review on the AAI-159 ticket. Review takes weeks; a change it asks for is
   released as a new version (below).

The gallery's review reads the permissions first. The template's are minimal on purpose, and
[the documentation](google-tag-manager.md#permissions) states each with its reason: keep the two in
step, and add none without a ticket that decides it.

## Releasing a new version

A template version is released with the tag's release tag, `v<version>`, so a gallery version is
always a released state of this repository:

1. Change `template.tpl` (and its `___TESTS___`, and `test/gtm-template.test.ts`) in a pull request,
   and update [the documentation](google-tag-manager.md) in the same one. It merges to `main` with a
   merge commit, as every pull request here does, so its commits keep their shas.
2. Cut the release as usual: the tag `v<version>` goes on a commit on `main`.
3. Then, in a pull request of its own, list the tagged commit first in `metadata.yaml`'s `versions`:

   ```sh
   git rev-parse "v<version>^{commit}"   # the sha to list
   pnpm gtm:check
   ```

   with change notes written for the template's users. Leave older versions as they are: the
   gallery keeps offering them, and a user updates when they choose.
4. Once it is on `main`, the gallery picks the new version up by itself; no new submission is
   needed.

Until step 3 is on `main`, `pnpm gtm:check` reports that `template.tpl` has changed since the
newest version; that is the reminder to finish the release. The first version,
`3d510810ebd89929c95a8b9d602dffd1f285f1d8`, came before this process: it is the commit that added
the template (AAI-154), not a release tag.
