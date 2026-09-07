# AUREON OS - Calamares Installer Documentation

## Overview

AUREON OS uses Calamares 3.3.14 (Debian package) as its graphical installer. The installer runs in the live environment and copies the live filesystem to the target disk.

---

## Configuration Structure

```
config/includes.chroot/etc/calamares/
├── settings.conf              # Main configuration
├── modules/                   # Module configurations
│   ├── welcome.conf           # Welcome screen
│   ├── locale.conf            # (uses system default)
│   ├── keyboard.conf          # (uses system default)
│   ├── partition.conf         # (uses system default)
│   ├── users.conf             # User account setup
│   ├── displaymanager.conf    # GDM configuration
│   ├── networkcfg.conf        # (uses system default)
│   ├── unpackfs.conf          # Filesystem copy config
│   ├── machineid.conf         # Machine ID generation
│   ├── fstab.conf             # (uses system default)
│   ├── localecfg.conf         # (uses system default)
│   ├── hwclock.conf           # (uses system default)
│   ├── services-systemd.conf  # (uses system default)
│   ├── bootloader.conf        # GRUB configuration
│   ├── grubcfg.conf           # (uses system default)
│   ├── plymouthcfg.conf       # Plymouth theme on target
│   ├── initramfscfg.conf      # Initramfs regeneration
│   ├── initramfs.conf         # (uses system default)
│   ├── shellprocess_cleanup.conf  # Post-install cleanup
│   └── finished.conf          # Completion screen
└── branding/
    └── aureon/                # AUREON branding
        ├── branding.desc      # Branding metadata
        ├── welcome.png        # Welcome screen background
        ├── logo.png           # Logo
        ├── applications.png   # Applications icon
        ├── desktop.png        # Desktop icon
        ├── show.qml           # Slideshow
        └── stylesheet.qss     # Styles
```

---

## Module Sequence (settings.conf)

### Phase 1: Show (UI Pages)
```
welcome → locale → keyboard → partition → users → summary
```

### Phase 2: Exec (Installation Jobs)
```
partition → mount → unpackfs → luksbootkeyfile → machineid → fstab 
  → locale → keyboard → localecfg → users → displaymanager → networkcfg 
  → hwclock → services-systemd → bootloader → grubcfg 
  → plymouthcfg → initramfscfg → initramfs 
  → shellprocess_cleanup → umount
```

### Phase 3: Show (Post-Install)
```
finished
```

---

## Key Module Details

### unpackfs
**Configuration:** `unpackfs.conf`
```yaml
unpack:
  - source: "/run/live/medium/live/filesystem.squashfs"
    sourcefs: "squashfs"
    destination: ""
```
Copies the entire live filesystem to the target. This is how ALL customizations (dconf, themes, extensions, skel, etc.) reach the installed system.

### displaymanager
**Configuration:** `displaymanager.conf`
```yaml
displaymanagers:
  - gdm
basicSetup: false
sysconfigSetup: false
```
Only GDM is listed (only DM installed). Enables `gdm.service`.

### users
**Configuration:** `users.conf`
```yaml
userGroup: users
defaultGroups: [cdrom, floppy, sudo, audio, dip, video, plugdev, netdev, lpadmin, scanner, bluetooth]
autologinGroup: autologin
sudoersGroup: sudo
setRootPassword: false
defaultShell: /bin/zsh
```
Creates user with Zsh as default shell (matches live system).

### bootloader / grubcfg
**Configuration:** `bootloader.conf`
```yaml
efiBootLoader: "grub"
grubInstall: "grub-install"
grubMkconfig: "grub-mkconfig"
grubCfg: "/boot/grub/grub.cfg"
grubProbe: "grub-probe"
efiBootMgr: "efibootmgr"
installEFIFallback: true
```
Installs GRUB for both BIOS and UEFI. Uses branding for bootloader entry name.

### plymouthcfg
**Configuration:** `plymouthcfg.conf`
```yaml
plymouth_theme: "aureon"
```
Sets the AUREON Plymouth theme on the target system. Runs `plymouth-set-default-theme` in target chroot.

