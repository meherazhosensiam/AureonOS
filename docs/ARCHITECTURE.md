# AUREON OS - Project Architecture Documentation

## Overview

AUREON OS is a Debian-based live operating system built with `live-build`. It provides a customized GNOME desktop environment with security-focused tools, custom theming, and a Calamares-based installer.

**Base Distribution:** Debian 13 (Trixie)  
**Architecture:** amd64 (primary)  
**Desktop Environment:** GNOME 48  
**Build Tool:** live-build 20250505+deb13u1  
**Installer:** Calamares 3.3.14  

---

## Repository Structure

```
AureonOS/
│
├── auto/
│   └── config                    # Live-build architecture configuration (single source of truth)
│
├── config/
│   ├── common                    # Common live-build options (all stages)
│   ├── chroot                    # Chroot stage options
│   ├── binary                    # Binary stage options
│   ├── bootstrap                 # Bootstrap stage options
│   ├── source                    # Source build options
│   │
│   ├── package-lists/
│   │   ├── aureon.list.chroot    # Main package list (GNOME, tools, themes, etc.)
│   │   └── live.list.chroot      # Live system packages (live-boot, live-config)
│   │
│   ├── hooks/
│   │   ├── normal/               # Chroot hooks (run during chroot stage, numbered 0000-9999)
│   │   └── live/                 # Live hooks (run during chroot stage after normal, numbered 0000-9999)
│   │
│   ├── includes.chroot/          # Files copied to chroot (becomes live system rootfs)
│   │   ├── etc/
│   │   │   ├── dconf/            # dconf system databases and profiles
│   │   │   ├── calamares/        # Calamares installer configuration
│   │   │   ├── plymouth/         # Plymouth boot splash configuration
│   │   │   ├── skel/             # User skeleton (copied to new user home dirs)
│   │   │   ├── xdg/              # System-wide XDG autostart
│   │   │   └── ...
│   │   ├── usr/
│   │   │   ├── share/
│   │   │   │   ├── gnome-shell/extensions/  # Custom GNOME extensions
│   │   │   │   ├── plymouth/themes/         # Plymouth themes
│   │   │   │   ├── backgrounds/             # Wallpapers
│   │   │   │   └── aureonos/                # AUREON assets (logo, etc.)
│   │   │   ├── bin/                        # Custom scripts (aureon-welcome)
│   │   │   └── local/lib/calamares/        # Calamares helper scripts
│   │   └── ...
│   │
│   ├── includes.binary/          # Files copied to binary image (ISO root)
│   │   └── boot/grub/grub.cfg    # GRUB configuration for live boot
│   │
│   ├── includes.chroot_after_packages/  # Copied after package installation
│   └── includes.chroot_before_packages/ # Copied before package installation
│
├── build.sh                      # Main build script (wrapper for live-build)
├── release-clean.sh              # Repository cleanup for releases
├── logs/                         # Build logs
├── chroot/                       # Live-build chroot workspace (generated)
├── binary/                       # Live-build binary workspace (generated)
├── cache/                        # Live-build cache (generated)
├── .build/                       # Live-build state (generated)
└── docs/                         # Documentation (this directory)
```

---

## Build Pipeline

The build process follows the standard live-build stages:

### 1. Configuration (`lb config` / `auto/config`)
- Reads `config/common`, `config/chroot`, `config/binary`, `config/bootstrap`
- `auto/config` is the single source of truth, invoked with `ARCH` environment variable
- Sets up symlinks for hooks in `config/hooks/`

### 2. Bootstrap (`lb bootstrap`)
- Debootstraps minimal Debian system
- Uses mirrors from config
- Caches bootstrap for faster rebuilds

### 3. Chroot Stage (`lb chroot`)
This is where most customization happens:

**3a. Package Installation**
- Installs packages from `config/package-lists/*.list.chroot`
- Runs `apt-get update` and `apt-get install`

**3b. Includes Copying**
- `config/includes.chroot_before_packages/` → chroot (before packages)
- `config/includes.chroot/` → chroot (after packages, main includes)
- `config/includes.chroot_after_packages/` → chroot (after packages)

