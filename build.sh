#!/usr/bin/env bash
# ==============================================================================
# AureonOS Automated Single-File Build System (Debian Trixie Target)
# Purpose: Compiles a production-grade AureonOS Debian-based ISO image.
# Usage  : sudo ./build.sh
# ==============================================================================

# Strict Execution Mode
set -euo pipefail
IFS=$'\n\t'

# ------------------------------------------------------------------------------
# GLOBAL METADATA & CONFIGURATION
# ------------------------------------------------------------------------------
readonly OS_NAME="AureonOS"
readonly OS_VERSION="1.0"
readonly OS_CODENAME="trixie-based"
readonly DEBIAN_SUITE="trixie"  # Updated to Debian Trixie (Debian 13)
readonly TARGET_ARCH="amd64"
readonly ISO_NAME="${OS_NAME}-${OS_VERSION}-${TARGET_ARCH}.iso"

readonly MIN_RAM_GB=4
readonly MIN_DISK_GB=15
readonly REQUIRED_BASH_VER=4

readonly ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly CONFIG_DIR="${ROOT_DIR}/config"
readonly OUTPUT_DIR="${ROOT_DIR}/output"
readonly LOGS_DIR="${ROOT_DIR}/logs"
readonly CACHE_DIR="${ROOT_DIR}/cache"

readonly TIMESTAMP="$(date +'%Y-%m-%d_%H-%M-%S')"
readonly LOG_FILE="${LOGS_DIR}/build-${TIMESTAMP}.log"

# UI Colors (ANSI)
if [[ -t 1 ]]; then
    readonly C_RESET='\033[0m'
    readonly C_BOLD='\033[1m'
    readonly C_RED='\033[0;31m'
    readonly C_GREEN='\033[0;32m'
    readonly C_YELLOW='\033[0;33m'
    readonly C_BLUE='\033[0;34m'
    readonly C_CYAN='\033[0;36m'
else
    readonly C_RESET='' C_BOLD='' C_RED='' C_GREEN='' C_YELLOW='' C_BLUE='' C_CYAN=''
fi

# Ensure basic paths
mkdir -p "${LOGS_DIR}" "${OUTPUT_DIR}" "${CACHE_DIR}"

# ------------------------------------------------------------------------------
# LOGGING ENGINE
# ------------------------------------------------------------------------------
log() {
    local level="$1"
    shift
    printf "[%s] [%-7s] %s\n" "$(date +'%Y-%m-%d %H:%M:%S')" "${level}" "$*" >> "${LOG_FILE}"
}

info() {
    log "INFO" "$*"
    printf "%b[INFO]%b %s\n" "${C_BLUE}" "${C_RESET}" "$*"
}

success() {
    log "SUCCESS" "$*"
    printf "%b[SUCCESS]%b %s\n" "${C_GREEN}" "${C_RESET}" "$*"
}

warn() {
    log "WARN" "$*"
    printf "%b[WARNING]%b %s\n" "${C_YELLOW}" "${C_RESET}" "$*"
}

error() {
    log "ERROR" "$*"
    printf "%b[ERROR]%b %s\n" "${C_RED}" "${C_RESET}" "$*" >&2
}

fatal() {
    log "FATAL" "$*"
    printf "%b[FATAL]%b %s\n" "${C_RED}${C_BOLD}" "${C_RESET}" "$*" >&2
    exit 1
}

header() {
    local title="$1"
    log "SECTION" "=== ${title} ==="
    printf "\n%b%s%b\n" "${C_CYAN}${C_BOLD}" "================================================================================" "${C_RESET}"
    printf "%b  %s%b\n" "${C_CYAN}${C_BOLD}" "${title}" "${C_RESET}"
    printf "%b%s%b\n\n" "${C_CYAN}${C_BOLD}" "================================================================================" "${C_RESET}"
}

