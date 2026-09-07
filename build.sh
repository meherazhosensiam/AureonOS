#!/usr/bin/env bash

# ============================================================
#                    AureonOS
#              PROFESSIONAL BUILD SYSTEM
# ============================================================
#
#  Debian Live-Build Automation
#
#  Examples:
#
#    sudo ./build.sh
#    sudo ./build.sh --arch amd64
#    sudo ./build.sh --arch amd64
#    sudo ./build.sh --version 1.0
#    sudo ./build.sh --version 1.1 --arch amd64
#    sudo ./build.sh --name "AureonOS"
#    sudo ./build.sh --iso-name "AureonOS-Custom.iso"
#    sudo ./build.sh --clean
#    sudo ./build.sh --clean --force
#    sudo ./build.sh --no-deps
#    sudo ./build.sh --non-interactive
#    sudo ./build.sh --skip-cleanup
#    sudo ./build.sh --keep-build
#    sudo ./build.sh --debug
#
# ============================================================

set -Eeuo pipefail


# ============================================================
# Configuration
# ============================================================

PROJECT_NAME="AureonOS"
VERSION="1.0"

DEFAULT_ARCH="amd64"
ARCH="$DEFAULT_ARCH"

# Architecture-specific kernel package.
KERNEL_PACKAGE=""

DISTRIBUTION="trixie"

ISO_VOLUME="$PROJECT_NAME"
ISO_NAME=""

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$PROJECT_DIR/logs"

TIMESTAMP="$(date '+%Y-%m-%d_%H-%M-%S')"
LOG_FILE="$LOG_DIR/build-${TIMESTAMP}.log"

START_TIME="$(date +%s)"

NON_INTERACTIVE=false
SKIP_DEPS=false
FORCE_CLEAN=false
SKIP_RELEASE_CLEAN=false
SKIP_CLEANUP=false
KEEP_BUILD=false
DEBUG=false
SHOW_HELP=false
DRY_RUN=false


# ============================================================
# Colors
# ============================================================

if [[ -t 1 ]]; then

    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    BLUE='\033[0;34m'
    CYAN='\033[0;36m'
    MAGENTA='\033[0;35m'
    WHITE='\033[1;37m'
    GRAY='\033[0;90m'

    RESET='\033[0m'
    BOLD='\033[1m'

else

    RED=''
    GREEN=''
    YELLOW=''
    BLUE=''
    CYAN=''
    MAGENTA=''
    WHITE=''
    GRAY=''

    RESET=''
    BOLD=''

fi


# ============================================================
# Logging
# ============================================================

mkdir -p "$LOG_DIR"

touch "$LOG_FILE"

exec > >(tee -a "$LOG_FILE") 2>&1


# ============================================================
# Utility Functions
# ============================================================

print_banner() {

    echo
    echo -e "${CYAN}${BOLD}"
    echo "============================================================"
    echo "                    ${PROJECT_NAME}"
    echo "                  PROFESSIONAL BUILD SYSTEM"
    echo "============================================================"
    echo -e "${RESET}"

    echo -e "${GRAY}Project      : ${PROJECT_NAME}${RESET}"
    echo -e "${GRAY}Version      : ${VERSION}${RESET}"
    echo -e "${GRAY}Architecture : ${ARCH}${RESET}"
    echo -e "${GRAY}Distribution : Debian ${DISTRIBUTION}${RESET}"
    echo -e "${GRAY}ISO Volume   : ${ISO_VOLUME}${RESET}"
    echo -e "${GRAY}ISO Name     : ${ISO_NAME}${RESET}"
    echo -e "${GRAY}Started      : $(date '+%Y-%m-%d %H:%M:%S')${RESET}"
    echo -e "${GRAY}Log file     : ${LOG_FILE}${RESET}"

    echo
}


info() {

    echo -e "${BLUE}[INFO]${RESET} $*"

}


success() {

    echo -e "${GREEN}[ OK ]${RESET} $*"

}


warning() {

    echo -e "${YELLOW}[WARN]${RESET} $*"

}


error() {

    echo -e "${RED}[ERROR]${RESET} $*"

}


step() {

    echo
    echo -e "${MAGENTA}${BOLD}==> $*${RESET}"

}


die() {

    error "$*"
    exit 1

}