**3c. Hooks Execution (Critical Order)**
Hooks run in lexical order by filename:

**Normal Hooks** (`config/hooks/normal/`):
```
0200-gnome-window-buttons.chroot       # Window button layout (legacy)
0400-default-user-sudo.chroot          # Sudo configuration
0450-remove-old-calamares-launcher.chroot  # Remove old launcher
0500-calamares-launcher.chroot         # Fix launcher permissions
1000-create-mtab-symlink.hook.chroot   # /etc/mtab symlink
1010-enable-cryptsetup.hook.chroot     # Cryptsetup
1020-create-locales-files.hook.chroot  # Locale generation
5000-update-apt-file-cache.hook.chroot # APT file cache
5010-update-apt-xapian-index.hook.chroot # APT xapian index
5020-update-glx-alternative.hook.chroot  # GLX alternatives
5030-update-plocate-database.hook.chroot # plocate database
5040-update-nvidia-alternative.hook.chroot # NVIDIA alternatives
5050-dracut.hook.chroot                # Dracut initramfs (if used)
8000-remove-adjtime-configuration.hook.chroot
8010-remove-backup-files.hook.chroot
8020-remove-dbus-machine-id.hook.chroot
8030-truncate-log-files.hook.chroot
8040-remove-mdadm-configuration.hook.chroot
8050-remove-openssh-server-host-keys.hook.chroot
8060-remove-systemd-machine-id.hook.chroot
8070-remove-temporary-files.hook.chroot
8080-reproducible-glibc.hook.chroot
8090-remove-ssl-cert-snakeoil.hook.chroot
8100-remove-udev-persistent-cd-rules.hook.chroot
8110-remove-udev-persistent-net-rules.hook.chroot
9000-remove-gnome-icon-cache.hook.chroot
9010-remove-python-pyc.hook.chroot
9020-remove-man-cache.hook.chroot
99-set-plymouth-theme.hook.chroot      # ← Plymouth theme + initramfs
9985-tmp-mount-hardening.hook.chroot   # /tmp hardening via systemd
9995-aureon-branding-cleanup.hook.chroot # Remove Debian branding
9998-set-display-manager.hook.chroot   # Enable GDM
9999-remove-gnome-wallpapers.chroot    # Remove unwanted wallpapers
```

**Live Hooks** (`config/hooks/live/`):
```
0010-disable-kexec-tools.hook.chroot
0050-disable-sysvinit-tmpfs.hook.chroot
9700-install-custom-packages.hook.chroot  # Local .deb packages
98-lightweight-startup.hook.chroot      # Disable unneeded autostart
98-set-zsh-default.hook.chroot          # Set Zsh as default shell
98-strip-services.hook.chroot           # Disable unneeded services
9800-aureon-theme.hook.chroot           # ← Install Fluent GTK/Icon/Cursor themes
99-configure-flatpak.hook.chroot        # Add Flathub remote
99-enable-cleanup-timer.hook.chroot     # Enable cleanup timer
99-enable-clear-memory.hook.chroot      # Enable memory clearing
99-fix-menus.hook.chroot                # Create security tool launchers
99-usbguard.hook.chroot                 # Enable USBGuard
9999-aureon-compile-dconf.hook.chroot   # ← Compile dconf database (LAST)
```

**Critical Hook Dependencies:**
- `99-set-plymouth-theme` (normal) runs BEFORE `9800-aureon-theme` (live) - OK, Plymouth independent
- `9800-aureon-theme` installs Fluent themes REQUIRED by dconf settings
- `9999-aureon-compile-dconf` runs LAST, AFTER themes installed - CORRECT
- The old `9999-import-dconf.hook.chroot` (normal) was REMOVED - it ran too early

### 4. Binary Stage (`lb binary`)
- Creates squashfs filesystem from chroot
- Copies kernel/initramfs to `binary/live/`
- Installs bootloader (GRUB for BIOS, GRUB-EFI for UEFI)
- Runs binary hooks (if any)
- Builds ISO image

