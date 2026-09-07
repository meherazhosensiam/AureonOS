# AUREON OS - Build Pipeline Documentation

## Overview

This document describes the complete build process for AUREON OS using live-build.

---

## Prerequisites

### Build Host Requirements
- Debian-based system (Debian 12+, Ubuntu 22.04+)
- Root access (sudo)
- ~20 GB free disk space
- Internet access for package downloads

### Required Packages
```bash
apt-get install live-build debootstrap xorriso squashfs-tools dosfstools mtools git curl
# For amd64:
apt-get install grub-pc-bin grub-efi-amd64-bin
```

---

## Build Script (build.sh)

The `build.sh` script is a wrapper around live-build with additional features:

### Features
- Architecture selection (amd64, armhf, i386)
- Version management
- Dependency checking and installation
- Clean build options
- ISO naming and verification
- SHA256 checksum generation
- Release cleanup integration
- Colored logging with timestamps

### Usage
```bash
# Standard build
sudo ./build.sh

# Clean build
sudo ./build.sh --clean

# Custom version
sudo ./build.sh --version 1.1

# Custom architecture
sudo ./build.sh --arch amd64

# Dry run (show config only)
sudo ./build.sh --dry-run

# Skip dependency check
sudo ./build.sh --no-deps

# Keep build artifacts
sudo ./build.sh --keep-build

# Non-interactive (for CI)
sudo ./build.sh --non-interactive --clean
```

### Build Script Flow
1. **Argument Parsing** - Process command line options
2. **Root Check** - Verify running as root
3. **Architecture Validation** - Set kernel package per arch
4. **Dependency Check** - Install missing build dependencies
5. **Clean (if requested)** - Run `lb clean --purge`
6. **Live-build Config** - Run `ARCH=xxx ./auto/config`
7. **Build** - Run `lb build`
8. **ISO Finalize** - Rename ISO to `AureonOS-<version>-<arch>.iso`
9. **Verify** - Check ISO exists, generate SHA256
10. **Release Cleanup (optional)** - Run `release-clean.sh`

---

## Live-build Configuration (auto/config)

The `auto/config` script is the **single source of truth** for live-build configuration.

### Key Settings
```bash
# Distribution
LB_DISTRIBUTION="trixie"
LB_ARCHITECTURES="amd64"

# Archive areas
LB_ARCHIVE_AREAS="main contrib non-free-firmware non-free"

# Image type
LB_IMAGE_TYPE="iso-hybrid"

# Boot parameters
LB_BOOTAPPEND_LIVE="boot=live components username=aureon user-fullname='AureonOS Live User' hostname=aureonos"

# Bootloaders
LB_BOOTLOADER_BIOS="syslinux"
LB_BOOTLOADER_EFI="grub-efi"

# Kernel
LB_LINUX_PACKAGES="linux-image"
LB_LINUX_FLAVOURS="amd64"

# ISO metadata
LB_ISO_APPLICATION="AUREON OS"
LB_ISO_PUBLISHER="AUREON OS; https://aureon-os.local"
LB_ISO_VOLUME="AureonOS"

# Installer
LB_DEBIAN_INSTALLER="none"  # Calamares only
```

### Why No Debian Installer?
AUREON OS uses Calamares exclusively. Including Debian Installer would:
- Add a second, unbranded install path
- Bypass all AUREON customizations
- Increase ISO size unnecessarily

---

## Build Stages Detail

### Stage 1: lb bootstrap
- Creates minimal Debian chroot via debootstrap
- Downloads base packages from mirror
- Caches bootstrap for incremental builds

### Stage 2: lb chroot (Main Customization)

#### 2a. Package Installation
```
apt-get update
apt-get install -y <packages from package-lists/*.list.chroot>
```

#### 2b. Includes Copying (Order Matters)
1. `includes.chroot_before_packages/` → chroot (rarely used)
2. `includes.chroot/` → chroot (MAIN - most files)
3. `includes.chroot_after_packages/` → chroot (post-package tweaks)

#### 2c. Hook Execution (CRITICAL ORDER)

**Normal Hooks** (config/hooks/normal/) - Run first:
```
0000-9999: Various system cleanup and configuration
99: set-plymouth-theme.hook.chroot  ← Sets Plymouth + regenerates initramfs
...
9999: remove-gnome-wallpapers.chroot
```

**Live Hooks** (config/hooks/live/) - Run after normal:
```
0000-9999: Live-specific customization
9800: aureon-theme.hook.chroot      ← Installs Fluent GTK/Icon/Cursor themes
...
9999: aureon-compile-dconf.hook.chroot  ← Compiles dconf database (LAST)
```

