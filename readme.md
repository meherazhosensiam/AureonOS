
# AUREON OS

> **A modern, Debian-based Linux distribution built for productivity, customization, security, and developers.**

![License](https://img.shields.io/badge/License-MIT-blue.svg)
![Platform](https://img.shields.io/badge/Platform-Linux-success)
![Base](https://img.shields.io/badge/Base-Debian-red)
![Status](https://img.shields.io/badge/Status-Active%20Development-orange)

---

## Overview

**AUREON OS** is a custom Linux distribution built on **Debian Stable** using **live-build**. It delivers a clean, modern desktop experience while remaining stable, lightweight, and highly customizable.

The project aims to provide an elegant operating system with carefully selected software, polished visual design, and a reproducible build system that allows anyone to generate the same ISO from source.

---

## Features

* Debian Stable foundation
* GNOME desktop environment
* Modern AUREON branding
* Custom wallpapers and themes
* Customized GRUB and Plymouth boot experience
* Zsh-powered terminal environment
* Developer-friendly toolset
* Reproducible ISO builds using Debian Live Build
* Modular project structure
* Open-source development

---

## Screenshots

> Screenshots will be added soon.

---

## Project Structure

```text
AureonOS/
├── auto/
├── config/
│   ├── includes.chroot/
│   ├── package-lists/
│   ├── hooks/
│   ├── archives/
│   └── ...
├── scripts/
├── assets/
├── docs/
├── build.sh
├── clean.sh
└── README.md
```

---

## Requirements

* Debian 13 (Recommended)
* Debian Live Build
* Git
* Root or sudo privileges
* At least 25 GB of free disk space
* Internet connection for package downloads

---

## Installation

Clone the repository:

```bash
git clone https://github.com/meherazhosensiam/AureonOS.git
cd AureonOS
```

Install the required dependencies:

```bash
sudo apt update
sudo apt install live-build debootstrap git
```

---

## Building the ISO

Configure the build environment:

```bash
lb config
```

Build the ISO:

```bash
sudo lb build
```

After the build completes, the generated ISO will be available in the project directory.

---

## Cleaning the Build

To remove previous build artifacts:

```bash
sudo lb clean
```

---

## Customization

AUREON OS is designed to be easy to customize.

You can modify:

* Installed packages
* Desktop themes
* Icons
* Wallpapers
* GNOME extensions
* Plymouth splash screen
* GRUB theme
* System branding
* Default applications
* Configuration files

Most customizations can be found under:

```text
config/
```

---

## Roadmap

* [ ] Stable ISO release
* [ ] Automated build script
* [ ] GitHub Actions CI/CD
* [ ] Custom installer improvements
* [ ] Enhanced branding
* [ ] AUREON Wallpapers Pack
* [ ] Documentation website
* [ ] Release management
* [ ] Automatic update infrastructure

---

## Contributing

Contributions are welcome.

If you would like to improve AUREON OS:

1. Fork the repository
2. Create a new branch

```bash
git checkout -b feature/my-feature
```

3. Commit your changes

```bash
git commit -m "Add new feature"
```

4. Push the branch

```bash
git push origin feature/my-feature
```

5. Open a Pull Request

Please ensure your changes follow the project's coding style and are tested before submission.

---

## Issues

Found a bug or have a feature request?

Please open an Issue describing:

* Operating system
* Build logs
* Steps to reproduce
* Expected behavior
* Actual behavior

---

## License

This project is licensed under the **MIT License**.

See the `LICENSE` file for details.

---

## Author

**Meheraz Hosen Siam**

GitHub:
https://github.com/meherazhosensiam

---

## Acknowledgements

AUREON OS is built using:

* Debian
* Debian Live Build
* GNOME
* Linux Kernel
* Open Source Community

A sincere thank you to everyone who contributes to the Linux ecosystem.

---

# Star the Project

If you find AUREON OS interesting or useful, consider giving the repository a ⭐ on GitHub.

Your support helps the project grow and reach more users.