### 5. ISO Output
- `live-image-amd64.hybrid.iso` → renamed to `AureonOS-<version>-<arch>.iso`
- SHA256 checksum generated

---

## Configuration Systems

### 1. dconf (GNOME Settings)
**System Databases** (compiled, apply to all users):
- `/etc/dconf/db/local` - Main user settings (compiled from `/etc/dconf/db/local.d/`)
- `/etc/dconf/db/gdm` - GDM login screen settings (compiled from `/etc/dconf/db/gdm.d/`)

**Profiles** (tell dconf which databases to use):
- `/etc/dconf/profile/user` → `user-db:user` + `system-db:local`
- `/etc/dconf/profile/gdm` → `user-db:user` + `system-db:gdm`

**Source Files** (in `config/includes.chroot/etc/dconf/db/`):
- `local.d/00-aureon-extensions` - Enabled GNOME extensions
- `local.d/01-aureon-defaults` - All desktop settings (theme, fonts, favorites, etc.)
- `local.d/01-window-buttons` - Window button layout
- `local.d/10-arcmenu-branding` - ArcMenu logo override
- `gdm.d/00-aureon-login` - GDM login screen branding

**Compilation:** `9999-aureon-compile-dconf.hook.chroot` runs `dconf update` with temporary machine ID.

### 2. Plymouth (Boot Splash)
**Theme:** `aureon` (custom script-based theme)
**Files:** `config/includes.chroot/usr/share/plymouth/themes/aureon/`
**Configuration:** `/etc/plymouth/plymouthd.conf` → `Theme=aureon`
**Activation:** 
- Live: `99-set-plymouth-theme.hook.chroot` runs `plymouth-set-default-theme -R`
- Install: Calamares `plymouthcfg` module
**GRUB:** `quiet splash` in kernel cmdline (config/includes.binary/boot/grub/grub.cfg)

### 3. Calamares (Installer)
**Configuration:** `config/includes.chroot/etc/calamares/`
- `settings.conf` - Main configuration, module sequence
- `modules/*.conf` - Per-module settings
- `branding/aureon/` - AUREON branding (logo, welcome screen, styles)

**Module Sequence** (exec phase):
1. `partition` → `mount` → `unpackfs` (copies live squashfs to target)
2. `luksbootkeyfile` → `machineid` → `fstab`
3. `locale` → `keyboard` → `localecfg`
4. `users` → `displaymanager` → `networkcfg`
5. `hwclock` → `services-systemd`
6. `bootloader` → `grubcfg`
7. `plymouthcfg` → `initramfscfg` → `initramfs`
8. `shellprocess_cleanup` → `umount`

**Post-Install Cleanup:** `shellprocess_cleanup` runs `/usr/local/lib/calamares/remove-installer-launcher.sh` (dontChroot: true) to remove the "Install AUREON OS" launcher from the installed system.

### 4. GNOME Extensions
**Custom Extensions** (bundled in `includes.chroot/usr/share/gnome-shell/extensions/`):
- dash-to-panel@jderose9.github.com (v73)
- arcmenu@arcmenu.com (v73)
- date-menu-formatter@marcinjakubowski.github.com (v19)
- tiling-assistant@leleat-on-github (v54)
- just-perfection-desktop@just-perfection (v36)
- appindicatorsupport@rgcjonas.gmail.com (v64)
- clipboard-indicator@tudmotu.com (v71)
- quick-settings-tweaks@qwreey (v30)

**System Extension** (from package):
- user-theme@gnome-shell-extensions.gcampax.github.com (from `gnome-shell-extension-user-theme`)

**Enablement:** Via dconf `org.gnome.shell.enabled-extensions` in system database (local).

**Version Compatibility:** All extensions declare support for GNOME 48+. Version matching uses prefix matching ("48" matches "48.7").

### 5. User Configuration
**Skeleton** (`/etc/skel/`):
- `.bashrc`, `.zshrc` - Shell configuration with AUREON branding
- `.config/autostart/` - Disable evolution-data-server, gnome-software-service
- `.config/gtk-3.0/`, `.config/gtk-4.0/` - GTK settings
- `.config/tiling-assistant/` - Tiling Assistant layout config

