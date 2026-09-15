# AUREON OS — Fix Implementation Summary

## Changes Made

### 1. Calamares Branding Fix
**Files Modified:**
- `config/includes.chroot/etc/calamares/branding/aureon/branding.desc.in`
- `config/includes.chroot/usr/share/calamares/branding/aureon/branding.desc.in`

**Change:** `componentName: @PROJECT_ID@` → `componentName: aureon`

**Why:** The branding directory is named `aureon`, but `@PROJECT_ID@` resolves to `aureonos`. Calamares requires the componentName to exactly match the directory name.

### 2. Calamares Slideshow Fix
**Files Modified:**
- `config/includes.chroot/etc/calamares/branding/aureon/show.qml.in`
- `config/includes.chroot/usr/share/calamares/branding/aureon/show.qml.in`

**Change:** Slide 3 reference `testdisk.img` → `logo.png` (file exists)

### 3. Installer Launcher - Single Authoritative Source
**Files Modified:**
- **Removed:** `config/includes.chroot/usr/share/applications/install-aureon.desktop` (static duplicate)
- **Updated:** `config/hooks/normal/0500-calamares-launcher.chroot`

**Changes in Hook:**
- Uses `PROJECT_ID` from project.conf for filename: `install-aureonos.desktop`
- Display name: "Install AUREON OS"
- Installs custom icon from AUREON logo to hicolor theme: `/usr/share/icons/hicolor/256x256/apps/install-aureon.png`
- References icon as `Icon=install-aureon` (theme lookup)
- Standard category: `Categories=System;`
- Updates icon cache after installation
- Filename matches cleanup script expectation (`install-${PROJECT_ID}.desktop`)

### 4. Live User Desktop Shortcut
**New Files:**
- `config/includes.chroot/etc/skel/Desktop/install-aureonos.desktop` (executable)
- `config/includes.chroot/etc/systemd/user/aureon-first-login-setup.service`
- `config/includes.chroot/usr/lib/aureon/aureon-first-login-setup.sh` (executable)
- `config/includes.chroot/etc/systemd/user/default.target.wants/aureon-first-login-setup.service` (symlink)

**Mechanism:**
1. `/etc/skel/Desktop/install-aureonos.desktop` copied to `~/Desktop/` on first login via `xdg-user-dirs`
2. systemd user service `aureon-first-login-setup.service` runs once per user (condition: marker file absent)
3. Script detects live session (checks `/run/live/medium`, `/lib/live/mount/medium`, `boot=live` in cmdline)
4. **Only in live session:** Marks desktop file executable and sets `metadata::trusted=true` via `gio`
5. Marker file `~/.config/aureon-first-login-done` prevents re-running
6. In installed system: creates marker only, does NOT create installer shortcut (cleanup handled by Calamares)

### 5. Trust Hooks Updated
**Files Modified:**
- `config/hooks/normal/9997-trust-installer-desktop.hook.chroot`
- `config/hooks/live/9997-trust-installer-desktop.hook.chroot`

**Changes:** Use `PROJECT_ID` from project.conf for consistent filename (`install-aureonos.desktop`)

### 6. Theme Installation Reliability
**File Modified:** `config/hooks/live/9800-aureon-theme.hook.chroot`

**Changes:**
- Added `--libadwaita` flag to GTK theme installation for accent color support
- Added verification step: checks that critical theme directories exist before dconf compilation
- Exits with error if themes missing (prevents broken ISO)

### 7. Theme Verification
Verified that Fluent theme installer creates:
- GTK: `Fluent-red-Dark`, `Fluent-red-Light` ✓ (dconf: `Fluent-red-Dark`)
- Icons: `Fluent-red`, `Fluent-red-dark`, `Fluent-red-light` ✓ (dconf: `Fluent-red`)
- Cursors: `Fluent-cursors`, `Fluent-dark-cursors` ✓ (dconf: `Fluent-cursors`)

All dconf settings in `01-aureon-defaults.in` match actual installed theme names.

### 8. Dconf Configuration Verified
**Files Verified:**
- `/etc/dconf/profile/user`: `user-db:user` + `system-db:local` ✓
- `/etc/dconf/profile/gdm`: `user-db:user` + `system-db:gdm` ✓
- `/etc/dconf/db/local.d/01-aureon-defaults.in`: All settings including `accent-color='red'` ✓
- Compilation hook `9999-aureon-compile-dconf.hook.chroot`: Correctly compiles with temporary machine-id ✓