show_banner() {
    cat << "EOF"
  █████╗ ██╗  ██╗██████╗ ███████╗██████╗ ███╗   ██╗██████╗ ███████╗
 ██╔══██╗██║  ██║██╔══██╗██╔════╝██╔══██╗████╗  ██║██╔══██╗██╔════╝
 ███████║██║  ██║██████╔╝█████╗  ██║  ██║██╔██╗ ██║██║  ██║███████╗
 ██╔══██║██║  ██║██╔══██╗██╔══╝  ██║  ██║██║╚██╗██║██║  ██║╚════██║
 ██║  ██║╚██████╔╝██║  ██║███████╗██████╔╝██║ ╚████║██████╔╝███████║
 ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═════╝ ╚═╝  ╚═══╝╚═════╝ ╚══════╝
                 Trixie Target Production System
EOF
    printf " Architecture: %b%s%b | Target Suite: %bDebian %s%b\n\n" \
        "${C_BOLD}" "${TARGET_ARCH}" "${C_RESET}" "${C_BOLD}" "${DEBIAN_SUITE}" "${C_RESET}"
}

# ------------------------------------------------------------------------------
# BUILD PHASES
# ------------------------------------------------------------------------------

phase1_environment_validation() {
    header "Phase 1: Environment Validation"

    info "Checking Host OS..."
    if [[ ! -f /etc/os-release ]]; then
        fatal "Non-Linux operating system detected."
    fi
    source /etc/os-release
    if [[ "${ID:-}" != "debian" && "${ID_LIKE:-}" != *"debian"* ]]; then
        warn "Host OS '${NAME}' is not explicitly Debian-based. Build stability may vary."
    else
        success "Host OS validated: ${NAME}"
    fi

    info "Validating Shell Environment..."
    if (( BASH_VERSINFO[0] < REQUIRED_BASH_VER )); then
        fatal "Bash v${REQUIRED_BASH_VER}+ is required. Current: v${BASH_VERSION}"
    fi

    info "Evaluating Hardware Resources..."
    local total_ram_mb free_disk_kb free_disk_gb total_ram_gb
    total_ram_mb=$(free -m | awk '/^Mem:/{print $2}')
    total_ram_gb=$(( total_ram_mb / 1024 ))
    info "RAM Detected: ${total_ram_gb} GB (${total_ram_mb} MB)"

    if (( total_ram_gb < MIN_RAM_GB )); then
        fatal "Insufficient RAM. Minimum required: ${MIN_RAM_GB}GB"
    fi

    free_disk_kb=$(df --output=avail "${ROOT_DIR}" | tail -n1)
    free_disk_gb=$(( free_disk_kb / 1024 / 1024 ))
    info "Available Disk Space: ${free_disk_gb} GB"

    if (( free_disk_gb < MIN_DISK_GB )); then
        fatal "Insufficient storage space. Minimum required: ${MIN_DISK_GB}GB"
    fi

    info "Testing Network Reachability..."
    if ping -c 1 -W 3 deb.debian.org &>/dev/null; then
        success "Internet connectivity verified."
    else
        fatal "Debian mirrors unreachable. Check internet connection."
    fi

    success "Phase 1 Validation Passed."
}

