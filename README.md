# AUREON OS

> **A modern, Debian-based Linux distribution built for productivity, customization, security, and developers.**

[![Pre-release](https://img.shields.io/badge/Release-Pre--Release-orange)](https://github.com/meherazhosensiam/AureonOS/releases)
![License](https://img.shields.io/badge/License-GPLv3-green.svg)
![Platform](https://img.shields.io/badge/Platform-Linux-success)
![Base](https://img.shields.io/badge/Base-Debian-red)
![GNOME](https://img.shields.io/badge/Desktop-GNOME-4A86CF?logo=gnome\&logoColor=white)
![Calamares](https://img.shields.io/badge/Installer-Calamares-00AEEF)
![Architecture](https://img.shields.io/badge/Architecture-x86__64-blue)
![ISO](https://img.shields.io/badge/Image-ISO-orange)
![Live Build](https://img.shields.io/badge/Built%20With-Live%20Build-red)
![Open Source](https://img.shields.io/badge/Open%20Source-Yes-brightgreen?logo=opensourceinitiative\&logoColor=white)
![Status](https://img.shields.io/badge/Status-Active%20Development-orange)

---

<p align="center">
  <img src="config/includes.chroot/usr/share/aureonos/assets/logo.png" alt="AUREON OS Logo" width="180">
</p>

<h1 align="center">AUREON OS</h1>

<p align="center">
A Debian-based Linux distribution with a modern GNOME desktop.
</p>

---

## Screenshots

### Desktop

![Desktop](desktop.png)

### Application Menu

![Application Menu](applications.png)

---

## About

AUREON OS is a Debian-based Linux distribution built with **live-build**, featuring the **GNOME desktop environment** and the **Calamares installer**.

The project focuses on providing a modern, customizable Linux desktop while maintaining a strong foundation in open-source software and Linux technologies.

AUREON OS is being developed with use cases including:

* Cybersecurity and penetration testing
* Software development
* Linux learning and experimentation
* Productivity
* Desktop customization
* General-purpose daily computing

The project is independently developed and is still undergoing active testing and refinement.

---

## Current Status

**Project Stage:** Pre-release / Active Development

The first AUREON OS ISO has been successfully built and is currently being tested.

However, **AUREON OS is not ready for public release yet**.

The current development ISO contains several known issues that are being investigated and fixed before the first stable public release. Installation, desktop configuration, theming, system integration, and other components are still undergoing validation.

### Current Development State

* 🟢 Development ISO successfully builds
* 🟢 Live environment is available for testing
* 🟡 Installation and post-installation behavior are being tested
* 🟡 Desktop configuration and customization are being refined
* 🟡 Known bugs are being investigated and fixed
* 🔴 No stable public release yet

**The current ISO should be considered a development/testing build and not a production release.**

Release builds will be published once the major known issues have been resolved and the ISO has passed the project's validation process.

---

## Features

* Debian-based Linux system
* GNOME desktop environment
* Calamares graphical installer
* Custom AUREON OS branding
* Custom wallpapers and themes
* Customized GNOME desktop configuration
* Live-build based image generation
* x86_64 support
* Open-source development
* Modular project structure
* Custom system configuration
* Designed for both experimentation and everyday Linux use

---

## Repository Contents

```text
AureonOS/
├── config/
├── hooks/
├── includes/
├── package-lists/
├── assets/
├── scripts/
├── build.sh
├── README.md
└── LICENSE
```

The repository structure may change as development continues.

---

## Building

AUREON OS is built using Debian's **live-build** infrastructure.

The build system contains the configuration, packages, hooks, branding, themes, desktop settings, and other components required to generate the ISO.

Build instructions will continue to be improved as the project approaches its first public release.

> **Note:** Building AUREON OS from the development branch may produce an experimental image containing unresolved issues.

---

## Development and Testing

AUREON OS follows an iterative development process:

```text
Development
     ↓
Build ISO
     ↓
Boot Live Environment
     ↓
Test System
     ↓
Identify Bugs
     ↓
Root Cause Analysis
     ↓
Implement Fix
     ↓
Rebuild ISO
     ↓
Validate Again
     ↓
Release Candidate
     ↓
Public Release
```

Known issues and implementation investigations may be documented in the repository as development progresses.

---

## Roadmap

### Core System

* [x] Build the first bootable development ISO
* [x] Establish Debian/live-build foundation
* [x] Integrate GNOME desktop
* [x] Integrate Calamares
* [x] Implement AUREON OS branding
* [ ] Resolve remaining installation issues
* [ ] Improve post-installation reliability
* [ ] Validate system configuration on fresh installations

### Desktop Experience

* [x] Custom wallpapers
* [x] Custom themes
* [x] Custom branding
* [ ] Complete desktop customization
* [ ] Resolve remaining appearance/configuration issues
* [ ] Improve low-end hardware experience
* [ ] Test on physical hardware

### Installer

* [x] Calamares integration
* [x] Custom installer branding
* [x] Installer launcher integration
* [ ] Complete installation testing
* [ ] Validate bootloader installation
* [ ] Validate post-install cleanup
* [ ] Test installation across different hardware configurations

### Stability and Release

* [ ] Resolve known critical bugs
* [ ] Complete regression testing
* [ ] Test fresh installations
* [ ] Test live environment
* [ ] Test installed system
* [ ] Test on physical hardware
* [ ] Prepare release candidate
* [ ] Publish first public release

---

## Known Development Issues

The current development ISO is **not considered release-ready**.

Several issues remain under investigation, including potential problems involving:

* Installation and bootloader configuration
* Desktop configuration persistence
* GNOME appearance settings
* Theme and icon integration
* Installer integration
* Live-session behavior
* Post-installation cleanup
* Hardware-specific behavior

These issues are being tracked and resolved during development.

**Do not treat the current development ISO as a stable operating system.**

---

## Open Source Projects Used

AUREON OS builds upon the work of many open-source projects and communities, including:

* [Debian](https://www.debian.org/)
* [Linux Kernel](https://www.kernel.org/)
* [GNOME](https://www.gnome.org/)
* GNU Project
* [systemd](https://systemd.io/)
* [Calamares](https://calamares.io/)
* [live-build](https://live-team.pages.debian.net/live-manual/)
* GRUB
* Plymouth
* GTK
* Mesa
* NetworkManager

Each project is developed and maintained by its respective community and contributors.

AUREON OS does not replace the licenses or ownership of these upstream projects.

---

## Contributing

AUREON OS is an open-source project and contributions are welcome.

You can contribute by:

* Reporting bugs
* Testing development ISOs
* Investigating technical issues
* Improving documentation
* Suggesting features
* Improving the build system
* Submitting patches or pull requests
* Testing AUREON OS on different hardware

When reporting a bug, please provide as much useful information as possible, including:

* Hardware specifications
* AUREON OS build/version
* Steps to reproduce the issue
* Expected behavior
* Actual behavior
* Relevant logs or error messages

---

## License

AUREON OS is licensed under the **GNU General Public License v3.0 (GPL-3.0)**.

The source code, build scripts, configuration files, and original project files in this repository are distributed under the terms of the GNU GPL v3.0.

Third-party software included in or used to build AUREON OS, including Debian, the Linux kernel, GNOME, GNU utilities, Calamares, and other open-source components, remains subject to its respective licenses.

Those licenses are not replaced or modified by the AUREON OS project.

See the [LICENSE](LICENSE) file for the complete license text.

---

## Acknowledgements

AUREON OS would not be possible without the work of the Debian Project, GNOME Project, Linux community, and the wider free and open-source software ecosystem.

AUREON OS builds upon these projects while developing its own configuration, design, tooling, and system integration.

Thank you to everyone who contributes to the open-source ecosystem.
