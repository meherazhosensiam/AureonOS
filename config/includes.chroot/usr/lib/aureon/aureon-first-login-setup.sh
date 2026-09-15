#!/bin/bash
# ============================================================
# AUREON OS - First Login Setup
# ============================================================
# Runs once per user on first graphical login to:
# 1. Ensure ~/Desktop exists
# 2. Copy installer launcher to ~/Desktop if not present (LIVE SESSION ONLY)
# 3. Mark launcher as executable and trusted (GNOME metadata::trusted)
# 4. Create marker file to prevent re-running
# ============================================================

set -e

MARKER_FILE="$HOME/.config/aureon-first-login-done"

# Load project config for PROJECT_ID
if [ -f "/etc/aureon/project.conf" ]; then
    . /etc/aureon/project.conf
else
    PROJECT_ID="aureonos"
fi

DESKTOP_SOURCE="/etc/skel/Desktop/install-${PROJECT_ID}.desktop"
DESKTOP_DEST="$HOME/Desktop/Install AUREON OS.desktop"

# Create marker directory
mkdir -p "$(dirname "$MARKER_FILE")"

# Exit if already run
if [ -f "$MARKER_FILE" ]; then
    exit 0
fi

# Ensure Desktop directory exists (xdg-user-dirs should have created it)
mkdir -p "$HOME/Desktop"

# ONLY create installer shortcut in LIVE session
# In installed system, the installer is no longer needed
IS_LIVE=false
if [ -f "/run/live/medium" ] || [ -d "/lib/live/mount/medium" ] || grep -q "boot=live" /proc/cmdline 2>/dev/null; then
    IS_LIVE=true
fi

if [ "$IS_LIVE" = "true" ]; then
    # Copy installer launcher to Desktop if source exists and dest doesn't
    if [ -f "$DESKTOP_SOURCE" ] && [ ! -f "$DESKTOP_DEST" ]; then
        cp "$DESKTOP_SOURCE" "$DESKTOP_DEST"
        chmod +x "$DESKTOP_DEST"
    fi

    # Trust the desktop file for GNOME (requires gio and session bus)
    if [ -f "$DESKTOP_DEST" ] && command -v gio >/dev/null 2>&1; then
        # Try to set trusted metadata; may fail if no D-Bus session yet
        gio set "$DESKTOP_DEST" "metadata::trusted" true 2>/dev/null || true
    fi
fi

# Create marker to prevent re-running
touch "$MARKER_FILE"

exit 0