separator() {

    echo -e "${GRAY}------------------------------------------------------------${RESET}"

}


# ============================================================
# Error Handler
# ============================================================

error_handler() {

    local exit_code=$?
    local line_number="${1:-unknown}"
    local command="${BASH_COMMAND}"

    echo

    echo -e "${RED}${BOLD}"
    echo "============================================================"
    echo "                    BUILD FAILED"
    echo "============================================================"
    echo -e "${RESET}"

    error "Exit code   : $exit_code"
    error "Line        : $line_number"
    error "Command     : $command"
    error "Project     : $PROJECT_NAME"
    error "Version     : $VERSION"
    error "Architecture: $ARCH"
    error "Log file    : $LOG_FILE"

    echo

    warning "The complete build output has been saved to:"
    echo -e "${CYAN}${LOG_FILE}${RESET}"

    echo

    exit "$exit_code"
}


trap 'error_handler $LINENO' ERR


# ============================================================
# Exit Handler
# ============================================================

cleanup_on_exit() {

    local end_time
    local duration

    end_time="$(date +%s)"
    duration=$((end_time - START_TIME))

    echo

    info "Build session duration: ${duration}s"

}


trap cleanup_on_exit EXIT


# ============================================================
# Root Check
# ============================================================

check_root() {

    if [[ "${EUID}" -ne 0 ]]; then

        echo

        error "This build system must be run as root."

        echo

        echo -e "${YELLOW}Use:${RESET}"

        echo
        echo -e "    ${GREEN}sudo ./build.sh${RESET}"
        echo

        exit 1

    fi

}


# ============================================================
# Architecture Validation
# ============================================================

validate_architecture() {

    # amd64 is the default when the user does not specify
    # --arch.

    case "$ARCH" in

        amd64)
            KERNEL_PACKAGE="linux-image-amd64"
            ;;

        i386)
            KERNEL_PACKAGE="linux-image-686"
            ;;

        amd64)
            KERNEL_PACKAGE="linux-image-amd64"
            ;;

        armhf)
            KERNEL_PACKAGE="linux-image-armmp"
            ;;

        *)
            error "Unsupported architecture: $ARCH"

            echo
            echo "Supported architectures:"
            echo "  amd64"
            echo "  i386"
            echo "  amd64"
            echo "  armhf"
            echo

            exit 1
            ;;

    esac

    success "Architecture '$ARCH' is supported."
    success "Kernel package: $KERNEL_PACKAGE"
}


# ============================================================
# Architecture Packages
# ============================================================

get_arch_packages() {

    ARCH_PACKAGES=()

    case "$ARCH" in

        amd64)

            ARCH_PACKAGES+=(
                grub-pc-bin
                grub-efi-amd64-bin
            )

            ;;

        i386)

            ARCH_PACKAGES+=(
                grub-pc-bin
            )

            ;;

        amd64)

            ARCH_PACKAGES+=(
                grub-efi-amd64-bin
            )

            ;;

        armhf)

            ARCH_PACKAGES+=(
                grub-efi-arm-bin
            )

            ;;

    esac

}


# ============================================================
# Kernel Package Selection
# ============================================================

get_kernel_package() {

    case "$ARCH" in

        amd64)
            KERNEL_PACKAGE="linux-image-amd64"
            ;;

        i386)
            KERNEL_PACKAGE="linux-image-686"
            ;;

        amd64)
            KERNEL_PACKAGE="linux-image-amd64"
            ;;

        armhf)
            KERNEL_PACKAGE="linux-image-armmp"
            ;;

        *)
            die "No kernel package mapping exists for architecture: $ARCH"
            ;;

    esac

    success "Kernel package: ${KERNEL_PACKAGE}"

}


# ============================================================
# General Dependencies
# ============================================================

BASE_PACKAGES=(

    live-build
    debootstrap
    xorriso
    squashfs-tools
    dosfstools
    mtools
    git
    curl

)


# ============================================================
# ISO Name Generation
# ============================================================

generate_iso_name() {

    if [[ -z "$ISO_NAME" ]]; then

        ISO_NAME="${PROJECT_NAME}-${VERSION}-${ARCH}.iso"

    fi

}


# ============================================================
# Help
# ============================================================

