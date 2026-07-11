#!/usr/bin/env bash
#
# build-aureon.sh — Build a custom Debian (bookworm) live ISO with GNOME
# desktop and user-defined extensions via live-build (lb)
#
# Usage:
#   sudo ./build-aureon.sh
#
# Requires: live-build (lb), sudo privileges, internet access to mirrors
#
set -euo pipefail
IFS=$'\n\t'

# ------------------------------------------------------------------
# Configuration
# ------------------------------------------------------------------
DISTRIBUTION="${DISTRIBUTION:-bookworm}"
ARCHITECTURE="${ARCHITECTURE:-amd64}"
BUILD_DIR="${BUILD_DIR:-$(pwd)}"
OUTPUT_DIR="${OUTPUT_DIR:-$(pwd)/output}"
LOG_FILE="${LOG_FILE:-$BUILD_DIR/build-$(date +%Y%m%d-%H%M%S).log}"

EXTENSIONS_FILE="${EXTENSIONS_FILE:-$BUILD_DIR/my_extensions.txt}"
PACKAGE_LIST_DIR="$BUILD_DIR/config/package-lists"
PACKAGE_LIST_FILE="$PACKAGE_LIST_DIR/aureon.list.chroot"

# Hooks directory — scripts here run INSIDE the chroot during the
# build. This is the only correct place for apt-get commands; running
# apt-get directly in this host-side script would install packages on
# your build machine, not inside the ISO.
HOOKS_DIR="$BUILD_DIR/config/hooks/live"
EXTENSIONS_HOOK_FILE="$HOOKS_DIR/0010-install-extensions.hook.chroot"

# Where manually-downloaded extensions (no APT package available,
# e.g. clipboard-indicator) get injected into the live filesystem.
# live-build copies config/includes.chroot verbatim into the target
# system, so anything placed here ships on the ISO as-is.
CUSTOM_EXT_DIR="$BUILD_DIR/config/includes.chroot/usr/share/gnome-shell/extensions"

MIRROR_BOOTSTRAP="https://deb.debian.org/debian"
MIRROR_CHROOT="https://deb.debian.org/debian"
MIRROR_CHROOT_SECURITY="https://security.debian.org/debian-security"
MIRROR_BINARY="https://deb.debian.org/debian"
MIRROR_BINARY_SECURITY="https://security.debian.org/debian-security"

# Base desktop packages that must always be present, regardless of
# what's in my_extensions.txt
BASE_DESKTOP_PACKAGES=(
    task-gnome-desktop
    xorg
    gdm3
)
# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------
log()  { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG_FILE"; }
info() { log "[+] $*"; }
ok()   { log "[✓] $*"; }
err()  { log "[✗] $*" >&2; }

cleanup_on_error() {
    local exit_code=$?
    if [ $exit_code -ne 0 ]; then
        err "Build failed with exit code $exit_code. See $LOG_FILE for details."
    fi
    exit $exit_code
}
trap cleanup_on_error EXIT

require_root() {
    if [ "$(id -u)" -ne 0 ]; then
        err "This script must be run as root (use sudo)."
        exit 1
    fi
}

require_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        err "Required command '$1' not found. Install it (e.g. 'apt install live-build') and retry."
        exit 1
    fi
}

# ------------------------------------------------------------------
# Pre-flight checks
# ------------------------------------------------------------------
preflight() {
    info "Running pre-flight checks..."
    require_root
    require_cmd lb
    require_cmd mksquashfs

    if [ ! -f "$EXTENSIONS_FILE" ]; then
        err "Extensions file not found: $EXTENSIONS_FILE"
        err "Create it first, e.g.:"
        err "  echo 'gnome-shell-extension-dash-to-dock' > $EXTENSIONS_FILE"
        exit 1
    fi

    mkdir -p "$OUTPUT_DIR"
    touch "$LOG_FILE"
    ok "Pre-flight checks passed."
}

# ------------------------------------------------------------------
# Clean previous build artifacts
# SAFETY: config/ is intentionally NEVER deleted here, so your
# package lists, hooks, and includes persist across rebuilds.
# ------------------------------------------------------------------
clean_previous() {
    info "Cleaning previous build artifacts (config/ preserved)..."
    lb clean --purge >>"$LOG_FILE" 2>&1 || true
    # Deliberately NOT removing config/ — see script header safety note.
    ok "Clean complete. config/ left untouched."
}

