# AUREON OS - Desktop Configuration Documentation

## Overview

This document explains how GNOME desktop configuration is applied in AUREON OS, covering both the live system and the installed system.

---

## Configuration Layers

### 1. System-Wide dconf Databases (Primary)

**Location:** `/etc/dconf/db/` (compiled binary databases)
**Source:** `/etc/dconf/db/*.d/` (text keyfiles)

| Database | Profile | Applies To | Source Files |
|----------|---------|------------|--------------|
| `local` | `user` | All users | `local.d/00-aureon-extensions`, `local.d/01-aureon-defaults`, `local.d/01-window-buttons`, `local.d/10-arcmenu-branding` |
| `gdm` | `gdm` | GDM login screen | `gdm.d/00-aureon-login` |

**Mechanism:**
1. Source files installed via `config/includes.chroot/etc/dconf/db/`
2. `9999-aureon-compile-dconf.hook.chroot` runs `dconf update` during build
3. Compiled databases copied to installed system via Calamares `unpackfs`
4. dconf reads databases automatically based on profile

**Profiles** (`/etc/dconf/profile/`):
- `user`: `user-db:user` + `system-db:local`
- `gdm`: `user-db:user` + `system-db:gdm`

### 2. GSettings Schema Overrides

**Location:** `/usr/share/glib-2.0/schemas/`
**Mechanism:** XML schemas with default values, compiled with `glib-compile-schemas`
**Usage:** Minimal in AUREON OS (mostly uses dconf instead)

### 3. User Skeleton (/etc/skel)

**Location:** `/etc/skel/`
**Copied to:** New user home directories
**Applied by:** `live-config` (live) / Calamares `users` module (installed)

**Contents:**
- `.bashrc` - Bash prompt, aliases, LS_COLORS
- `.zshrc` - Zsh configuration
- `.config/autostart/` - Disable evolution, gnome-software-service
- `.config/gtk-3.0/settings.ini` - GTK3 settings
- `.config/gtk-4.0/settings.ini` - GTK4 settings
- `.config/tiling-assistant/` - Tiling Assistant layouts

### 4. System-Wide XDG Autostart

**Location:** `/etc/xdg/autostart/`
**Applied to:** All users on login
**Contents:**
- `aureon-welcome.desktop` - Welcome app on first login
- (Removed: evolution-data-server, gnome-software-service via 98-lightweight-startup)

---

## Theme Configuration

### Fluent Theme Suite (Installed by 9800-aureon-theme.hook.chroot)

| Component | Theme Name | Path | dconf Key |
|-----------|------------|------|-----------|
| GTK Theme | Fluent-red-Dark / Fluent-red-Light | `/usr/share/themes/` | `gtk-theme` |
| Icon Theme | Fluent-red | `/usr/share/icons/` | `icon-theme` |
| Cursor Theme | Fluent-cursors | `/usr/share/icons/` | `cursor-theme` |

### dconf Theme Settings

**User Profile (local.d/01-aureon-defaults):**
```ini
[desktop/interface]
gtk-theme='Fluent-red-Dark'
icon-theme='Fluent-red'
cursor-theme='Fluent-cursors'
color-scheme='prefer-dark'
font-name='Inter 10'
document-font-name='Inter 10'
monospace-font-name='JetBrains Mono 10'
accent-color='red'
```

**GDM Profile (gdm.d/00-aureon-login):**
```ini
[org/gnome/desktop/interface]
gtk-theme='Fluent-red-Dark'
icon-theme='Fluent-red'
cursor-theme='Fluent-cursors'
color-scheme='prefer-dark'

[org/gnome/login-screen]
logo='/usr/share/aureonos/assets/logo.png'
background='/usr/share/backgrounds/aureon/dark.png'
```

**User Theme Extension (required for shell theme):**
```ini
[shell/extensions/user-theme]
name='Fluent-red-Dark'
```

### Wallpapers

**Location:** `/usr/share/backgrounds/aureon/`
- `light.png` - Light mode wallpaper
- `dark.png` - Dark mode wallpaper

**dconf Settings:**
```ini
[desktop/background]
picture-uri='file:///usr/share/backgrounds/aureon/light.png'
picture-uri-dark='file:///usr/share/backgrounds/aureon/dark.png'

[desktop/screensaver]
picture-uri='file:///usr/share/backgrounds/aureon/dark.png'
picture-uri-dark='file:///usr/share/backgrounds/aureon/dark.png'
```

---

## GNOME Shell Extensions

### Enabled Extensions (via dconf system database)

| Extension | UUID | Source | Purpose |
|-----------|------|--------|---------|
| Dash to Panel | dash-to-panel@jderose9.github.com | Bundled | Taskbar-style panel |
| ArcMenu | arcmenu@arcmenu.com | Bundled | Advanced app menu |
| Date Menu Formatter | date-menu-formatter@marcinjakubowski.github.com | Bundled | Custom date format |
| Tiling Assistant | tiling-assistant@leleat-on-github | Bundled | Window tiling |
| Just Perfection | just-perfection-desktop@just-perfection | Bundled | Shell customization |
| AppIndicator Support | appindicatorsupport@rgcjonas.gmail.com | Bundled | System tray icons |
| Clipboard Indicator | clipboard-indicator@tudmotu.com | Bundled | Clipboard history |
| Quick Settings Tweaks | quick-settings-tweaks@qwreey | Bundled | Quick settings customization |
| User Theme | user-theme@gnome-shell-extensions.gcampax.github.com | Package | Load shell themes |