show_help() {

    echo

    echo -e "${CYAN}${BOLD}${PROJECT_NAME} Build System${RESET}"

    echo
    echo "Professional Debian Live-Build automation."
    echo

    echo -e "${WHITE}Usage:${RESET}"

    echo
    echo "  sudo ./build.sh [OPTIONS]"

    echo

    echo -e "${WHITE}Build Options:${RESET}"

    echo
    echo "  -a, --arch ARCH"
    echo "      Target architecture."
    echo "      Default: amd64"
    echo "      Supported: amd64, i386, amd64, armhf"

    echo
    echo "  -v, --version VERSION"
    echo "      Set the AureonOS version."
    echo "      Default: 1.0"

    echo
    echo "  -n, --name NAME"
    echo "      Set the project/ISO name."
    echo "      Default: AureonOS"

    echo
    echo "  --iso-name NAME"
    echo "      Set the exact final ISO filename."
    echo "      Example: --iso-name AureonOS-Custom.iso"

    echo
    echo "  --iso-volume NAME"
    echo "      Set the ISO volume label."
    echo "      Default: AureonOS"

    echo
    echo "  --distribution NAME"
    echo "      Debian distribution."
    echo "      Default: trixie"

    echo

    echo -e "${WHITE}Cleaning Options:${RESET}"

    echo
    echo "  --clean"
    echo "      Clean the previous live-build environment."

    echo
    echo "  --force"
    echo "      Force cleanup before building."

    echo
    echo "  --skip-cleanup"
    echo "      Do not perform build cleanup."

    echo
    echo "  --keep-build"
    echo "      Keep the generated build environment."

    echo

    echo -e "${WHITE}Dependency Options:${RESET}"

    echo
    echo "  --no-deps"
    echo "      Skip dependency checking."

    echo

    echo -e "${WHITE}Release Options:${RESET}"

    echo
    echo "  --no-release-clean"
    echo "      Skip release-clean.sh."

    echo

    echo -e "${WHITE}Execution Options:${RESET}"

    echo
    echo "  --non-interactive"
    echo "      Disable interactive release cleanup prompt."

    echo
    echo "  --dry-run"
    echo "      Show what would be done without building."

    echo
    echo "  --debug"
    echo "      Enable Bash debugging."

    echo
    echo "  -h, --help"
    echo "      Show this help message."

    echo

    echo -e "${WHITE}Examples:${RESET}"

    echo

    echo "  sudo ./build.sh"

    echo "      Standard amd64 build."

    echo

    echo "  sudo ./build.sh --version 1.1"

    echo "      Build AureonOS 1.1."

    echo

    echo "  sudo ./build.sh --arch amd64"

    echo "      Build for ARM64."

    echo

    echo "  sudo ./build.sh --arch amd64 --version 2.0"

    echo "      Build AureonOS 2.0 for amd64."

    echo

    echo "  sudo ./build.sh --name AureonOS --version 1.0"

    echo "      Set project name and version."

    echo

    echo "  sudo ./build.sh --iso-name AureonOS-Testing.iso"

    echo "      Set exact ISO filename."

    echo

    echo "  sudo ./build.sh --clean"

    echo "      Clean and then build."

    echo

    echo "  sudo ./build.sh --clean --force"

    echo "      Force a clean build."

    echo

    echo "  sudo ./build.sh --no-deps"

    echo "      Skip dependency checking."

    echo

    echo "  sudo ./build.sh --non-interactive"

    echo "      Fully automated build."

    echo

    echo "  sudo ./build.sh --dry-run"

    echo "      Preview configuration without building."

    echo

}


# ============================================================
# Argument Parser
# ============================================================

