#!/bin/sh
# ============================================================
# AUREON OS - Post-Install Cleanup Script
# ============================================================
# Removes installer desktop shortcuts from the target system.
# This script runs via Calamares shellprocess module (dontChroot: true)
# while /target is still mounted, right before Calamares unmounts it.
# ============================================================

set -e

TARGET_ROOT="${1:-/target}"

echo "[INFO] Removing installer desktop shortcuts from target system..."

# List of paths to clean (relative to target root)
CLEANUP_PATHS="
    etc/skel/Desktop/install-aureon.desktop
    usr/share/applications/install-aureon.desktop
"

for path in $CLEANUP_PATHS; do
    full_path="${TARGET_ROOT}/${path}"
    if [ -f "$full_path" ]; then
        rm -f "$full_path"
        echo "[OK] Removed: $path"
    fi
done

# Clean up any user home directories that may have been created
for user_home in "${TARGET_ROOT}"/home/*; do
    if [ -d "$user_home" ]; then
        user_desktop="${user_home}/Desktop/install-aureon.desktop"
        user_autostart="${user_home}/.config/autostart/install-aureon.desktop"
        
        if [ -f "$user_desktop" ]; then
            rm -f "$user_desktop"
            echo "[OK] Removed: ${user_home#${TARGET_ROOT}}/Desktop/install-aureon.desktop"
        fi
        if [ -f "$user_autostart" ]; then
            rm -f "$user_autostart"
            echo "[OK] Removed: ${user_home#${TARGET_ROOT}}/.config/autostart/install-aureon.desktop"
        fi
    fi
done

# Also clean root's desktop/autostart if exists
root_desktop="${TARGET_ROOT}/root/Desktop/install-aureon.desktop"
root_autostart="${TARGET_ROOT}/root/.config/autostart/install-aureon.desktop"

if [ -f "$root_desktop" ]; then
    rm -f "$root_desktop"
    echo "[OK] Removed: root/Desktop/install-aureon.desktop"
fi
if [ -f "$root_autostart" ]; then
    rm -f "$root_autostart"
    echo "[OK] Removed: root/.config/autostart/install-aureon.desktop"
fi

echo "[INFO] Installer cleanup complete."
exit 0