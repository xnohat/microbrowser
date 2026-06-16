#!/bin/sh
# Post-install hook for microbrowser .deb / .rpm packages.
# Registers microbrowser as an `x-www-browser` alternative and refreshes the
# desktop database so the http/https MIME handlers from the .desktop file are
# picked up by xdg-open. We deliberately do NOT force it to become the user's
# default browser here — that's a per-user choice made via `xdg-settings`.
set -e

BIN=/opt/microbrowser/microbrowser
[ -x "$BIN" ] || BIN=/usr/bin/microbrowser

if command -v update-alternatives >/dev/null 2>&1 && [ -x "$BIN" ]; then
  update-alternatives --install /usr/bin/x-www-browser     x-www-browser     "$BIN" 200 || true
  update-alternatives --install /usr/bin/gnome-www-browser gnome-www-browser "$BIN" 200 || true
fi

command -v update-desktop-database >/dev/null 2>&1 && \
  update-desktop-database /usr/share/applications 2>/dev/null || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && \
  gtk-update-icon-cache -f /usr/share/icons/hicolor 2>/dev/null || true

exit 0