while [[ $# -gt 0 ]]; do

    case "$1" in

        -a|--arch)

            [[ -n "${2:-}" ]] || die "Missing architecture after $1"

            ARCH="$2"

            shift 2

            ;;


        -v|--version)

            [[ -n "${2:-}" ]] || die "Missing version after $1"

            VERSION="$2"

            shift 2

            ;;


        -n|--name)

            [[ -n "${2:-}" ]] || die "Missing name after $1"

            PROJECT_NAME="$2"

            shift 2

            ;;


        --iso-name)

            [[ -n "${2:-}" ]] || die "Missing ISO filename after $1"

            ISO_NAME="$2"

            shift 2

            ;;


        --iso-volume)

            [[ -n "${2:-}" ]] || die "Missing ISO volume after $1"

            ISO_VOLUME="$2"

            shift 2

            ;;


        --distribution)

            [[ -n "${2:-}" ]] || die "Missing distribution after $1"

            DISTRIBUTION="$2"

            shift 2

            ;;


        --clean)

            FORCE_CLEAN=true

            shift

            ;;


        --force)

            FORCE_CLEAN=true

            shift

            ;;


        --no-deps)

            SKIP_DEPS=true

            shift

            ;;


        --no-release-clean)

            SKIP_RELEASE_CLEAN=true

            shift

            ;;


        --skip-cleanup)

            SKIP_CLEANUP=true

            shift

            ;;


        --keep-build)

            KEEP_BUILD=true

            shift

            ;;


        --non-interactive)

            NON_INTERACTIVE=true

            shift

            ;;


        --dry-run)

            DRY_RUN=true

            shift

            ;;


        --debug)

            DEBUG=true

            shift

            ;;


        -h|--help)

            SHOW_HELP=true

            shift

            ;;


        *)

            error "Unknown option: $1"

            echo

            show_help

            exit 1

            ;;

    esac

done


# ============================================================
# Apply Dynamic Configuration
# ============================================================

generate_iso_name


if [[ "$DEBUG" == true ]]; then

    set -x

fi


# ============================================================
# Dry Run
# ============================================================

dry_run() {

    step "Dry-run configuration"

    separator

    echo -e "${WHITE}Project       :${RESET} $PROJECT_NAME"
    echo -e "${WHITE}Version       :${RESET} $VERSION"
    echo -e "${WHITE}Architecture  :${RESET} $ARCH"
    echo -e "${WHITE}Distribution  :${RESET} $DISTRIBUTION"
    echo -e "${WHITE}ISO Volume    :${RESET} $ISO_VOLUME"
    echo -e "${WHITE}ISO Filename  :${RESET} $ISO_NAME"
    echo -e "${WHITE}Dependencies  :${RESET} $([[ "$SKIP_DEPS" == true ]] && echo "Skipped" || echo "Enabled")"
    echo -e "${WHITE}Clean         :${RESET} $([[ "$FORCE_CLEAN" == true ]] && echo "Enabled" || echo "Disabled")"
    echo -e "${WHITE}Release Clean :${RESET} $([[ "$SKIP_RELEASE_CLEAN" == true ]] && echo "Skipped" || echo "Enabled")"
    echo -e "${WHITE}Keep Build    :${RESET} $([[ "$KEEP_BUILD" == true ]] && echo "Yes" || echo "No")"

    separator

    echo
    success "Dry run completed. No build was performed."

    exit 0

}


# ============================================================
# Dependency Installation
# ============================================================