**Critical Dependency:**
- Plymouth hook (normal/99) runs BEFORE theme hook (live/9800) - OK, independent
- Theme hook (live/9800) installs themes REQUIRED by dconf
- dconf hook (live/9999) runs LAST - ensures themes exist when compiling

### Stage 3: lb binary

#### 3a. Root Filesystem
- Creates squashfs from chroot: `filesystem.squashfs`
- Compression: default (gzip)

#### 3b. Kernel/Initramfs
- Copies `/boot/vmlinuz-*` and `/boot/initrd.img-*` to `binary/live/`
- These are the LIVE boot kernel/initramfs

#### 3c. Bootloader Installation
- **BIOS:** syslinux → `binary/boot/syslinux/`
- **UEFI:** grub-efi → `binary/EFI/boot/`
- GRUB config from `config/includes.binary/boot/grub/grub.cfg`

#### 3d. Binary Includes
- Copies `config/includes.binary/` to binary root
- Mainly: `boot/grub/grub.cfg`

#### 3e. ISO Creation
- Uses xorriso to create hybrid ISO
- Supports both BIOS and UEFI boot

---

## Package Lists

### aureon.list.chroot (Main)
- GNOME Desktop (gnome-core, gnome-shell, etc.)
- Display Manager (gdm3)
- Networking (network-manager, network-manager-gnome)
- Audio (pipewire, wireplumber, pavucontrol)
- Filesystem (gvfs, udisks2)
- Fonts (Inter, JetBrains Mono, Noto, etc.)
- Browser (firefox-esr)
- Customization (gnome-tweaks, gnome-shell-extension-user-theme, dconf-cli, dconf-editor)
- Boot Splash (plymouth, plymouth-themes)
- Security (polkitd, dbus-user-session, usbguard)
- Installer (calamares, calamares-settings-debian)
- Flatpak (flatpak, gnome-software, gnome-software-plugin-flatpak)
- Virtualization (open-vm-tools, qemu-guest-agent, spice-vdagent)

### live.list.chroot (Live System)
- live-boot
- live-config
- live-config-systemd
- systemd-sysv

---

## Output Artifacts

```
AureonOS/
├── AureonOS-<version>-<arch>.iso          # Final ISO
├── AureonOS-<version>-<arch>.iso.sha256   # Checksum
├── live-image-amd64.contents              # File list
├── live-image-amd64.files                 # File manifest
├── live-image-amd64.packages              # Package list
├── logs/build-<timestamp>.log             # Build log
├── chroot/                                # Chroot workspace (if --keep-build)
├── binary/                                # Binary workspace (if --keep-build)
├── cache/                                 # Package cache
└── .build/                                # Live-build state
```

---

## Incremental Builds

Live-build caches stages automatically:
- `bootstrap` - Cached by default (LB_CACHE_STAGES="bootstrap")
- `chroot` - Not cached by default (re-run on config change)
- `binary` - Not cached

**To force clean rebuild:**
```bash
sudo ./build.sh --clean --force
# Or manually:
lb clean --purge
```

---

## Troubleshooting Build Failures

### Package Installation Fails
- Check mirror connectivity
- Verify package names in package-lists
- Check for version conflicts

### Hook Failures
- Check build log for specific hook error
- Hooks run with `set -e`, any failure stops build
- Test hook manually: `chroot /path/to/chroot /bin/bash /path/to/hook`

### dconf Compilation Fails
- Ensure machine-id handling in 9999-aureon-compile-dconf
- Check theme files exist before compilation
- Verify dconf source file syntax

### Plymouth Theme Missing
- Check 99-set-plymouth-theme hook ran successfully
- Verify theme files in includes.chroot/usr/share/plymouth/themes/aureon/
- Check initramfs regeneration worked

### ISO Too Large
- Check 9800-aureon-theme cleanup (removes git dirs)
- Verify 9700-install-custom-packages doesn't leave debs
- Check for unnecessary packages in package-lists

### Calamares Module Errors
- Verify all referenced modules exist in `/usr/lib/x86_64-linux-gnu/calamares/modules/`
- Check module .conf files in config/includes.chroot/etc/calamares/modules/
- Test with `calamares -d` in live system

---

## CI/CD Integration

The build script supports non-interactive mode for automation:

```yaml
# Example GitHub Actions step
- name: Build AUREON OS
  run: |
    sudo ./build.sh --non-interactive --clean --version ${{ github.ref_name }} --arch amd64
```

---

## Performance Tips

1. **Keep cache** - Don't use `--clean` unless necessary
2. **Local mirror** - Use local Debian mirror for faster downloads
3. **Parallel builds** - live-build doesn't parallelize, but multiple architectures can build simultaneously
4. **RAM disk** - Build on tmpfs for speed (if enough RAM)

---

*Last updated: 2026-08-29*