### initramfscfg / initramfs
Regenerates initramfs on target to include hardware-specific modules and Plymouth theme.

### shellprocess_cleanup
**Configuration:** `shellprocess_cleanup.conf`
```yaml
dontChroot: true
timeout: 120
script:
  - "/usr/local/lib/calamares/remove-installer-launcher.sh"
```
Runs in LIVE environment (not chroot) while `/target` is mounted. Removes the "Install AUREON OS" launcher from the installed system.

**Script:** `/usr/local/lib/calamares/remove-installer-launcher.sh`
- Removes `/target/usr/share/applications/install-aureon.desktop`
- Removes `/target/etc/skel/Desktop/install-aureon.desktop`
- Removes any user Desktop copies

### finished
**Configuration:** `finished.conf`
```yaml
restartNowEnabled: true
restartNowChecked: true
restartNowCommand: "systemctl -i reboot"
```
Shows restart button, checked by default.

---

## Branding

**Directory:** `/etc/calamares/branding/aureon/`

**branding.desc:**
```yaml
componentName: aureon
welcomeStyleCalamares: true
welcomeExpandingLogo: true
windowSize: 800px,580px
windowPlacement: center
strings:
  productName: AUREON OS
  version: 1.0
  bootloaderEntryName: AUREON OS
images:
  productLogo: "logo.png"
  productWelcome: "welcome.png"
slideshow: "show.qml"
style:
  SidebarBackground: "#000000"
  SidebarText: "#FFFFFF"
  SidebarBackgroundCurrent: "#d22913"
```

---

## Welcome Module

**Configuration:** `welcome.conf`
```yaml
showSupportUrl: false
showKnownIssuesUrl: false
showReleaseNotesUrl: false
requirements:
  requiredStorage: 15  # GB
  requiredRam: 1.0     # GB
  check: [storage, ram, power, root]
  required: [storage, ram, root]
```

---

## Network Configuration

Uses default `networkcfg` module which copies NetworkManager connections from live system to target.

---

## Partition Module

Uses default `partition` module with Calamares' built-in partitioning UI. Supports:
- Manual partitioning
- Auto-partitioning (replace disk)
- LUKS encryption
- LVM

---

## Services

Uses default `services-systemd` module. Enables services based on package installation (GDM, NetworkManager, etc.).

---

## Post-Install Behavior

1. Calamares runs `shellprocess_cleanup` (removes installer launcher)
2. Runs `umount` (unmounts target filesystems)
3. Shows `finished` screen with restart button
4. User reboots into installed system

---

## Troubleshooting

### Module Not Found Errors
Check `/usr/lib/x86_64-linux-gnu/calamares/modules/` for available modules. Only reference modules that exist.

### Installer Won't Launch
- Check `install-aureon.desktop` exists and is executable
- Verify `pkexec` and `polkit` are working
- Check Calamares log: `~/.cache/calamares/session.log`

### GRUB Not Installing
- Check `bootloader.conf` and `grubcfg.conf`
- Verify EFI partition exists for UEFI installs
- Check target disk partitioning

### Plymouth Theme Not Applied
- Verify `plymouthcfg.conf` has correct theme name
- Check theme exists in target at `/usr/share/plymouth/themes/aureon/`
- Check `initramfs` module runs after `plymouthcfg`

### User Settings Not Applied
- Verify `users.conf` has correct groups
- Check `defaultShell: /bin/zsh` (Zsh must be installed)
- Check `/etc/skel` copied correctly

---

## Customization

### Adding a Module
1. Create `.conf` in `config/includes.chroot/etc/calamares/modules/`
2. Add module name to `settings.conf` sequence
3. Rebuild

### Changing Branding
1. Replace images in `config/includes.chroot/etc/calamares/branding/aureon/`
2. Update `branding.desc` if needed
3. Rebuild

### Modifying Requirements
1. Edit `welcome.conf` `requiredStorage`/`requiredRam`
2. Rebuild

---

## Logs

- Live session: `~/.cache/calamares/session.log`
- Target system (after install): `/var/log/calamares.log`

---

*Last updated: 2026-08-29*
