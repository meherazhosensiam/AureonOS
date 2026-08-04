#!/bin/sh

set -e

echo "========================================"
echo "        AureonOS Build System"
echo "========================================"
set -e

PACKAGES=(
    live-build
    debootstrap
    xorriso
    squashfs-tools
    dosfstools
    grub-pc-bin
    grub-efi-amd64-bin
    mtools
    git
    curl
)

echo "Checking build dependencies..."

sudo apt update

for pkg in "${PACKAGES[@]}"; do
    if ! dpkg -s "$pkg" >/dev/null 2>&1; then
        echo "Installing $pkg..."
        sudo apt install -y "$pkg"
    fi
done

echo "All dependencies are installed."

echo "[1/3] Cleaning project..."
./auto/clean

echo "[2/3] Configuring live-build..."
./auto/config

echo "[3/3] Building AureonOS..."
sudo lb build

echo
echo "========================================"
echo " Build completed successfully."
echo "========================================"
read -rp "Do you want to clean the repository for GitHub? (y/N): " CLEAN

if [[ "$CLEAN" =~ ^[Yy]$ ]]; then
    ./release-clean.sh
fi
