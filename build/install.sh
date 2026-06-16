#!/bin/sh
# Install microbrowser system-wide (or under $HOME with --user).
# Usage: ./install.sh           # /opt + /usr/local/bin + /usr/share/applications
#        ./install.sh --user    # ~/.local/share + ~/.local/bin
set -e

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
APP_DIR="$SCRIPT_DIR"

if [ "$1" = "--user" ]; then
  INSTALL_BASE="$HOME/.local"
  BIN_DIR="$INSTALL_BASE/bin"
  APPS_DIR="$INSTALL_BASE/share/applications"
  ICONS_BASE="$INSTALL_BASE/share/icons/hicolor"
  ICONS_DIR="$ICONS_BASE/256x256/apps"
  PIXMAPS_DIR="$INSTALL_BASE/share/pixmaps"
  TARGET_DIR="$INSTALL_BASE/share/microbrowser"
  SUDO=""
else
  BIN_DIR="/usr/local/bin"
  APPS_DIR="/usr/share/applications"
  ICONS_BASE="/usr/share/icons/hicolor"
  ICONS_DIR="$ICONS_BASE/256x256/apps"
  PIXMAPS_DIR="/usr/share/pixmaps"
  TARGET_DIR="/opt/microbrowser"
  SUDO="sudo"
fi

echo "Installing microbrowser to $TARGET_DIR ..."
$SUDO mkdir -p "$TARGET_DIR" "$BIN_DIR" "$APPS_DIR" "$ICONS_DIR" "$PIXMAPS_DIR"
$SUDO cp -r "$APP_DIR"/* "$TARGET_DIR/"

$SUDO ln -sf "$TARGET_DIR/microbrowser" "$BIN_DIR/microbrowser"
$SUDO cp "$APP_DIR/resources/microbrowser.desktop" "$APPS_DIR/microbrowser.desktop"

# Icon is bundled as an extra-resource at resources/icon.png. Install it into
# both hicolor/256x256/apps (preferred, themable) and pixmaps (universal
# fallback for older menus like lxpanel that miss hicolor cache updates).
ICON_SRC="$APP_DIR/resources/icon.png"
if [ -f "$ICON_SRC" ]; then
  $SUDO cp "$ICON_SRC" "$ICONS_DIR/microbrowser.png"
  $SUDO cp "$ICON_SRC" "$PIXMAPS_DIR/microbrowser.png"
else
  echo "warning: bundled icon not found at $ICON_SRC — menu icon may be blank" >&2
fi

command -v update-desktop-database >/dev/null 2>&1 && \
  $SUDO update-desktop-database "$APPS_DIR" 2>/dev/null || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && \
  $SUDO gtk-update-icon-cache -f "$ICONS_BASE" 2>/dev/null || true
command -v lxpanelctl >/dev/null 2>&1 && lxpanelctl restart 2>/dev/null || true

# ---------- Register microbrowser as the default web browser ----------
# Makes `xdg-open https://...` (and tools that rely on it: `gh`, `python -m
# webbrowser`, terminal hyperlink handlers, etc.) launch microbrowser. We hit
# three independent mechanisms because different distros/DEs consult different
# ones:
#   1. xdg-settings / xdg-mime  - freedesktop standard, used by xdg-open
#   2. update-alternatives      - Debian/Raspbian's x-www-browser symlink
#   3. ~/.config/mimeapps.list  - written by xdg-mime as a per-user fallback
DESKTOP_ID="microbrowser.desktop"

# xdg-settings/xdg-mime are inherently per-user. When install.sh is run with
# sudo we want to register defaults for the invoking user, not root.
if [ -n "$SUDO_USER" ] && [ "$SUDO_USER" != "root" ]; then
  RUN_AS_USER="sudo -u $SUDO_USER"
else
  RUN_AS_USER=""
fi

if command -v xdg-settings >/dev/null 2>&1; then
  $RUN_AS_USER xdg-settings set default-web-browser "$DESKTOP_ID" 2>/dev/null || true
fi

if command -v xdg-mime >/dev/null 2>&1; then
  $RUN_AS_USER xdg-mime default "$DESKTOP_ID" x-scheme-handler/http  2>/dev/null || true
  $RUN_AS_USER xdg-mime default "$DESKTOP_ID" x-scheme-handler/https 2>/dev/null || true
  $RUN_AS_USER xdg-mime default "$DESKTOP_ID" text/html              2>/dev/null || true
  $RUN_AS_USER xdg-mime default "$DESKTOP_ID" application/xhtml+xml  2>/dev/null || true
fi

# System-wide `x-www-browser` / `gnome-www-browser` alternatives (Debian family).
# Only meaningful for system installs - update-alternatives can't manage
# binaries under ~/.local.
if [ "$1" != "--user" ] && command -v update-alternatives >/dev/null 2>&1; then
  BROWSER_BIN="$BIN_DIR/microbrowser"
  $SUDO update-alternatives --install /usr/bin/x-www-browser     x-www-browser     "$BROWSER_BIN" 200 2>/dev/null || true
  $SUDO update-alternatives --install /usr/bin/gnome-www-browser gnome-www-browser "$BROWSER_BIN" 200 2>/dev/null || true
  $SUDO update-alternatives --set     x-www-browser              "$BROWSER_BIN" 2>/dev/null || true
  $SUDO update-alternatives --set     gnome-www-browser          "$BROWSER_BIN" 2>/dev/null || true
fi

echo "Done. Run: microbrowser"
echo "microbrowser is now the default web browser."
echo "Try: xdg-open https://example.com"
