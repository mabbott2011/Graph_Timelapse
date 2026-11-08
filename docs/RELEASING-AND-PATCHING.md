# Releasing and patching

How a plugin gets from this repo into people's vaults, and how fixes get out after that.

## How Obsidian finds updates

Obsidian never reads your source code. For each installed plugin it:

1. reads `manifest.json` at the **head of the default branch** on GitHub, to learn the latest `version`,
2. downloads `main.js`, `manifest.json` and `styles.css` from the **GitHub release whose tag equals that version**.

So a release is three things that must agree:

| | Example |
|---|---|
| `manifest.json` → `version` | `0.1.1` |
| Git tag | `0.1.1` (no `v` prefix) |
| Release assets | `main.js`, `manifest.json`, `styles.css` |

`versions.json` maps each plugin version to the minimum Obsidian version it needs, so someone on an older Obsidian is offered the newest version that still works for them.

Version numbers are `MAJOR.MINOR.PATCH`:
- **patch** (`0.1.0 → 0.1.1`): bug fixes only
- **minor** (`0.1.1 → 0.2.0`): new features, nothing breaks
- **major** (`0.x → 1.0.0`): breaking changes, or "this is stable now"

## Shipping a release (including a patch)

```sh
# 1. Fix, then build and test locally
npm run build

# 2. Bump the version. This runs version-bump.mjs, which updates
#    manifest.json and versions.json, commits, and creates the tag.
npm version patch          # or: minor / major

# 3. Push the commit and the tag
git push && git push --tags
```

Pushing the tag triggers `.github/workflows/release.yml`, which builds the plugin and creates a **draft** release with the three files attached. Open it on GitHub, write the notes (what changed, for whom), and click **Publish**.

When it's published, Obsidian's automated review scans the new version (policy, code quality, known vulnerabilities, malware). If it passes, users see the update. If it fails, the details are in the developer dashboard, and a failing new version is pulled from search within 24 hours.

**Important:** if the default branch's `manifest.json` says `0.1.1` but there's no published `0.1.1` release, updates break for everyone. Publish the release right after pushing the tag.

## First-time submission

1. Make the repo public with `README.md`, `LICENSE` and `manifest.json` at the root.
2. Publish the first release (`0.1.0`) as above.
3. Go to **community.obsidian.md**, sign in with your Obsidian account, connect GitHub, and choose **Add a plugin or theme**. Pick the repo.
4. The automated review usually runs within minutes. Fix anything it flags, publish a new patch release, and it re-checks. Once it passes, the plugin appears in Obsidian's plugin browser within about 24 hours.
5. In the dashboard, set the payment label to **Optional payments**. That's the honest label for a free plugin with a coffee link. Your author profile can list sponsorship links too.

The `fundingUrl` in `manifest.json` is what puts a donate link on the plugin's page in Obsidian. The coffee button at the bottom of the settings tab is the plugin's own.

## Beta testing before a public release

- **BRAT** (the "Beta Reviewers Auto-update Tester" community plugin) installs a plugin straight from a GitHub repo and keeps it updated from its releases, including pre-releases. It's how people test a plugin that isn't in the directory yet, or a beta of one that is.
- Mark a GitHub release as **pre-release** to ship a beta to BRAT users only. Normal users won't get it.

## Patching someone else's plugin

Sometimes a plugin you use has a bug and you need it fixed now.

**Don't edit the installed `main.js` in `.obsidian/plugins/<id>/`.** It's minified, it's hard to read, and the next update silently overwrites your change.

Instead:

1. **Check the issues first.** It may already be fixed in a newer or beta release.
2. **Fork** the plugin's repo on GitHub and make the fix in its `src/`.
3. **Build** it (`npm install && npm run build`) and test it in a test vault.
4. **Use your fork**: either copy your built `main.js` over the installed one and turn off updates for that plugin, or point BRAT at your fork so you get your own releases.
5. **Send the fix upstream** as a pull request. Once it's merged and released, switch back to the official plugin and delete your fork's copy.

## Patch checklist

- [ ] Reproduced the bug, ideally in a test vault
- [ ] Fix plus manual test (`npm run build`, reload the plugin)
- [ ] No new `console.log` noise
- [ ] `npm version patch`
- [ ] `git push && git push --tags`
- [ ] Release notes written, draft published
- [ ] Automated review passed (dashboard)
- [ ] Updated your own vault's copy
