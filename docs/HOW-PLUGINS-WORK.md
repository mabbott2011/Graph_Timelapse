# How Obsidian plugins are made

A plain walkthrough of what an Obsidian plugin is, using Graph Timelapse as the example.

## What a plugin actually is

Obsidian is an Electron app: a web page (HTML, CSS, JavaScript) running in a desktop shell. A plugin is **one JavaScript file** that Obsidian loads into that page. It gets a handle to the app (`this.app`) and can add commands, settings, views and ribbon icons, and react to events.

An installed plugin is just a folder in the vault:

```
<vault>/.obsidian/plugins/graph-timelapse/
├── main.js        ← the compiled code (required)
├── manifest.json  ← id, name, version, minimum Obsidian version (required)
├── styles.css     ← optional CSS
└── data.json      ← the plugin's saved settings (written by the plugin)
```

The folder name must match the `id` in `manifest.json`. That's the whole install. The community browser just downloads those files into that folder for you.

## The source repo vs. the installed plugin

You don't write `main.js` by hand. You write TypeScript in `src/`, and a bundler (esbuild) compiles it, along with any libraries, into one `main.js`.

```
Graph_Timelapse/            (source repo, in Projects)
├── src/
│   ├── main.ts             ← Plugin class: onload(), commands, scheduling
│   ├── capture.ts          ← opens the graph and turns it into a PNG
│   ├── settings.ts         ← settings tab and defaults
│   └── stats.ts            ← note/link/orphan counts
├── manifest.json           ← copied into each release
├── versions.json           ← plugin version → minimum Obsidian version
├── styles.css
├── package.json            ← npm scripts and dev dependencies
├── esbuild.config.mjs      ← bundler config
├── version-bump.mjs        ← keeps manifest/versions in sync with npm version
├── tsconfig.json
└── .github/workflows/release.yml  ← builds and drafts a GitHub release on tag
```

`main.js` is in `.gitignore`. It's a build output, so it ships in GitHub **releases**, not in the repo.

## The plugin lifecycle

```ts
export default class GraphTimelapsePlugin extends Plugin {
  async onload()  { /* runs when the plugin is enabled or Obsidian starts */ }
  onunload()      { /* runs when it's disabled or Obsidian closes */ }
}
```

- **`onload`**: load settings (`this.loadData()` reads `data.json`), register the settings tab, commands and timers.
- **Register everything.** `this.addCommand`, `this.registerInterval`, `this.registerEvent` and `this.register(fn)` let Obsidian undo it all automatically on unload. A plugin that leaves timers running after it's disabled is a bug, and the automated review looks for it.
- **`onLayoutReady`**: wait for the workspace to finish loading before touching views. Graph Timelapse waits another 20 seconds so it doesn't fight with startup (or with the Git plugin pulling).

## Public API vs. internals

The `obsidian` npm package holds the **public API**: typed, documented, and stable across versions (`Plugin`, `Notice`, `Setting`, `TFile`, `app.vault`, `app.workspace`, `app.metadataCache`…).

The graph view is **not** in it. It's drawn with PIXI.js (WebGL) inside `leaf.view.renderer`. Graph Timelapse reaches in as `any` and guards every step, with fallbacks:

1. **PIXI extract**: render the whole graph to a texture at the resolution we want. Best quality.
2. **Electron `capturePage`**: screenshot the pane. Desktop only.
3. **Canvas copy**: last resort. Can come out blank with WebGL.

Rule of thumb: use the public API wherever it covers what you need, and when you have to use internals, treat them as something that *will* change.

## Day-to-day development loop

1. `npm install` once.
2. `npm run dev` watches `src/` and rebuilds `main.js` on every save.
3. Get the build into a vault's plugin folder. Either:
   - copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/graph-timelapse/`, or
   - make a symlink from that folder to the repo so every rebuild shows up automatically.
4. Reload: toggle the plugin off and on in **Settings → Community plugins**, or run **Reload app without saving**. The community **Hot Reload** plugin does this automatically when `main.js` changes.
5. **Ctrl+Shift+I** opens DevTools. `console.log`/`console.warn` output and errors appear there.

Use a test vault for risky work, not the vault you care about.

## Settings and data

`this.loadData()` / `this.saveData()` read and write `data.json` in the plugin folder. Graph Timelapse stores its settings plus `lastSnapshotDate` there. In the Workbook vault, `.obsidian/plugins/*/data.json` is git-ignored, because other plugins keep tokens there.

## Rules the automated review checks (the important ones)

- `id` is unique and doesn't contain "obsidian". The description doesn't either.
- No default hotkeys. Command names don't repeat the plugin name.
- Settings headings use `new Setting(el).setName("…").setHeading()`, without the word "settings".
- Use `this.app`, never the global `app`.
- Don't build HTML strings with `innerHTML`. Use `createEl` or the DOM API.
- Clean up everything on unload.
- Keep `console.log` noise out of release builds.
- Must be open source. Closed-source plugins aren't accepted right now.

Obsidian publishes an ESLint plugin that runs the same checks locally. Run it before releasing.