### Extension Configuration (in 01-aureon-defaults)

Each extension has a `[shell/extensions/<name>]` section with its settings. Key configurations:

**Dash to Panel:** Panel layout, transparency, behavior
**ArcMenu:** Custom logo, layout, pinned apps, hotkeys
**Tiling Assistant:** Keybindings, window gaps, focus hints
**Just Perfection:** Support notifier version

---

## Font Configuration

**Installed Fonts (packages):**
- `fonts-inter` - UI font
- `fonts-jetbrains-mono` - Monospace font
- `fonts-dejavu*` - Fallback fonts
- `fonts-noto*` - International/CJK/Emoji
- `fonts-lohit-beng-bengali` - Bengali
- `fonts-hosny-amiri` - Arabic
- `fonts-thai-tlwg` - Thai
- `fonts-indic` - Indic scripts

**dconf Font Settings:**
```ini
font-name='Inter 10'
document-font-name='Inter 10'
monospace-font-name='JetBrains Mono 10'
```

---

## Favorite Applications (Dash/Panel)

**dconf Setting:** `[shell] favorite-apps`
```ini
favorite-apps=[
  'org.gnome.Terminal.desktop',
  'com.aureon.SecurityCenter.desktop',
  'org.gnome.Nautilus.desktop',
  'firefox-esr.desktop',
  'org.gnome.TextEditor.desktop'
]
```

---

## App Grid Layout

**dconf Setting:** `[shell] app-picker-layout`
Organizes applications into folders (System, Utilities) and custom positions.

---

## Window Management

**Button Layout:** `:minimize,maximize,close` (right side)
**Keybindings:** Custom tiling keys via Tiling Assistant (Super+arrows, Super+Keypad)
**Edge Tiling:** Disabled (handled by Tiling Assistant)

---

## Night Light

**Enabled:** Yes (`night-light-enabled=true`)
**Schedule:** Manual (`night-light-schedule-automatic=false`)

---

## Live User vs Installed User

### Live User (created by live-config)
- Username: `aureon` (from boot param `username=aureon`)
- Full name: `AureonOS Live User`
- Home: `/home/aureon`
- Gets `/etc/skel` copied at boot
- System dconf databases apply immediately
- Auto-login configured via live-boot

### Installed User (created by Calamares)
- Username: User-defined during install
- Home: `/home/<username>`
- Gets `/etc/skel` copied by Calamares
- System dconf databases apply (copied via unpackfs)
- No auto-login by default

---

## First Login Experience

1. **Welcome App** (`aureon-welcome.desktop` in `/etc/xdg/autostart/`)
   - Runs on first login for any user
   - Creates marker `~/.config/aureon/welcome-complete`
   - Multi-language support (EN, BN, HI, FR, DE)

2. **Extensions Loaded** - Enabled via system dconf
3. **Theme Applied** - Fluent theme via dconf + user-theme extension
4. **Panel/Dash** - Dash to Panel + ArcMenu configured

---

## Customization Points

### To Change Theme
1. Update `9800-aureon-theme.hook.chroot` or replace theme files
2. Update `gtk-theme`, `icon-theme`, `cursor-theme` in:
   - `config/includes.chroot/etc/dconf/db/local.d/01-aureon-defaults`
   - `config/includes.chroot/etc/dconf/db/gdm.d/00-aureon-login`
   - `config/includes.chroot/etc/dconf/db/local.d/01-aureon-defaults` → `[shell/extensions/user-theme]`
3. Rebuild

### To Add Extension
1. Copy to `config/includes.chroot/usr/share/gnome-shell/extensions/<uuid>/`
2. Add UUID to `config/includes.chroot/etc/dconf/db/local.d/00-aureon-extensions`
3. Add configuration section to `01-aureon-defaults` if needed
4. Rebuild

### To Change Wallpaper
1. Replace files in `config/includes.chroot/usr/share/backgrounds/aureon/`
2. Update `picture-uri` / `picture-uri-dark` in dconf files
3. Rebuild

### To Modify Favorite Apps
1. Edit `favorite-apps` in `config/includes.chroot/etc/dconf/db/local.d/01-aureon-defaults`
2. Rebuild

---

## Verification Commands

```bash
# Check compiled dconf databases
ls -la /etc/dconf/db/

# Read system settings
dconf dump / | grep -E "(gtk-theme|icon-theme|cursor-theme|enabled-extensions)"

# Check GDM settings
sudo -u gdm dconf dump /

# Verify extensions
ls /usr/share/gnome-shell/extensions/

# Check Plymouth theme
plymouth-set-default-theme --list
cat /etc/plymouth/plymouthd.conf

# Check initramfs for Plymouth
lsinitramfs /boot/initrd.img-$(uname -r) | grep plymouth
```

---

*Last updated: 2026-08-29*
