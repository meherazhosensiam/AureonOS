# AUREON OS - Hook Execution Documentation

## Hook Types and Execution Order

### live-build Hook Stages

1. **Chroot Hooks** - Run inside the chroot during `lb chroot` stage
   - **Normal hooks** (`config/hooks/normal/`): Run first, lexical order
   - **Live hooks** (`config/hooks/live/`): Run after normal hooks, lexical order

2. **Binary Hooks** - Run during `lb binary` stage (if any exist)

### Hook Naming Convention

Hooks are named with numeric prefixes to control execution order:
- `NNNN-description.hook.chroot` - Normal chroot hook
- `NNNN-description.hook.binary` - Binary hook
- `NNNN-description.chroot` - Legacy naming (also works)

Lower numbers execute first.

---

## Normal Hooks (config/hooks/normal/)

| Order | Hook | Purpose | Critical Notes |
|-------|------|---------|----------------|
| 0200 | gnome-window-buttons.chroot | Set window button layout via gsettings | Legacy, duplicated in dconf |
| 0400 | default-user-sudo.chroot | Configure sudo for default user | Sets up sudoers |
| 0450 | remove-old-calamares-launcher.chroot | Remove old `calamares-install-debian.desktop` | Cleanup |
| 0500 | calamares-launcher.chroot | Fix permissions on `install-aureon.desktop` | `chmod 644` |
| 1000 | create-mtab-symlink.hook.chroot | Create `/etc/mtab` → `/proc/self/mounts` | Standard |
| 1010 | enable-cryptsetup.hook.chroot | Enable cryptsetup in initramfs | For encrypted installs |
| 1020 | create-locales-files.hook.chroot | Generate locale files | Runs `locale-gen` |
| 5000 | update-apt-file-cache.hook.chroot | Update apt-file cache | |
| 5010 | update-apt-xapian-index.hook.chroot | Update apt-xapian-index | |
| 5020 | update-glx-alternative.hook.chroot | Update GLX alternative | |
| 5030 | update-plocate-database.hook.chroot | Update plocate database | |
| 5040 | update-nvidia-alternative.hook.chroot | Update NVIDIA alternatives | |
| 5050 | dracut.hook.chroot | Configure dracut (if used) | Not primary for Debian |
| 8000 | remove-adjtime-configuration.hook.chroot | Clean adjtime | |
| 8010 | remove-backup-files.hook.chroot | Remove backup files | |
| 8020 | remove-dbus-machine-id.hook.chroot | Remove dbus machine-id | |
| 8030 | truncate-log-files.hook.chroot | Truncate log files | |
| 8040 | remove-mdadm-configuration.hook.chroot | Remove mdadm config | |
| 8050 | remove-openssh-server-host-keys.hook.chroot | Remove SSH host keys | Regenerated on boot |
| 8060 | remove-systemd-machine-id.hook.chroot | Remove systemd machine-id | Regenerated on boot |
| 8070 | remove-temporary-files.hook.chroot | Remove temp files | |
| 8080 | reproducible-glibc.hook.chroot | Reproducible build tweaks | |
| 8090 | remove-ssl-cert-snakeoil.hook.chroot | Remove snakeoil certs | |
| 8100 | remove-udev-persistent-cd-rules.hook.chroot | Remove udev CD rules | |
| 8110 | remove-udev-persistent-net-rules.hook.chroot | Remove udev net rules | |
| 9000 | remove-gnome-icon-cache.hook.chroot | Remove GNOME icon cache | |
| 9010 | remove-python-pyc.hook.chroot | Remove Python .pyc files | |
| 9020 | remove-man-cache.hook.chroot | Remove man page cache | |
| **99** | **set-plymouth-theme.hook.chroot** | **Set Plymouth theme + regenerate initramfs** | **Runs BEFORE live hooks** |
| 9985 | tmp-mount-hardening.hook.chroot | Harden /tmp via systemd tmp.mount | Creates drop-in |
| 9995 | aureon-branding-cleanup.hook.chroot | Remove Debian branding | Logos, wallpapers, etc. |
| 9998 | set-display-manager.hook.chroot | Enable GDM | `systemctl enable gdm3` |
| 9999 | remove-gnome-wallpapers.chroot | Remove unwanted GNOME wallpapers | Keeps only AUREON |

---

## Live Hooks (config/hooks/live/)

