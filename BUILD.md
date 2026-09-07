# Building AUREON OS

This document explains how to build the AUREON OS ISO from source.

## System Requirements

Recommended build machine:

* Debian Testing (or newer)
* 8 GB RAM minimum (16 GB recommended)
* 50 GB free disk space minimum
* Multi-core CPU
* Stable internet connection

## Clone the Repository

```bash
git clone https://github.com/meherazhosensiam/AureonOS.git

cd AureonOS
```

## Configure

Review the live-build configuration before building.

If you need to change branding, packages, or installer settings, edit the files inside:

```
config/
```

## Build the ISO

The recommended way to build is using the provided build script:

```bash
sudo ./build.sh
```

### Build Script Options

```bash
sudo ./build.sh [OPTIONS]
```

| Option | Description |
|--------|-------------|
| `-a, --arch ARCH` | Target architecture (default: amd64). Supported: amd64, i386, arm64, armhf |
| `-v, --version VERSION` | Set the AureonOS version (default: 1.0) |
| `-n, --name NAME` | Set the project/ISO name (default: AureonOS) |
| `--iso-name NAME` | Set exact final ISO filename (e.g., `--iso-name AureonOS-Custom.iso`) |
| `--iso-volume NAME` | Set ISO volume label (default: AureonOS) |
| `--distribution NAME` | Debian distribution (default: trixie) |
| `--clean` | Clean previous build environment before building |
| `--force` | Force cleanup before building |
| `--no-deps` | Skip dependency checking |
| `--no-release-clean` | Skip release cleanup |
| `--skip-cleanup` | Do not perform post-build cleanup |
| `--keep-build` | Keep the generated build environment |
| `--non-interactive` | Disable interactive prompts (for CI/CD) |
| `--dry-run` | Show configuration without building |
| `--debug` | Enable Bash debugging |
| `-h, --help` | Show help message |

### Examples

```bash
# Standard amd64 build
sudo ./build.sh

# Build specific version
sudo ./build.sh --version 1.1

# Build for ARM64
sudo ./build.sh --arch arm64

# Build with custom ISO name
sudo ./build.sh --iso-name AureonOS-Testing.iso

# Clean build (removes previous build artifacts)
sudo ./build.sh --clean

# Fully automated build (CI/CD)
sudo ./build.sh --non-interactive --no-release-clean

# Preview configuration without building
sudo ./build.sh --dry-run
```

The build process may take 15-60 minutes depending on your hardware and internet speed.

## Output

After a successful build, the generated ISO will appear in the project directory.

Example:

```
AureonOS-1.0-amd64.iso
```

A SHA256 checksum file (`.sha256`) is also generated for verification.

## Testing

Before publishing a release, test the ISO in a virtual machine.

Recommended virtualization software:

* GNOME Boxes
* VirtualBox
* VMware Workstation
* QEMU/KVM

Verify:

* Live boot
* Calamares installer
* Network connectivity
* Audio
* Graphics
* User session
* Shutdown and reboot
* UEFI boot
* Legacy BIOS boot

## Project Structure

```
AureonOS/
├── auto/
├── config/
├── hooks/
├── includes/
├── package-lists/
├── README.md
├── BUILD.md
├── CONTRIBUTING.md
├── CHANGELOG.md
└── LICENSE
```

## Troubleshooting

### Build fails

First, try running the build again - transient network issues often resolve on retry:

```bash
sudo ./build.sh
```

### Package download failed (mirror issues)

If you see errors like "Couldn't download package" or "Couldn't download packages: libtinfo6", this is typically a temporary Debian mirror issue:

1. Wait a few minutes and retry
2. Or run with a different mirror by setting the mirror in `auto/config`

### Package not found

Update package lists:

```bash
sudo apt update
```

Verify that the package exists in the Debian repositories used by the project.

### Boot problems

Check:

* BIOS vs UEFI configuration
* GRUB configuration
* Syslinux configuration
* Secure Boot compatibility

### Common Error Codes

| Error | Cause | Solution |
|-------|-------|----------|
| `lb build` exit code 1 | Various | Check the log file in `logs/` for details |
| "Couldn't download package" | Mirror sync issue | Retry build, or wait for mirror sync |
| "No space left on device" | Insufficient disk space | Ensure 50GB+ free space |
| "Permission denied" | Not running as root | Use `sudo ./build.sh` |

## Reporting Build Issues

When reporting build problems, include:

* Debian version
* Kernel version
* `live-build` version
* Complete terminal output
* Relevant log files

## License

AUREON OS is distributed under the project's license. See the `LICENSE` file for details.
