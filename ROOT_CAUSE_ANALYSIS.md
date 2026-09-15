# AUREON OS — Root Cause Analysis Report

---

## ROOT CAUSE 1: Calamares Branding Component Name Mismatch

**Problem:**
Calamares fails to start with: `The branding component name should match the name of the component directory.`

**Evidence:**
- `config/includes.chroot/etc/calamares/branding/aureon/branding.desc.in` line 2: `componentName: @PROJECT_ID@`
- `config/project.conf` line 17: `PROJECT_ID="aureonos"`
- Actual branding directory: `/etc/calamares/branding/aureon/` (and `/usr/share/calamares/branding/aureon/`)
- `config/includes.chroot/etc/calamares/settings.conf` line 100: `branding: aureon`

**Affected Files:**
- `config/includes.chroot/etc/calamares/branding/aureon/branding.desc.in`
- `config/includes.chroot/usr/share/calamares/branding/aureon/branding.desc.in`
- `config/project.conf` (indirectly)
- `config/includes.chroot/etc/calamares/settings.conf`

**Why It Happens:**
The `branding.desc.in` template uses `@PROJECT_ID@` which resolves to `aureonos`, but the branding directory is named `aureon`. Calamares expects the `componentName` in `branding.desc` to exactly match the directory name. The substitution hook (`0010-project-identity-substitution.hook.chroot`) replaces `@PROJECT_ID@` with `aureonos`, creating a mismatch.

**Fix:**
Change `componentName: @PROJECT_ID@` to `componentName: aureon` in both `branding.desc.in` files. The branding component directory name (`aureon`) is a deliberate choice distinct from `PROJECT_ID` (`aureonos`) and should be hardcoded in the template.

**Source → Build → ISO → Runtime Path:**
```
branding.desc.in (componentName: aureon)
    ↓ live-build includes.chroot
/etc/calamares/branding/aureon/branding.desc (componentName: aureon)
    ↓ Calamares reads settings.conf → branding: aureon
    ↓ Calamares loads /etc/calamares/branding/aureon/branding.desc
    ↓ componentName matches directory → SUCCESS
```

---

## ROOT CAUSE 2: Duplicate/Conflicting Calamares Launcher Creation

**Problem:**
Two mechanisms create `/usr/share/applications/install-aureon.desktop` with different content:
1. `config/includes.chroot/usr/share/applications/install-aureon.desktop` (static file)
2. `config/hooks/normal/0500-calamares-launcher.chroot` (overwrites at build time)

The hook version uses `Icon=system-software-install` and `Categories=System;Installer;`, while the static file uses `Icon=calamares` and `Categories=System;`. The hook runs later and wins, but the static file is misleading.

**Evidence:**
- `config/includes.chroot/usr/share/applications/install-aureon.desktop` exists
- `config/hooks/normal/0500-calamares-launcher.chroot` overwrites it
- `config/hooks/normal/0450-remove-old-calamares-launcher.chroot` removes old Debian launcher

**Affected Files:**
- `config/includes.chroot/usr/share/applications/install-aureon.desktop` (should be removed)
- `config/hooks/normal/0500-calamares-launcher.chroot` (authoritative source)

**Why It Happens:**
Historical accumulation — the static file was created first, then the hook was added to customize it, but the static file was never removed.

**Fix:**
1. Remove `config/includes.chroot/usr/share/applications/install-aureon.desktop`
2. Fix `0500-calamares-launcher.chroot` to use correct icon (`calamares` or a proper AUREON icon) and standard category (`System;`)
3. Ensure `Exec=pkexec calamares` is correct for PolicyKit integration

**Source → Build → ISO → Runtime Path:**
```
0500-calamares-launcher.chroot (authoritative)
    ↓ live-build normal hook stage
/usr/share/applications/install-aureon.desktop
    ↓ GNOME Applications menu reads .desktop files
    ↓ "Install AUREON OS" appears in System category
```

---

## ROOT CAUSE 3: Desktop Shortcut Not Created for Live User

**Problem:**
The installer shortcut appears in Applications menu but NOT on the live user's Desktop (`~/Desktop/Install AUREON OS.desktop`). The trust hook (`9997-trust-installer-desktop.hook.chroot`) only marks the system-wide file as trusted, not a user desktop copy.