| Order | Hook | Purpose | Critical Notes |
|-------|------|---------|----------------|
| 0010 | disable-kexec-tools.hook.chroot | Disable kexec-tools prompt | Debconf preseed |
| 0050 | disable-sysvinit-tmpfs.hook.chroot | Disable tmpfs on /tmp | Legacy sysvinit |
| 9700 | install-custom-packages.hook.chroot | Install local .deb packages | From `/usr/local/share/aureon/packages/` |
| 98 | lightweight-startup.hook.chroot | Disable unneeded autostart entries | Removes from /etc/xdg/autostart/ |
| 98 | set-zsh-default.hook.chroot | Set Zsh as default shell | Updates /etc/adduser.conf, /etc/default/useradd |
| 98 | strip-services.hook.chroot | Disable unneeded services | avahi, cups, bluetooth, ModemManager |
| **9800** | **aureon-theme.hook.chroot** | **Install Fluent GTK/Icon/Cursor themes** | **REQUIRED by dconf settings** |
| 99 | configure-flatpak.hook.chroot | Add Flathub remote | System + user |
| 99 | enable-cleanup-timer.hook.chroot | Enable aureon-cleanup.timer | |
| 99 | enable-clear-memory.hook.chroot | Enable clear-memory.service | |
| 99 | fix-menus.hook.chroot | Create security tool .desktop files | nmap, wireshark, sqlmap, burpsuite |
| 99 | usbguard.hook.chroot | Enable USBGuard service | |
| **9999** | **aureon-compile-dconf.hook.chroot** | **Compile dconf database (FINAL)** | **Runs LAST, after themes** |

---

## Critical Dependency Chain

```
Normal Hooks (0000-9999)
    │
    ├─► 99-set-plymouth-theme.hook.chroot
    │       │
    │       └─► Sets Plymouth theme "aureon"
    │           └─► Runs plymouth-set-default-theme -R
    │               └─► Regenerates initramfs WITH theme
    │
    └─► (other normal hooks)
    
Live Hooks (0000-9999)
    │
    ├─► 9800-aureon-theme.hook.chroot
    │       │
    │       └─► Installs Fluent themes:
    │           ├─► Fluent GTK theme → /usr/share/themes/Fluent-red-Dark
    │           ├─► Fluent Icon theme → /usr/share/icons/Fluent-red
    │           └─► Fluent Cursor theme → /usr/share/icons/Fluent-cursors
    │
    └─► 9999-aureon-compile-dconf.hook.chroot
            │
            └─► Creates temporary machine-id
                └─► Runs dconf update
                    └─► Compiles /etc/dconf/db/local from local.d/*
                    └─► Compiles /etc/dconf/db/gdm from gdm.d/*
                └─► Removes temporary machine-id
            │
            └─► dconf settings now reference EXISTING themes ✓
```

### Why This Order Matters

1. **Plymouth (normal hook 99)** runs early - OK because Plymouth theme is independent of GTK theme
2. **Fluent themes (live hook 9800)** install the GTK/Icon/Cursor themes
3. **dconf compilation (live hook 9999)** runs LAST - ensures all referenced themes exist

**Previously BROKEN:** Old `9999-import-dconf.hook.chroot` (normal hook) ran BEFORE theme installation, creating incomplete database.

---

## Hook Environment

All hooks run inside the chroot with:
- `DEBIAN_FRONTEND=noninteractive`
- Root privileges
- Full access to chroot filesystem
- Network access (for theme downloads in 9800-aureon-theme)

---

## Adding New Hooks

1. Create script in appropriate directory:
   - `config/hooks/normal/NNNN-name.hook.chroot` - for chroot-stage configuration
   - `config/hooks/live/NNNN-name.hook.chroot` - for live-system customization

2. Make executable: `chmod +x config/hooks/.../NNNN-name.hook.chroot`

3. Choose number based on dependencies:
   - Before theme install: < 9800 (live) or < 99 (normal)
   - After theme install: > 9800 (live)
   - After dconf compile: > 9999 (live) - not recommended

4. Test with: `sudo ./build.sh --clean`

---

## Removed Hooks

- **9999-import-dconf.hook.chroot** (normal) - REMOVED
  - Ran too early (before theme installation)
  - Created incomplete dconf database
  - Replaced by 9999-aureon-compile-dconf.hook.chroot (live, runs last)

---

*Last updated: 2026-08-29*
