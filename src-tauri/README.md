# @strudel/tauri

Rust source files for building native desktop apps using Tauri

## Usage

Install [Rust](https://rustup.rs/) on your system.

From the project root:

- install Strudel dependencies

```js
pnpm i
```

- to run Strudel for development

```js
pnpm tauri dev
```

- to build the binary and installer/bundle

```js
pnpm tauri build
```

The binary and installer can be found in the 'src-tauri/target/release/bundle' directory

## NDI output

The desktop app can send two [NDI](https://ndi.video/) feeds: the code editor ("text") and the drawings such as pianorolls and scopes ("visuals"). Feeds, network settings and a debug view are in the REPL under settings > NDI.

- The NDI runtime is not bundled. It is loaded at runtime from the folder in `NDI_RUNTIME_DIR_V6` (or V5...) or the default install location, e.g. `/usr/local/lib/libndi.dylib` on macOS after installing NDI Tools.
- Network settings are written to `ndi/ndi-config.v1.json` in the app config directory and passed to the runtime with `NDI_CONFIG_DIR`. The runtime reads them once per process, so changes other than groups and source names need an app restart.
- Rust side: `src/ndi.rs`. Frontend capture: `website/src/repl/ndi.mjs`.