**Evidence:**
- `config/hooks/live/9997-trust-installer-desktop.hook.chroot` only processes `/usr/share/applications/install-aureon.desktop`
- No hook creates `~/Desktop/install-aureon.desktop` for the live user (`aureon`)
- `/etc/skel/` has no `Desktop/` directory or installer shortcut

**Affected Files:**
- `config/hooks/live/9997-trust-installer-desktop.hook.chroot` (incomplete)
- Missing: mechanism to create user desktop shortcut

**Why It Happens:**
GNOME does not automatically symlink/copy `.desktop` files from `/usr/share/applications/` to `~/Desktop/`. The live user's Desktop directory is created at first login from `/etc/skel/Desktop/` (if it exists) or by `xdg-user-dirs-update`. No build hook populates this.

**Fix:**
Add a live hook that:
1. Creates `/etc/skel/Desktop/` with the installer `.desktop` file
2. Makes it executable (`chmod +x`)
3. Sets `metadata::trusted` via `gio` (requires the file to exist in the user's home at runtime, so this must happen at first login or via a systemd user service)

Better approach: Create a first-login autostart script or systemd user service that copies the launcher to `~/Desktop/` and marks it trusted. This runs in the user's session context where `gio` can set metadata.

**Source → Build → ISO → Runtime Path:**
```
New hook: create /etc/skel/Desktop/install-aureon.desktop (executable)
    ↓ live-build includes
/etc/skel/Desktop/install-aureon.desktop
    ↓ First login: xdg-user-dirs creates ~/Desktop from /etc/skel/Desktop/
~/Desktop/Install AUREON OS.desktop (executable, trusted via metadata)
    ↓ GNOME Shell allows launch without prompt
```

---

## ROOT CAUSE 4: Accent Color Not Applied (GNOME 48 Compatibility)

**Problem:**
`accent-color='red'` is set in dconf but not visible in GNOME 48 Appearance settings.

**Evidence:**
- `config/includes.chroot/etc/dconf/db/local.d/01-aureon-defaults.in` line 68: `accent-color='red'`
- GNOME 48 uses `accent-color` key in `org.gnome.desktop.interface` schema
- The setting IS in the correct schema

**Affected Files:**
- `config/includes.chroot/etc/dconf/db/local.d/01-aureon-defaults.in`

**Why It Happens:**
The `accent-color` setting was introduced in GNOME 46 and requires:
1. The GTK theme to support accent colors (Fluent themes do via libadwaita)
2. `libadwaita` to be at version ≥ 1.4
3. The setting to be read before GTK initializes

The issue is likely that the dconf database is compiled at build time (hook `9999-aureon-compile-dconf.hook.chroot`) but the live user session may not be reading the system database correctly, OR the Fluent GTK theme's libadwaita integration isn't active.

The hook compiles the database with a temporary machine-id, then removes it. This is correct. But we need to verify the profile is correct: `/etc/dconf/profile/user` has `user-db:user` and `system-db:local` — this IS correct.

**Investigation Needed:**
- Verify `libadwaita` version in Trixie supports accent-color
- Verify Fluent GTK theme installs libadwaita color scheme files
- The accent color may require the GTK theme to be applied FIRST (which it is via `gtk-theme='Fluent-red-Dark'`)

**Likely Fix:**
The setting is correct. The issue may be that the user's dconf profile isn't loading the system database. Verify by checking if `gsettings get org.gnome.desktop.interface accent-color` returns `red` in a live session. If not, the profile or database compilation has an issue.

**Source → Build → ISO → Runtime Path:**
```
01-aureon-defaults.in (accent-color='red')
    ↓ 9999-aureon-compile-dconf.hook.chroot → dconf update
/etc/dconf/db/local (compiled binary)
    ↓ /etc/dconf/profile/user (system-db:local)
    ↓ User session starts → dconf reads profile → loads local db
    ↓ gsettings returns 'red'
    ↓ libadwaita/GNOME Shell applies accent to UI
```

---

## ROOT CAUSE 5: Icon/Cursor Theme Names Verified Correct

**Problem (Non-Issue):**
The configured icon/cursor theme names match what the Fluent theme installer creates.

**Evidence:**
- GTK theme installs: `Fluent-red-Dark`, `Fluent-red-Light` ✓ (dconf: `Fluent-red-Dark`)
- Icon theme installs: `Fluent-red`, `Fluent-red-dark`, `Fluent-red-light` ✓ (dconf: `Fluent-red`)
- Cursor theme installs: `Fluent-cursors`, `Fluent-dark-cursors` ✓ (dconf: `Fluent-cursors`)

**Why It Might Appear Broken:**
If themes fail to install (network issues during build, git clone failure), the themes won't exist in the ISO. The hook `9800-aureon-theme.hook.chroot` has no error handling for failed downloads.

**Fix:**
Add error checking to the theme installation hook. Verify theme directories exist after installation before dconf compilation.

---

## ROOT CAUSE 6: Installer Icon May Be Missing

**Problem:**
The launcher uses `Icon=system-software-install` (from hook) or `Icon=calamares` (from static file). Neither may exist in the installed icon theme.

**Evidence:**
- `0500-calamares-launcher.chroot` uses `Icon=system-software-install`
- Static file uses `Icon=calamares`
- Fluent icon theme does not guarantee these standard icon names exist

**Fix:**
Use a generic icon name that exists in Adwaita/Fluent (e.g., `system-software-install` is standard in Adwaita) OR install a custom AUREON installer icon to `/usr/share/icons/hicolor/scalable/apps/install-aureon.svg` and reference it as `Icon=install-aureon`.

**Source → Build → ISO → Runtime Path:**
```
Hook installs custom icon → /usr/share/icons/hicolor/scalable/apps/install-aureon.svg
    ↓ gtk-update-icon-cache runs
    ↓ .desktop file: Icon=install-aureon
    ↓ GNOME loads icon from theme
```

---

## ROOT CAUSE 7: Trust Metadata Only Applied to System File

**Problem:**
`9997-trust-installer-desktop.hook.chroot` runs `gio set` on `/usr/share/applications/install-aureon.desktop` at build time. But:
1. This only works if `gio` is available in chroot (it is, via `glib2.0-bin`)
2. The metadata is stored in the filesystem's extended attributes — but the chroot filesystem may not support xattrs, or they may not persist to the squashfs
3. The user's desktop copy (when created) won't have this metadata

**Evidence:**
- Hook runs at build time in chroot
- `gio set` requires filesystem xattr support
- Live user's desktop copy is a different inode

**Fix:**
Trust metadata must be applied at runtime in the user's session. Use a first-login mechanism (systemd user service or autostart) to:
1. Copy launcher to `~/Desktop/`
2. `chmod +x`
3. `gio set ~/Desktop/install-aureon.desktop metadata::trusted true`

---

## SUMMARY OF FIXES NEEDED

| # | Issue | Fix Location |
|---|-------|--------------|
| 1 | Calamares branding componentName mismatch | `branding.desc.in` files: hardcode `componentName: aureon` |
| 2 | Duplicate launcher creation | Remove static `.desktop` from `includes.chroot`; fix hook |
| 3 | No desktop shortcut for live user | Add `/etc/skel/Desktop/install-aureon.desktop` + first-login trust setup |
| 4 | Accent color not visible | Verify dconf profile/database; ensure libadwaita theme integration |
| 5 | Theme install reliability | Add error checking to `9800-aureon-theme.hook.chroot` |
| 6 | Installer icon | Install custom icon + reference in `.desktop` |
| 7 | Trust metadata at runtime | First-login systemd user service to copy + trust desktop file |

---

## VALIDATION CHECKLIST (Post-Fix)

After rebuilding ISO and booting fresh live session:

```bash
# 1. Calamares branding
sudo calamares -d  # Must start without branding error

# 2. Appearance
gsettings get org.gnome.desktop.interface gtk-theme       # → Fluent-red-Dark
gsettings get org.gnome.desktop.interface icon-theme      # → Fluent-red
gsettings get org.gnome.desktop.interface cursor-theme    # → Fluent-cursors
gsettings get org.gnome.desktop.interface accent-color    # → red
gsettings get org.gnome.desktop.interface color-scheme    # → prefer-dark

# 3. Themes exist
ls /usr/share/themes/Fluent-red-Dark
ls /usr/share/icons/Fluent-red
ls /usr/share/icons/Fluent-cursors

# 4. Applications menu
desktop-file-validate /usr/share/applications/install-aureon.desktop
# "Install AUREON OS" appears in Applications → System

# 5. Desktop shortcut
ls -la ~/Desktop/
gio info ~/Desktop/Install\ AUREON\ OS.desktop | grep metadata::trusted
# Clicking launches Calamares without "Allow Launching" prompt

# 6. Installer launches from both menu and desktop
pkexec calamares  # Works from terminal
```