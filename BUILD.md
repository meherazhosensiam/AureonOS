# Building AUREON OS

This document explains how to build the AUREON OS ISO from source.
> **Note:** I am suggesting you do all the work as a root user So you don't have to face any permission issue and you don't have to type sudo every time
## System Requirements

Recommended build machine:

* Debian Testing (or newer)
* 8 GB RAM minimum (16 GB recommended)
* 50 GB free disk space minimum
* Multi-core CPU
* Stable internet connection

## Required Packages

Install the required packages:

```bash
sudo apt update
sudo apt install live-build debootstrap squashfs-tools xorriso grub-pc-bin grub-efi-amd64-bin mtools dosfstools rsync git wget curl ca-certificates
```

Additional packages may be required depending on future project updates.

## Clone the Repository

```bash
git clone https://github.com/meherazhosensiam/AureonOS.git
cd AureonOS
```
## After cloning the Repository
clean the build environment first to ensure any broken file and configuration are not there

```bash
sudo lb clean --all
```
Then rebuild the configuration structure

```bash
sudo lb config
```

## Configure

Review the live-build configuration before building.

If you need to change branding, packages, or installer settings, edit the files inside:

```
config/
```

## Generating ISO Images for Different Architectures

AUREON OS can be built for multiple CPU architectures by changing the
`--architectures` option during the `lb config` step.

### AMD64 (64-bit Intel/AMD)

```bash
lb config --architectures amd64
sudo lb build
```

### ARM64 (AArch64)

```bash
lb config --architectures arm64
sudo lb build
```

### ARMHF (32-bit ARM)

```bash
lb config --architectures armhf
sudo lb build
```

> **Note:** Building for a different architecture may require using an appropriate build environment, cross-compilation tools, or native hardware depending on the target architecture.

## Build the ISO

Run the build script:

```bash
sudo lb build
```


The build process may take some time depending on your hardware and internet speed.

## Output

After a successful build, the generated ISO will appear in the project directory.

Example:

```
live-image-amd64.hybrid.iso
```

## Cleaning the Build

To remove previous build files:

```bash
sudo lb clean
```

To completely reset the build environment:

```bash
sudo lb clean --purge
```

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

Run:

```bash
sudo lb clean --purge
sudo lb build
```

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

## Reporting Build Issues

When reporting build problems, include:

* Debian version
* Kernel version
* `live-build` version
* Complete terminal output
* Relevant log files

## License

AUREON OS is distributed under the project's license. See the `LICENSE` file for details.