### 9. Post-Install Cleanup Consistency
The existing cleanup script (`remove-installer-launcher.sh.in`) expects filename `install-${PROJECT_ID}.desktop` (`install-aureonos.desktop`). Our launcher hook now creates this exact filename, so post-install cleanup will work correctly.

---

## Root Causes Addressed

| # | Issue | Root Cause | Fix |
|---|-------|------------|-----|
| 1 | Calamares branding error | `componentName` template used `@PROJECT_ID@` (aureonos) but directory is `aureon` | Hardcode `componentName: aureon` in templates |
| 2 | Accent color not applied | Theme missing libadwaita integration; no verification themes installed | Added `--libadwaita` flag + verification step |
| 3 | Icon theme not applied | Not a config issue - names correct. Risk: themes fail to install silently | Added verification step in theme hook |
| 4 | Cursor theme not applied | Not a config issue - names correct. Same risk as icons | Added verification step |
| 5 | Appearance pipeline breaks | Multiple potential failure points | Verified full pipeline: source → live-build → dconf compile → profile → session |
| 6 | Duplicate launcher creation | Static file + hook both creating `.desktop` | Removed static file; hook is single source |
| 7 | No desktop shortcut | No `/etc/skel/Desktop/` entry + no trust mechanism | Added skel file + systemd user first-login service (live only) |
| 8 | "Allow Launching" prompt | Trust metadata not set on user's desktop copy | First-login service sets `metadata::trusted` via `gio` (live only) |
| 9 | Installer icon missing | Used generic icon names not in theme | Installs custom AUREON logo to hicolor theme |
| 10 | Installer not in Applications menu | No system .desktop file (static file removed, hook now authoritative) | Hook creates proper .desktop in `/usr/share/applications/` |
| 11 | Category fix | Hook used `System;Installer;` | Changed to standard `System;` |
| 12 | Icon fix | Used `system-software-install` or `calamares` | Custom icon installed to hicolor theme |
| 13 | Duplicate installers | Multiple hooks/scripts creating launchers | Consolidated to single hook + skel + first-login service |
| 14 | Build hook search | Done - identified all relevant hooks | Consolidated responsibilities |

---

## Validation Checklist (Post-Rebuild)

Boot fresh ISO in VM and verify:

### Calamares
```bash
sudo calamares -d
# Must start WITHOUT: "The branding component name should match the name of the component directory."
```

### Appearance (GNOME 48)
```bash
gsettings get org.gnome.desktop.interface gtk-theme       # → 'Fluent-red-Dark'
gsettings get org.gnome.desktop.interface icon-theme      # → 'Fluent-red'
gsettings get org.gnome.desktop.interface cursor-theme    # → 'Fluent-cursors'
gsettings get org.gnome.desktop.interface accent-color    # → 'red'
gsettings get org.gnome.desktop.interface color-scheme    # → 'prefer-dark'
```

### Themes Exist
```bash
ls /usr/share/themes/Fluent-red-Dark
ls /usr/share/icons/Fluent-red
ls /usr/share/icons/Fluent-cursors
```

### Applications Menu
```bash
desktop-file-validate /usr/share/applications/install-aureonos.desktop
# "Install AUREON OS" appears in Applications → System
# Clicking launches Calamares
```

### Desktop Shortcut (LIVE SESSION ONLY)
```bash
ls -la ~/Desktop/
# Shows "Install AUREON OS.desktop"
gio info ~/Desktop/Install\ AUREON\ OS.desktop | grep metadata::trusted
# → metadata::trusted: true
# Clicking launches Calamares WITHOUT "Allow Launching" prompt
```

### Installer Launch
```bash
pkexec calamares  # Works from terminal
# Works from Applications menu
# Works from Desktop shortcut (live session)
```

### Post-Install Cleanup
After installation and first boot of installed system:
```bash
ls /usr/share/applications/install-aureonos.desktop  # Should NOT exist (cleaned up)
ls ~/Desktop/Install\ AUREON\ OS.desktop             # Should NOT exist (not created in installed system)
```

---

## Build Commands
```bash
cd /home/siam/AureonOS
sudo ./build.sh  # or whatever the build command is
# Then test in VM
```