# ------------------------------------------------------------------
# Configure the live-build environment
# ------------------------------------------------------------------
configure_build() {
    info "Configuring live-build (distribution=$DISTRIBUTION, arch=$ARCHITECTURE)..."
    lb config \
        --distribution "$DISTRIBUTION" \
        --architectures "$ARCHITECTURE" \
        --archive-areas "main contrib non-free non-free-firmware" \
        --mirror-bootstrap "$MIRROR_BOOTSTRAP" \
        --mirror-chroot "$MIRROR_CHROOT" \
        --mirror-chroot-security "$MIRROR_CHROOT_SECURITY" \
        --mirror-binary "$MIRROR_BINARY" \
        --mirror-binary-security "$MIRROR_BINARY_SECURITY" \
        >>"$LOG_FILE" 2>&1
    ok "Configuration complete."
}


# -----------------------------------------------------------------
# ------------------------------------------------------------------
# Prepare and validate the includes.chroot directory for manually
# downloaded extensions (no APT package available, e.g.
# clipboard-indicator).
#
# Usage: download the extension, then place the folder containing
# metadata.json into:
#   config/includes.chroot/usr/share/gnome-shell/extensions/<UUID>/
# live-build copies this directory tree verbatim into the ISO, so it
# is present at first boot, ready to be enabled.
# ------------------------------------------------------------------
prepare_custom_extensions() {
    info "Preparing custom (non-APT) extensions directory..."
    mkdir -p "$CUSTOM_EXT_DIR"

    local readme="$CUSTOM_EXT_DIR/README.txt"
    if [ ! -f "$readme" ]; then
        cat > "$readme" << 'README_EOF'
Place manually-downloaded GNOME Shell extensions here.

Each extension goes in its own folder named after its UUID, e.g.:
  clipboard-indicator@tudmotu.com/
    metadata.json
    extension.js
    ...

Only use this for extensions with NO Debian/APT package available.
If an APT package exists, add it to APT_EXTENSION_PACKAGES in
build-aureon.sh (or my_extensions.txt) instead - that's simpler and
gets security updates via apt.
README_EOF
    fi

    local dirs=()
    while IFS= read -r -d '' d; do
        dirs+=("$d")
    done < <(find "$CUSTOM_EXT_DIR" -mindepth 1 -maxdepth 1 -type d -print0)

    if [ "${#dirs[@]}" -eq 0 ]; then
        info "No manually-injected extensions found (skipping validation)."
        return 0
    fi

    info "Validating ${#dirs[@]} manually-injected extension folder(s)..."
    local bad=0
    for d in "${dirs[@]}"; do
        local name
        name="$(basename "$d")"
        if [[ ! "$name" == *@* ]]; then
            err "  '$name' does not look like a valid UUID (expected format: name@domain)."
            bad=1
        fi
        if [ ! -f "$d/metadata.json" ]; then
            err "  '$name' is missing metadata.json — GNOME Shell will not load it."
            bad=1
        else
            ok "  '$name' looks valid (metadata.json present)."
        fi
    done

    if [ "$bad" -ne 0 ]; then
        err "One or more custom extensions failed validation. Fix the folders above before building."
        exit 1
    fi
}

# ------------------------------------------------------------------
# Run the actual build
# ------------------------------------------------------------------
run_build() {
    info "Starting build (this may take a while)..."
    if ! lb build 2>&1 | tee -a "$LOG_FILE"; then
        err "lb build failed."
        exit 1
    fi
    ok "Build stage complete."
}

# ------------------------------------------------------------------
# Collect the resulting ISO
# ------------------------------------------------------------------
save_iso() {
    info "Saving ISO to $OUTPUT_DIR..."
    local found=0
    while IFS= read -r -d '' iso; do
        cp -v "$iso" "$OUTPUT_DIR/" | tee -a "$LOG_FILE"
        found=1
    done < <(find "$BUILD_DIR" -maxdepth 1 -name "*.iso" -print0)

    if [ "$found" -eq 0 ]; then
        err "No ISO file found after build — something went wrong."
        exit 1
    fi
    ok "ISO saved successfully."
}

# ------------------------------------------------------------------
# Checksums for release integrity
# ------------------------------------------------------------------
generate_checksums() {
    info "Generating checksums..."
    (
        cd "$OUTPUT_DIR"
        for iso in *.iso; do
            [ -e "$iso" ] || continue
            sha256sum "$iso" > "${iso}.sha256"
            ok "Checksum written: ${iso}.sha256"
        done
    )
}

# ------------------------------------------------------------------
# Main
# ------------------------------------------------------------------
main() {
    info "=== Aureon Live ISO Build Started ==="
    preflight
    clean_previous
    configure_build
    prepare_custom_extensions
    run_build
    save_iso
    generate_checksums
    ok "=== Build completed successfully. Output in: $OUTPUT_DIR ==="
}

main "$@"
