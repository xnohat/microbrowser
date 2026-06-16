# microbrowser

A minimal Electron browser tuned for low-memory Linux devices
(Raspberry Pi Zero 2 W, Pi 3, armv7l boxes with ~512 MB RAM).

Single window, one content view, persistent login state. Built so that
logging into Google and claude.ai actually works (most embedded browsers
get rejected as "insecure").

## Features (MVP)

- URL bar with smart navigation: full URL, bare domain, or search query
- Back / forward / reload / home
- Find in page (`Ctrl+F`)
- Zoom in / out / reset (`Ctrl++` / `Ctrl+-` / `Ctrl+0`), persisted
- Bookmarks (`Ctrl+D` to add, star button to open list)
- Downloads → `~/Downloads`, with toast notification
- Permission policy denies camera / mic / geolocation / notifications by
  default (saves RAM and battery)
- DevTools (`F12`) on the content view
- Persistent session: cookies + localStorage survive restart
- Real Chromium UA — Google OAuth and claude.ai accept the browser
- **Periodic memory reaper**: every 45 s and on blur/minimize/hide,
  Chromium HTTP cache, code cache, hostname cache and V8 heap are all
  flushed; logins are kept. Stops the slow RSS growth that ends in OOM.
- Aggressive Chromium flags for low-RAM use: GPU disabled,
  `process-per-site`, single raster thread, capped disk/media cache,
  smaller V8 heap.

## Keyboard shortcuts

| Shortcut             | Action                |
|----------------------|-----------------------|
| `Ctrl+L`             | Focus URL bar         |
| `Ctrl+R` / `F5`      | Reload                |
| `Ctrl+F`             | Find in page          |
| `Ctrl+D`             | Bookmark this page    |
| `Ctrl++` / `Ctrl+-`  | Zoom in / out         |
| `Ctrl+0`             | Reset zoom            |
| `Alt+←` / `Alt+→`    | Back / forward        |
| `F12`                | DevTools              |
| `Ctrl+Q`             | Quit                  |
| `Esc`                | Close find / menu     |

## Running from source

```sh
# clone, then
NODE_ENV=development npm install
npm start
```

> **Note for environments with `NODE_ENV=production`** in the shell
> (common on Pi setups): npm will silently skip `devDependencies` and
> Electron will not be installed. Either `unset NODE_ENV` or prefix
> with `NODE_ENV=development npm install` as shown.

## Building a redistributable bundle

The build uses [`@electron/packager`](https://github.com/electron/packager).
It packages the app + its own copy of Electron into a portable directory.

```sh
# For Raspberry Pi 3 / Zero 2 W / armv7l devices
npm run bundle:armv7l
# → dist/microbrowser-armv7l.tar.gz

# For x86_64 Linux
npm run bundle:x64
# → dist/microbrowser-x64.tar.gz
```

The first build downloads the Electron prebuilt for the target arch
(~80 MB) and caches it under `~/.cache/electron/`. Subsequent builds are
fast.

**Building on the Pi itself works but is slow** (~5–10 minutes, heavy
on SD-card IO). For redistribution, build on a faster Linux machine —
cross-arch builds work natively because Electron ships prebuilts.

## Installing the bundle (end-user instructions)

After unpacking the tarball on a target device:

```sh
tar xzf microbrowser-armv7l.tar.gz
cd microbrowser-linux-armv7l
# System-wide install (puts microbrowser in /opt and a launcher in /usr/local/bin):
sudo ./resources/install.sh
# Or per-user install (no sudo, installs to ~/.local):
./resources/install.sh --user
```

Then launch from the menu (Internet → microbrowser) or from a terminal:

```sh
microbrowser
```

You can also run it without installing — just execute the bundled
binary directly: `./microbrowser`.

## Configuration

User data is stored in `~/.config/microbrowser/`:
- `Cookies`, `Local Storage/`, `Session Storage/` — your logins
- `settings.json` — home URL, zoom level, bookmarks
- `Cache/` — capped at 32 MiB (HTTP) + 8 MiB (media)

To change the home page, either edit `~/.config/microbrowser/settings.json`
or load the page you want and bookmark it as your starting point.

## System tweaks (optional, not bundled)

If even with the in-app memory reaper your device still swaps heavily,
enable **zram** at the OS level (compressed RAM swap). This is a system
configuration choice, not part of microbrowser, but it pairs well with it:

```sh
sudo modprobe zram
sudo zramctl --find --size 200M --algorithm lz4 | xargs -I{} sh -c \
  'sudo mkswap {} >/dev/null && sudo swapon --priority 100 {}'
```

For persistence across reboots, create a systemd unit (see the Debian
wiki entry on `zram`).

## Pre-built installers (GitHub Releases)

CI builds installers for every tag pushed (`v*`). See the
[Releases page](https://github.com/xnohat/microbrowser/releases):

| Platform | Architectures      | Formats                  |
|----------|--------------------|--------------------------|
| Linux    | x64, arm64, armv7l | `.deb`, `.rpm`, AppImage |
| Windows  | x64, arm64         | NSIS `.exe`, portable    |
| macOS    | x64, arm64         | `.dmg`                   |

Builds are **unsigned**. On macOS, right-click → Open the first time
(or `xattr -dr com.apple.quarantine /Applications/microbrowser.app`).
On Windows, click "More info → Run anyway" on the SmartScreen prompt.

To cut a release, push a tag:

```sh
git tag v0.1.0 && git push --tags
```

The `.github/workflows/release.yml` workflow builds all targets in
parallel and attaches the artifacts to the GitHub Release.

## License

MIT