phase2_dependency_management() {
    header "Phase 2: Dependency Management"

    local required_pkgs=(
        "live-build" "debootstrap" "squashfs-tools" "xorriso"
        "isolinux" "syslinux-utils" "grub-pc-bin" "grub-efi-amd64-bin"
        "git" "rsync" "curl" "mtools" "dosfstools"
    )
    local missing_pkgs=()

    for pkg in "${required_pkgs[@]}"; do
        if ! dpkg -s "${pkg}" &>/dev/null; then
            missing_pkgs+=("${pkg}")
        fi
    done

    if (( ${#missing_pkgs[@]} > 0 )); then
        warn "Missing build packages: ${missing_pkgs[*]}"
        info "Updating APT repositories..."
        apt-get update -qq
        info "Installing required packages..."
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing_pkgs[@]}"
        success "Dependencies installed."
    else
        success "All required packages are satisfied."
    fi

    for bin in lb debootstrap mksquashfs xorriso rsync; do
        if ! command -v "${bin}" &>/dev/null; then
            fatal "Binary tool '${bin}' missing after dependency setup."
        fi
    done
}

phase3_project_validation() {
    header "Phase 3: Project Structure Validation"

    mkdir -p "${CONFIG_DIR}/includes.chroot/etc" \
             "${CONFIG_DIR}/hooks/normal" \
             "${CONFIG_DIR}/package-lists"

    success "Directory structure and hooks initialized."
}

phase4_cleanup() {
    header "Phase 4: Pre-Build Cleanup"

    cd "${ROOT_DIR}"
    info "Purging stale live-build chroots and caches..."
    if [[ -d ".build" || -d "chroot" || -f "config/bootstrap" ]]; then
        lb clean --purge || warn "Clean command encountered warnings."
    fi

    rm -rf "${ROOT_DIR}/.build" "${ROOT_DIR}"/*.iso "${ROOT_DIR}"/*.hybrid.iso "${ROOT_DIR}"/*.apt-source
    success "Working tree cleaned."
}

phase5_configuration() {
    header "Phase 5: Automated live-build Configuration (Trixie)"

    cd "${ROOT_DIR}"
    mkdir -p auto

    info "Writing live-build auto/config rules for Debian ${DEBIAN_SUITE}..."
    cat << EOF > auto/config
#!/bin/sh
set -e
lb config noauto \\
    --distribution "${DEBIAN_SUITE}" \\
    --architectures "${TARGET_ARCH}" \\
    --archive-areas "main contrib non-free non-free-firmware" \\
    --debian-installer false \\
    --binary-images iso-hybrid \\
    --bootloader grub-efi \\
    --iso-application "AureonOS Live Media" \\
    --iso-preparer "AureonOS Team <build@aureonos.org>" \\
    --iso-publisher "AureonOS Project" \\
    --iso-volume "AUREONOS_1_0" \\
    --memtest none \\
    --win32-loader false \\
    "\${@}"
EOF
    chmod +x auto/config

    info "Executing live-build configuration generator..."
    lb config

    info "Populating default package stack..."
    cat << EOF > "${CONFIG_DIR}/package-lists/aureonos-core.list.chroot"
linux-image-amd64
live-boot
live-config
live-config-systemd
network-manager
sudo
bash-completion
curl
wget
rsync
htop
fastfetch
plymouth
plymouth-themes
xorg
xfce4
xfce4-goodies
EOF

    success "Live-build configured successfully for ${DEBIAN_SUITE}."
}

phase6_branding() {
    header "Phase 6: Branding & System Personalization"

    local chroot_etc="${CONFIG_DIR}/includes.chroot/etc"
    mkdir -p "${chroot_etc}"

    info "Writing OS release identification files..."
    cat << EOF > "${chroot_etc}/os-release"
NAME="${OS_NAME}"
VERSION="${OS_VERSION} (${OS_CODENAME})"
ID=${OS_NAME,,}
ID_LIKE=debian
PRETTY_NAME="${OS_NAME} ${OS_VERSION} (${DEBIAN_SUITE})"
VERSION_ID="${OS_VERSION}"
HOME_URL="https://aureonos.org"
EOF

    cat << EOF > "${chroot_etc}/issue"
${OS_NAME} ${OS_VERSION} (${DEBIAN_SUITE}) \n \l

EOF

    cat << EOF > "${chroot_etc}/issue.net"
${OS_NAME} ${OS_VERSION} (${DEBIAN_SUITE})
EOF

    echo "aureonos" > "${chroot_etc}/hostname"

    cat << EOF > "${chroot_etc}/motd"
Welcome to ${OS_NAME} ${OS_VERSION} (Debian ${DEBIAN_SUITE} target)
EOF

    success "Branding files applied."
}

phase7_build() {
    header "Phase 7: Compiling AureonOS ISO"

    cd "${ROOT_DIR}"
    info "Launching live-build engine... Logs written directly to ${LOG_FILE}"

    if lb build 2>&1 | tee -a "${LOG_FILE}"; then
        success "ISO image built without errors."
    else
        fatal "Build process failed. Inspect ${LOG_FILE} for errors."
    fi
}

phase8_packaging() {
    header "Phase 8: Packaging & Verification"

    cd "${ROOT_DIR}"
    local generated_iso=""

    if [[ -f "live-image-amd64.hybrid.iso" ]]; then
        generated_iso="live-image-amd64.hybrid.iso"
    elif [[ -f "live-image-amd64.iso" ]]; then
        generated_iso="live-image-amd64.iso"
    else
        fatal "Generated ISO binary artifact not found."
    fi

    local target_path="${OUTPUT_DIR}/${ISO_NAME}"

    info "Moving ISO to output directory..."
    mv "${generated_iso}" "${target_path}"

    info "Computing SHA256 checksum..."
    sha256sum "${target_path}" | awk '{print $1}' > "${target_path}.sha256"

    info "Writing build details manifest..."
    cat << EOF > "${OUTPUT_DIR}/build-info.txt"
AureonOS Release Manifest
--------------------------
OS Name       : ${OS_NAME}
Version       : ${OS_VERSION}
Codename      : ${OS_CODENAME}
Architecture  : ${TARGET_ARCH}
Debian Suite  : ${DEBIAN_SUITE}
Build Date    : $(date -u +"%Y-%m-%dT%H:%M:%SZ")
ISO Output    : ${ISO_NAME}
SHA256        : $(cat "${target_path}.sha256")
Host Kernel   : $(uname -r)
EOF

    success "Artifacts packaged in output/."
}

phase9_post_clean() {
    header "Phase 9: Post-Build Cleanup"

    cd "${ROOT_DIR}"
    info "Cleaning temporary chroot files while retaining outputs..."
    lb clean --purge
    success "Post-build cleanup completed."
}

# ------------------------------------------------------------------------------
# MAIN EXECUTION ORCHESTRATOR
# ------------------------------------------------------------------------------
main() {
    clear
    show_banner

    if [[ "${EUID}" -ne 0 ]]; then
        fatal "Root privileges required. Run as: sudo ./build.sh"
    fi

    trap 'error "Execution interrupted or hit an unhandled failure. See: ${LOG_FILE}"; exit 1' ERR

    local start_time
    start_time=$(date +%s)

    # Sequence execution
    phase1_environment_validation
    phase2_dependency_management
    phase3_project_validation
    phase4_cleanup
    phase5_configuration
    phase6_branding
    phase7_build
    phase8_packaging
    phase9_post_clean

    local end_time duration minutes seconds iso_sha256
    end_time=$(date +%s)
    duration=$(( end_time - start_time ))
    minutes=$(( duration / 60 ))
    seconds=$(( duration % 60 ))
    iso_sha256=$(cat "${OUTPUT_DIR}/${ISO_NAME}.sha256" 2>/dev/null || echo "N/A")

    header "Build Summary"
    printf "%b==============================================================================%b\n" "${C_GREEN}" "${C_RESET}"
    printf "%b  AureonOS Build Completed Successfully%b\n" "${C_GREEN}${C_BOLD}" "${C_RESET}"
    printf "%b==============================================================================%b\n" "${C_GREEN}" "${C_RESET}"
    printf "  %-20s : %s\n" "OS Version" "${OS_VERSION}"
    printf "  %-20s : Debian %s\n" "Debian Suite" "${DEBIAN_SUITE}"
    printf "  %-20s : %s\n" "Target Architecture" "${TARGET_ARCH}"
    printf "  %-20s : %s\n" "Completion Time" "$(date)"
    printf "  %-20s : %dm %ds\n" "Total Duration" "${minutes}" "${seconds}"
    printf "  %-20s : %s\n" "Output ISO Path" "${OUTPUT_DIR}/${ISO_NAME}"
    printf "  %-20s : %s\n" "SHA256 Checksum" "${iso_sha256}"
    printf "  %-20s : %s\n" "Execution Log" "${LOG_FILE}"
    printf "%b==============================================================================%b\n\n" "${C_GREEN}" "${C_RESET}"
}

main "$@"