**Live User:** Created by `live-config` at boot (`username=aureon` from boot params)

**Installed User:** Created by Calamares `users` module, gets skeleton copied.

---

## Key Design Decisions

1. **Single dconf Compilation:** Only one hook (`9999-aureon-compile-dconf`) compiles the database, running AFTER theme installation. Removed early compilation that produced incomplete database.

2. **Calamares Module Cleanup:** Removed references to non-existent modules (`dpkg-unsafe-io`, `sources-media`, `bootloader-config`). Simplified sequence to only use available modules.

3. **Plymouth in Initramfs:** Theme set during chroot hooks with `-R` flag to regenerate initramfs. Theme files copied via includes before hooks run.

4. **Extension Management:** Bundled extensions in includes.chroot (not packages) for version control. System extension (user-theme) via package.

5. **Branding Persistence:** Calamares `unpackfs` copies entire live filesystem, so all `/etc/dconf/`, `/usr/share/plymouth/`, `/etc/skel/` settings transfer to installed system.

6. **Hook Numbering:** Normal hooks (0000-9999) run before live hooks (0000-9999). Critical dependencies encoded in numbering.

---

## Live vs Installed System Configuration

| Component | Live System | Installed System |
|-----------|-------------|------------------|
| dconf databases | Compiled in chroot, in squashfs | Copied via unpackfs, work immediately |
| Plymouth theme | In initramfs (set by hook) | Set by Calamares plymouthcfg module |
| GNOME extensions | Enabled via system dconf | Same (copied filesystem) |
| User skeleton | Applied by live-config | Applied by Calamares users module |
| Machine ID | Temporary (build only) | Generated on first boot |
| Installer launcher | Present (`install-aureon.desktop`) | Removed by shellprocess_cleanup |

---

## Building

```bash
# Standard build
sudo ./build.sh

# Clean build
sudo ./build.sh --clean

# Custom version/arch
sudo ./build.sh --version 1.1 --arch amd64

# Dry run (show config only)
sudo ./build.sh --dry-run
```

**Requirements:** Root, live-build, debootstrap, xorriso, squashfs-tools, dosfstools, mtools, git, curl, grub packages.

---

## Troubleshooting

### dconf settings not applying
- Verify `dconf update` ran: check `/etc/dconf/db/local` exists and is recent
- Check profile: `/etc/dconf/profile/user` should reference `system-db:local`
- Ensure themes exist: `ls /usr/share/themes/Fluent-red-Dark`

### Plymouth not showing
- Check initramfs: `lsinitramfs /boot/initrd.img-* | grep plymouth`
- Verify GRUB cmdline has `quiet splash`
- Check `plymouth-set-default-theme -R` ran successfully

### Calamares modules failing
- Check module names match `/usr/lib/x86_64-linux-gnu/calamares/modules/`
- Verify all referenced modules have `.conf` files in `/etc/calamares/modules/`
- Check Calamares log: `~/.cache/calamares/session.log`

### Extensions not enabled
- Verify UUIDs in `00-aureon-extensions` match extension `metadata.json`
- Check GNOME Shell version compatibility
- Restart GNOME Shell (Alt+F2, r) or re-login

---

## Maintenance

### Adding a New Package
1. Add to `config/package-lists/aureon.list.chroot`
2. Rebuild

### Adding a GNOME Extension
1. Copy extension to `config/includes.chroot/usr/share/gnome-shell/extensions/<uuid>/`
2. Add UUID to `config/includes.chroot/etc/dconf/db/local.d/00-aureon-extensions`
3. Rebuild (dconf recompiles automatically)

### Changing Theme
1. Modify `9800-aureon-theme.hook.chroot` or replace theme files in includes
2. Update dconf references in `01-aureon-defaults` and `gdm.d/00-aureon-login`
3. Rebuild

### Updating Calamares Config
1. Modify files in `config/includes.chroot/etc/calamares/`
2. Rebuild

---

*Generated from AUREON OS repository inspection. Last updated: 2026-08-29*
