# WindowsDock: setup and workflow

WindowsDock is Muse's personal fork of [Bloom](https://github.com/SehajveerSingh2005/bloom) by Sehajveer Singh, licensed GPL-3.0.

## What changed from Bloom

| Change | Why |
| --- | --- |
| Updates come from this fork's GitHub releases, signed with its own key (`plugins.updater` in `tauri.conf.json`). `createUpdaterArtifacts` stays `false` for local builds; the release workflow turns it on | The original updater would install upstream Bloom over your changes, and signing needs a private key only you hold |
| Name **WindowsDock**, ID `com.munyasia.windowsdock`, publisher, About tab | Windows treats it as your app; original author still credited (GPL requirement) |
| Upstream announcements off (`src/hooks/useAnnouncement.ts`) | They were pulled from the author's website |
| AI bot workflows moved to `.github/workflows-disabled/`; FUNDING.yml removed | They needed the author's API keys and secrets |
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

You only need this for a first install or to try a build before releasing it. Installed copies update themselves from releases (section 7).

## 5. Your everyday loop

```powershell
git checkout -b my-change     # optional: a branch per idea
# ...edit files, test with: bun run tauri dev
git add -A
git commit -m "fix: describe what you changed"
git push
```

When the change is on `main` and you want every install to get it, ship a release (section 7).

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

## 7. Shipping an update

1. On `main`, with everything committed and pushed, run `bun run release 3.10.5` (use the next version number). It bumps the four version files, commits, tags `v3.10.5` and pushes.
2. GitHub Actions builds and signs it. Watch the **Release** run in the repo's Actions tab; it takes 15 to 20 minutes.
3. Every installed copy now finds it under **Settings > About > Check for Updates**. Click it, then click **Update Available** to install. With **Auto Update** on, it installs by itself on startup once the release is a day old.
4. `bun scripts/verify-updater.mjs v3.10.5` checks the release can be downloaded the way the app does it.

If a release turns out broken, edit it on GitHub and tick **Set as a pre-release**. Update checks then fall back to the previous release.

### The signing key

Installed copies only accept updates signed with the key whose public half is in `plugins.updater.pubkey`.

- The private key lives at `$HOME\.tauri\windowsdock.key`. Keep its password in your password manager and back up both.
- GitHub holds copies as the repo secrets `TAURI_SIGNING_PRIVATE_KEY` (the file's contents) and `TAURI_SIGNING_PASSWORD`.
- If you lose the key, a new one means every user has to reinstall by hand once more, because their copies only trust the old key.

## License

GPL-3.0. Keep the LICENSE file and the credit to Sehajveer Singh. If you ever share WindowsDock with others, share its source code too.