install_dependencies() {

    if [[ "$SKIP_DEPS" == true ]]; then

        warning "Dependency checking skipped."

        return

    fi


    step "Checking build dependencies"

    info "Updating APT package lists..."

    apt-get update


    local packages=(
        "${BASE_PACKAGES[@]}"
        "${ARCH_PACKAGES[@]}"
    )


    local missing_packages=()


    for pkg in "${packages[@]}"; do

        if dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null \
            | grep -q "install ok installed"; then

            success "$pkg is already installed."

        else

            warning "$pkg is missing."

            missing_packages+=("$pkg")

        fi

    done


    if [[ ${#missing_packages[@]} -gt 0 ]]; then

        info "Installing missing dependencies..."

        apt-get install -y "${missing_packages[@]}"

        success "Missing dependencies installed."

    else

        success "All build dependencies are installed."

    fi

}


# ============================================================
# Clean Build
# ============================================================

clean_build() {

    step "Cleaning previous build environment"


    local found=false


    if [[ -d "$PROJECT_DIR/.build" ]] \
        || [[ -d "$PROJECT_DIR/chroot" ]] \
        || [[ -d "$PROJECT_DIR/binary" ]] \
        || [[ -d "$PROJECT_DIR/cache" ]] \
        || [[ -d "$PROJECT_DIR/bootstrap" ]]; then

        found=true

    fi


    if [[ "$found" == true ]]; then

        info "Running live-build cleanup..."

        lb clean --purge || lb clean

        success "Previous live-build environment cleaned."

    else

        info "No previous live-build environment detected."

    fi


    # Remove old generated ISO files.

    shopt -s nullglob

    local old_iso

    for old_iso in "$PROJECT_DIR"/*.iso; do

        info "Removing old ISO: $(basename "$old_iso")"

        rm -f -- "$old_iso"

    done

    shopt -u nullglob

}


# ============================================================
# Configure Live-Build
# ============================================================

configure_live_build() {

    step "Configuring live-build"

    info "Distribution : Debian ${DISTRIBUTION}"
    info "Architecture : ${ARCH}"
    info "ISO volume   : ${ISO_VOLUME}"


    # --------------------------------------------------------
    # Important:
    #
    # The complete live-build configuration lives inside
    # auto/config (the single source of truth). It is invoked
    # with ARCH so it applies the correct architecture and all
    # AUREON OS settings.
    # --------------------------------------------------------

    ARCH="$ARCH" ./auto/config


    success "live-build configuration completed."

}


# ============================================================
# Build
# ============================================================

build_system() {

    step "Building ${PROJECT_NAME}"

    info "Project      : ${PROJECT_NAME}"
    info "Version      : ${VERSION}"
    info "Architecture : ${ARCH}"
    info "Distribution : Debian ${DISTRIBUTION}"
    info "This may take some time..."

    echo


    lb build


    success "${PROJECT_NAME} build completed successfully."

}


# ============================================================
# Locate Generated ISO
# ============================================================

find_generated_iso() {

    local candidate

    # First try the standard live-build filename.

    candidate="$PROJECT_DIR/live-image-${ARCH}.hybrid.iso"

    if [[ -f "$candidate" ]]; then

        echo "$candidate"

        return 0

    fi


    # Try other common live-build ISO names.

    shopt -s nullglob

    local candidates=(
        "$PROJECT_DIR"/*.iso
        "$PROJECT_DIR"/live-image-*.iso
    )

    shopt -u nullglob


    for candidate in "${candidates[@]}"; do

        if [[ -f "$candidate" ]]; then

            echo "$candidate"

            return 0

        fi

    done


    return 1

}


# ============================================================
# Finalize ISO
# ============================================================

finalize_iso() {

    step "Finalizing ISO image"


    local source_iso

    if ! source_iso="$(find_generated_iso)"; then

        error "No generated ISO image was found."

        return 1

    fi


    local target_iso="$PROJECT_DIR/$ISO_NAME"


    # Don't rename if already correctly named.

    if [[ "$source_iso" == "$target_iso" ]]; then

        success "ISO already has the correct filename."

    else

        if [[ -f "$target_iso" ]]; then

            warning "Existing ISO found:"
            warning "$(basename "$target_iso")"

            info "Replacing existing ISO..."

            rm -f -- "$target_iso"

        fi


        mv -- "$source_iso" "$target_iso"

        success "ISO renamed successfully."

    fi


    local size

    size="$(du -h "$target_iso" | cut -f1)"


    info "Filename : $(basename "$target_iso")"
    info "Size     : $size"
    info "Path     : $target_iso"


    ISO_OUTPUT="$target_iso"

}


# ============================================================
# ISO Verification
# ============================================================

verify_output() {

    step "Verifying build output"


    if [[ -z "${ISO_OUTPUT:-}" ]]; then

        warning "ISO output variable is empty."

        return 1

    fi


    if [[ ! -f "$ISO_OUTPUT" ]]; then

        error "Expected ISO does not exist:"
        error "$ISO_OUTPUT"

        return 1

    fi


    local size
    size="$(du -h "$ISO_OUTPUT" | cut -f1)"


    success "ISO image verified."

    info "Name : $(basename "$ISO_OUTPUT")"
    info "Size : $size"
    info "Path : $ISO_OUTPUT"


    # --------------------------------------------------------
    # Optional SHA256 checksum
    # --------------------------------------------------------

    if command -v sha256sum >/dev/null 2>&1; then

        local checksum_file="${ISO_OUTPUT}.sha256"

        info "Generating SHA256 checksum..."

        sha256sum "$ISO_OUTPUT" > "$checksum_file"

        success "SHA256 checksum created."

        info "Checksum: $(basename "$checksum_file")"

    fi

}


# ============================================================
# Release Cleanup
# ============================================================

release_cleanup() {

    if [[ "$SKIP_RELEASE_CLEAN" == true ]]; then

        info "Release cleanup skipped."

        return

    fi


    if [[ ! -f "$PROJECT_DIR/release-clean.sh" ]]; then

        warning "release-clean.sh was not found."

        return

    fi


    if [[ ! -x "$PROJECT_DIR/release-clean.sh" ]]; then

        warning "release-clean.sh is not executable."

        return

    fi


    if [[ "$NON_INTERACTIVE" == true ]]; then

        info "Non-interactive mode enabled."

        info "Running release cleanup..."

        "$PROJECT_DIR/release-clean.sh" --force

        success "Repository cleanup completed."

        return

    fi


    echo

    read -rp \
        "Do you want to clean the repository for GitHub? (y/N): " \
        CLEAN


    if [[ "$CLEAN" =~ ^[Yy]$ ]]; then

        step "Running GitHub release cleanup"

        "$PROJECT_DIR/release-clean.sh"

        success "Repository cleanup completed."

    else

        info "Repository cleanup skipped."

    fi

}


# ============================================================
# Optional Build Cleanup
# ============================================================

post_build_cleanup() {

    if [[ "$KEEP_BUILD" == true ]]; then

        info "Keeping build environment (--keep-build)."

        return

    fi


    if [[ "$SKIP_CLEANUP" == true ]]; then

        info "Post-build cleanup skipped."

        return

    fi


    # IMPORTANT:
    #
    # We do not run "lb clean --purge" here by default because
    # keeping the live-build cache can make subsequent builds
    # significantly faster.
    #

    info "Preserving live-build cache for faster future builds."

}


# ============================================================
# Final Message
# ============================================================

final_message() {

    echo

    echo -e "${GREEN}${BOLD}"
    echo "============================================================"
    echo "              BUILD COMPLETED SUCCESSFULLY"
    echo "============================================================"
    echo -e "${RESET}"


    echo -e "${WHITE}Project       : ${PROJECT_NAME}${RESET}"
    echo -e "${WHITE}Version       : ${VERSION}${RESET}"
    echo -e "${WHITE}Architecture  : ${ARCH}${RESET}"
    echo -e "${WHITE}Distribution  : Debian ${DISTRIBUTION}${RESET}"
    echo -e "${WHITE}ISO           : $(basename "$ISO_OUTPUT")${RESET}"
    echo -e "${WHITE}Finished      : $(date '+%Y-%m-%d %H:%M:%S')${RESET}"
    echo -e "${WHITE}Log file      : ${LOG_FILE}${RESET}"

    echo

    echo -e "${GREEN}ISO successfully generated and verified.${RESET}"

    echo

}


# ============================================================
# Main
# ============================================================

main() {

    if [[ "$SHOW_HELP" == true ]]; then

        show_help

        exit 0

    fi


    check_root

    validate_architecture

    get_arch_packages

    get_kernel_package

    generate_iso_name


    cd "$PROJECT_DIR"


    if [[ "$DRY_RUN" == true ]]; then

        dry_run

    fi


    print_banner


    # --------------------------------------------------------
    # Dependencies
    # --------------------------------------------------------

    install_dependencies


    # --------------------------------------------------------
    # Clean before build
    # --------------------------------------------------------

    if [[ "$FORCE_CLEAN" == true ]]; then

        clean_build

    fi


    # --------------------------------------------------------
    # Live-build configuration
    # --------------------------------------------------------

    configure_live_build


    # --------------------------------------------------------
    # Build
    # --------------------------------------------------------

    build_system


    # --------------------------------------------------------
    # ISO naming
    # --------------------------------------------------------

    finalize_iso


    # --------------------------------------------------------
    # Verify
    # --------------------------------------------------------

    verify_output


    # --------------------------------------------------------
    # Release cleanup
    # --------------------------------------------------------

    release_cleanup


    # --------------------------------------------------------
    # Post-build
    # --------------------------------------------------------

    post_build_cleanup


    # --------------------------------------------------------
    # Final
    # --------------------------------------------------------

    final_message

}


# ============================================================
# Start
# ============================================================

main "$@"