# WindowsDock: setup and workflow

WindowsDock is Muse's personal fork of [Bloom](https://github.com/SehajveerSingh2005/bloom) by Sehajveer Singh, licensed GPL-3.0.

## What changed from Bloom

| Change | Why |
| --- | --- |
| Auto-updater off (`UPDATES_ENABLED = false` in `src-tauri/src/updater.rs`), `createUpdaterArtifacts: false` | The original updater would install upstream Bloom over your changes, and building needed the author's private signing key |
| Name **WindowsDock**, ID `com.munyasia.windowsdock`, publisher, About tab | Windows treats it as your app; original author still credited (GPL requirement) |
| Upstream announcements off (`src/hooks/useAnnouncement.ts`) | They were pulled from the author's website |
| AI bot and release workflows moved to `.github/workflows-disabled/`; FUNDING.yml removed | They needed the author's API keys and secrets |
| Internal names kept: `bloom.exe`, window titles "Bloom"/"Bloom Dock" | The code finds its own windows by these names. Renaming them would make the dock show itself as an app |

## 1. One-time Windows setup

Install these in order. Use PowerShell for the commands.

1. **Git**: `winget install Git.Git`
2. **Visual Studio C++ Build Tools**: `winget install Microsoft.VisualStudio.2022.BuildTools`. Open the "Visual Studio Installer" afterwards and tick **Desktop development with C++**. Rust needs this to compile Windows code.
3. **Rust**: `winget install Rustlang.Rustup`, then open a new terminal and run `rustup default stable`
4. **Bun**: `powershell -c "irm bun.sh/install.ps1 | iex"`
5. WebView2 is already part of Windows 11.

Close and reopen the terminal, then check: `git --version`, `cargo --version`, `bun --version`

## 2. Install the project packages

The code is already in `M:\Web design\windowsdock`, linked to `github.com/Munyasia/windowsdock` (`origin`) and the original Bloom (`upstream`).

```powershell
cd "M:\Web design\windowsdock"
bun install
```

## 3. Run it while editing (dev mode)

```powershell
bun run tauri dev
```

The first run compiles about 400 Rust crates and takes 5–15 minutes. Later runs are fast. Saving a React file (`src/`) updates the app instantly; saving a Rust file (`src-tauri/src/`) rebuilds it. WindowsDock **hides the Windows taskbar while it runs**. Close it from its tray icon to get your taskbar back.

## 4. Install it for real

```powershell
bun run tauri build
```

The installer lands in `src-tauri\target\release\bundle\nsis\WindowsDock_<version>_x64-setup.exe`. Run it. Windows SmartScreen may warn because the app isn't code-signed. Click **More info → Run anyway**.

## 5. Your everyday loop

```powershell
git checkout -b my-change     # optional: a branch per idea
# ...edit files, test with: bun run tauri dev
git add -A
git commit -m "Describe what you changed"
git push
bun run tauri build           # rebuild and reinstall when happy
```

## 6. Pull in improvements from the original Bloom

```powershell
git fetch upstream
git merge upstream/main
```

Resolve any conflicts (usually in the files listed above), test, then push.

## Where things live

- `src/`: React UI. `Overlay.tsx` is the notch/island, `Dock.tsx` the dock, `settings/` the settings window
- `src-tauri/src/`: Rust code talking to Windows (audio, Bluetooth, WiFi, battery, taskbar)
- `src-tauri/tauri.conf.json`: app name, ID, windows, installer settings
- `public/`: logos and images (replace `bloom.png` / `bloom.svg` with your own logo)

## Turning updates back on later (optional)

1. `bun run tauri signer generate -w $HOME\.tauri\windowsdock.key`
2. Put the new **public** key in `plugins.updater.pubkey` in `tauri.conf.json`
3. Set `UPDATES_ENABLED = true` and `createUpdaterArtifacts: true`
4. Add `TAURI_SIGNING_PRIVATE_KEY` as a GitHub secret, and move `release.yml` back into `.github/workflows/`

## License

GPL-3.0. Keep the LICENSE file and the credit to Sehajveer Singh. If you ever share WindowsDock with others, share its source code too.
