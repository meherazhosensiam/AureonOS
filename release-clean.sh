#!/usr/bin/env bash
#
# release-clean.sh
#
# AureonOS — Pre-Release Cleanup Script
# ---------------------------------------------------------------------------
# Purpose:
#   This script prepares the AureonOS repository for a GitHub push AFTER a
#   successful build. It removes generated build artifacts, ISO images,
#   caches, logs, and temporary files so that only source-controlled,
#   reviewable content is committed.
#
#   This script is NOT the build script and NOT the automatic live-build
#   cleanup hook. It is a deliberate, interactive (or CI-gated) maintenance
#   tool that a maintainer runs by hand before publishing a release.
#
# Author:
#   AureonOS Release Engineering
#
# Usage:
#   ./release-clean.sh [--dry-run] [--force] [--help]
#
# ---------------------------------------------------------------------------

# -----------------------------------------------------------------------------
# Strict mode
# -----------------------------------------------------------------------------
# -E : ERR trap is inherited by shell functions, subshells, command substitutions
# -e : exit immediately on an unhandled non-zero exit status
# -u : treat unset variables as an error
# -o pipefail : a pipeline fails if any command within it fails
set -Eeuo pipefail
IFS=$'\n\t'

# -----------------------------------------------------------------------------
# Global constants
# -----------------------------------------------------------------------------
readonly SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"
readonly SCRIPT_VERSION="1.0.0"
readonly PROJECT_ROOT="$(pwd)"
readonly START_TIME="$(date +%s)"

# ANSI colour codes used for status output. Kept centralised so the visual
# style of the script can be changed in one place.
readonly C_RESET='\033[0m'
readonly C_BOLD='\033[1m'
readonly C_RED='\033[1;31m'
readonly C_GREEN='\033[1;32m'
readonly C_YELLOW='\033[1;33m'
readonly C_BLUE='\033[1;34m'
readonly C_MAGENTA='\033[1;35m'
readonly C_CYAN='\033[1;36m'
readonly C_WHITE='\033[1;37m'
readonly C_BG_RED='\033[41m'

# File-name patterns considered "generated" and safe to remove.
# Grouped so statistics can be reported per category.

# Final disk images produced by `lb build` (live-build names these after the
# binary architecture, e.g. live-image-amd64.hybrid.iso). Kept as a glob so
# other architectures (i386, arm64, ...) are also caught.
readonly -a ISO_PATTERNS=("*.iso" "*.img" "*.hybrid.iso")

# General-purpose log and temp/backup files that may accumulate during
# development but should never be committed.
readonly -a LOG_PATTERNS=("*.log")
readonly -a TMP_PATTERNS=("*.tmp" "*.temp" "*.bak" "*.swp" "*~")

# live-build bookkeeping/manifest files written to the project root by
# `lb build`. These are NOT covered by the extension-based patterns above,
# so they are matched explicitly by name/glob.
readonly -a LIVEBUILD_ARTIFACT_PATTERNS=(
    "live-image-*.contents"
    "live-image-*.files"
    "live-image-*.packages"
    "binary.modified_timestamps"
    "chroot.files"
    "chroot.packages.install"
    "chroot.packages.live"
)

# Build directories that live-build regenerates on every run and that are
# always safe to purge before a release push.
readonly -a BUILD_DIRS=("binary" "cache" "chroot" ".build")

# Paths that must NEVER be touched by this script, no matter what.
# These are checked both as exact top-level paths and as path prefixes.
# This mirrors the real AureonOS project layout: live-build's own
# auto/config/local directories, the top-level build entry point, all
# licensing/community documents, and the branding images shipped in the repo.
readonly -a PROTECTED_PATHS=(
    ".git"
    ".github"
    "auto"
    "config"
    "build.sh"
    "README.md"
    "LICENSE.md"
    "SECURITY.md"
    "CHANGELOG.md"
    "CONTRIBUTING.md"
    "SUPPORTED.md"
    "BUILD.md"
    "applications.png"
    "desktop.png"
    "lockscreen.png"
)

# -----------------------------------------------------------------------------
# Runtime state (mutated as the script runs)
# -----------------------------------------------------------------------------
DRY_RUN=false
FORCE=false

# Statistics counters.
STAT_ISO_COUNT=0
STAT_LOG_COUNT=0
STAT_TMP_COUNT=0
STAT_LIVEBUILD_COUNT=0
STAT_DIR_COUNT=0
STAT_TOTAL_BYTES=0

# -----------------------------------------------------------------------------
# Logging helpers
# -----------------------------------------------------------------------------

# timestamp: prints the current time in HH:MM:SS for step headers.
timestamp() {
    date '+%H:%M:%S'
}

# log_info / log_ok / log_warn / log_err
# Small wrappers that give every message a consistent, colourised, timestamped
# format. Using functions instead of inline echo keeps formatting DRY.
log_info() {
    printf "${C_CYAN}[%s]${C_RESET} ${C_WHITE}%s${C_RESET}\n" "$(timestamp)" "$*"
}

log_ok() {
    printf "${C_CYAN}[%s]${C_RESET} ${C_GREEN}✓ %s${C_RESET}\n" "$(timestamp)" "$*"
}

log_warn() {
    printf "${C_CYAN}[%s]${C_RESET} ${C_YELLOW}⚠ %s${C_RESET}\n" "$(timestamp)" "$*"
}

log_err() {
    printf "${C_CYAN}[%s]${C_RESET} ${C_RED}✗ %s${C_RESET}\n" "$(timestamp)" "$*" >&2
}

log_step() {
    printf "\n${C_BLUE}[%s]${C_RESET} ${C_BOLD}${C_MAGENTA}==> %s${C_RESET}\n" "$(timestamp)" "$*"
}

# -----------------------------------------------------------------------------
# Signal handling
# -----------------------------------------------------------------------------

# on_interrupt: triggered on SIGINT (Ctrl+C) / SIGTERM. Ensures the user gets
# clear feedback instead of a raw shell trace, and exits with the conventional
# 130 code for "terminated by Ctrl+C".
on_interrupt() {
    printf "\n"
    log_err "Interrupted by user (Ctrl+C). No further changes will be made."
    log_warn "Some files may have already been removed before the interrupt."
    exit 130
}

# on_error: triggered by the ERR trap for any unhandled command failure.
# $1 = line number, $2 = exit code of the failing command.
on_error() {
    local line="$1"
    local code="$2"
    log_err "Unexpected failure at line ${line} (exit code ${code})."
    log_err "Aborting cleanup to avoid leaving the repository in an inconsistent state."
    exit "${code}"
}

trap 'on_interrupt' SIGINT SIGTERM
trap 'on_error ${LINENO} $?' ERR

# -----------------------------------------------------------------------------
# UI: banner, warning box, usage
# -----------------------------------------------------------------------------

print_banner() {
    printf "${C_CYAN}"
    cat <<'EOF'
   ___                            ____  ____
  / _ | __ _____  ___  ___  ___  / __ \/ __/
 / __ |/ // / _ \/ _ \/ _ \/ _ \/ /_/ /\ \
/_/ |_|\_,_/_//_/\___/\___/_//_/\____/___/

EOF
    printf "${C_RESET}"
    printf "${C_BOLD}${C_WHITE}          AureonOS — Pre-Release Cleanup Utility${C_RESET}\n"
    printf "${C_WHITE}          Version %s${C_RESET}\n\n" "${SCRIPT_VERSION}"
}

print_warning_box() {
    local width=78
    local border
    border=$(printf '%*s' "${width}" '' | tr ' ' '#')

    printf "${C_BG_RED}${C_WHITE}${C_BOLD}\n"
    printf "%s\n" "${border}"
    printf "#%*s#\n" $((width - 2)) ""
    printf "#%*s%s%*s#\n" 20 "" "!!!  DESTRUCTIVE OPERATION WARNING  !!!" 19 ""
    printf "#%*s#\n" $((width - 2)) ""
    printf "%s\n" "${border}"
    printf "${C_RESET}${C_RED}${C_BOLD}\n"
    cat <<EOF

  This script will PERMANENTLY DELETE the following from:

      ${PROJECT_ROOT}

    - live-build output directories   (binary/ cache/ chroot/)
    - Final disk images                (*.iso, *.img, *.hybrid.iso)
    - live-build manifest files        (live-image-*.contents / .files / .packages,
                                         binary.modified_timestamps,
                                         chroot.files, chroot.packages.install,
                                         chroot.packages.live)
    - Log files                        (*.log)
    - Temporary and backup files       (*.tmp, *.temp, *.bak, *.swp, *~)
    - Any resulting empty directories left behind by the cleanup

  THIS ACTION CANNOT BE UNDONE.

  BACK UP any files you care about before continuing.
  Source code, .git/, .github/, auto/, config/, local/, build.sh, project
  documents (README, LICENSE, SECURITY, CHANGELOG, CONTRIBUTING, SUPPORTED,
  BUILD) and branding images (applications.png, desktop.png, lockscreen.png)
  are never touched by this script, but everything else listed above WILL
  be removed.

EOF
    printf "${C_RESET}"
}

print_usage() {
    cat <<EOF
${SCRIPT_NAME} (AureonOS Pre-Release Cleanup Utility) v${SCRIPT_VERSION}

USAGE:
    ./${SCRIPT_NAME} [OPTIONS]

DESCRIPTION:
    Cleans the AureonOS repository of generated build artifacts, ISO images,
    caches, logs, and temporary files before pushing to GitHub. Run this
    ONLY after a successful build, and only from the project root.

OPTIONS:
    --dry-run     Show exactly what would be removed without deleting
                  anything. Safe to run at any time.

    --force       Skip the interactive "YES" confirmation prompt.
                  Intended for use in CI/CD pipelines.

    --help        Display this usage information and exit.

EXAMPLES:
    ./${SCRIPT_NAME}               # Interactive cleanup with confirmation
    ./${SCRIPT_NAME} --dry-run     # Preview what would be deleted
    ./${SCRIPT_NAME} --force       # Non-interactive cleanup for CI/CD

EOF
}

# -----------------------------------------------------------------------------
# Argument parsing
# -----------------------------------------------------------------------------

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dry-run)
                DRY_RUN=true
                shift
                ;;
            --force)
                FORCE=true
                shift
                ;;
            --help|-h)
                print_banner
                print_usage
                exit 0
                ;;
            *)
                log_err "Unknown option: '$1'"
                print_usage
                exit 1
                ;;
        esac
    done
}

# -----------------------------------------------------------------------------
# Confirmation
# -----------------------------------------------------------------------------

confirm_action() {
    if [[ "${FORCE}" == true ]]; then
        log_warn "Running with --force: confirmation prompt skipped (CI/CD mode)."
        return 0
    fi

    if [[ "${DRY_RUN}" == true ]]; then
        log_info "Dry-run mode: no confirmation required, nothing will be deleted."
        return 0
    fi

    local reply
    printf "${C_BOLD}${C_YELLOW}Type exactly YES to proceed with permanent deletion: ${C_RESET}"
    read -r reply

    if [[ "${reply}" != "YES" ]]; then
        log_err "Confirmation not received. Aborting cleanup — no files were touched."
        exit 1
    fi

    log_ok "Confirmation received. Proceeding with cleanup."
}

# -----------------------------------------------------------------------------
# Environment / safety checks
# -----------------------------------------------------------------------------

# is_protected_path: returns 0 (true) if the given relative path (as produced
# by `find .`) falls under one of the PROTECTED_PATHS entries.
is_protected_path() {
    local candidate="$1"
    candidate="${candidate#./}"

    local protected
    for protected in "${PROTECTED_PATHS[@]}"; do
        if [[ "${candidate}" == "${protected}" || "${candidate}" == "${protected}/"* ]]; then
            return 0
        fi
    done
    return 1
}

# build_find_prune_args: builds the -not -path arguments used to exclude
# protected paths from `find` invocations. Centralised here so every removal
# function stays in sync with PROTECTED_PATHS.
build_find_prune_args() {
    local -a args=()
    local protected
    for protected in "${PROTECTED_PATHS[@]}"; do
        args+=( -not -path "./${protected}" -not -path "./${protected}/*" )
    done
    printf '%s\n' "${args[@]}"
}

check_git_installed() {
    if ! command -v git >/dev/null 2>&1; then
        log_err "git is not installed. Please install git and try again."
        exit 1
    fi
    log_ok "git is installed: $(git --version)"
}

check_project_root() {
    if [[ ! -d "${PROJECT_ROOT}/.git" ]]; then
        log_err "No .git directory found in '${PROJECT_ROOT}'."
        log_err "This script must be run from the root of the AureonOS git repository."
        exit 1
    fi

    # AureonOS project roots follow the standard live-build layout: a
    # config/ directory (build configuration) alongside an auto/ directory
    # (auto/config, auto/build, auto/clean helper scripts). This guards
    # against accidentally running the cleanup inside an unrelated repo.
    if [[ ! -d "${PROJECT_ROOT}/config" ]] || [[ ! -d "${PROJECT_ROOT}/auto" ]]; then
        log_err "This does not look like the AureonOS project root."
        log_err "Expected to find both 'config/' and 'auto/' directories alongside '.git/'."
        exit 1
    fi

    log_ok "Confirmed AureonOS project root: ${PROJECT_ROOT}"
}

check_live_build_installed() {
    if command -v lb >/dev/null 2>&1; then
        log_ok "live-build detected: $(command -v lb)"
        return 0
    fi
    log_warn "live-build ('lb') not found on PATH — skipping 'lb clean --purge'."
    return 1
}

run_preflight_checks() {
    log_step "Running pre-flight safety checks"
    check_git_installed
    check_project_root
}

# -----------------------------------------------------------------------------
# Size / counting helpers
# -----------------------------------------------------------------------------

# path_size_bytes: prints the size in bytes of a file or the total size of a
# directory tree. Falls back gracefully if `du` behaves unexpectedly.
path_size_bytes() {
    local target="$1"
    du -sb -- "${target}" 2>/dev/null | awk '{print $1}' || echo 0
}

# human_readable_size: converts a byte count into a human-friendly string.
human_readable_size() {
    local bytes="$1"
    numfmt --to=iec --suffix=B "${bytes}" 2>/dev/null || echo "${bytes}B"
}

# -----------------------------------------------------------------------------
# Cleanup: live-build
# -----------------------------------------------------------------------------

# run_live_build_clean:
#   `lb clean --purge` is live-build's own purge command and is the primary,
#   most reliable way to remove binary/, cache/, chroot/, and the
#   live-image-*.* / chroot.* manifest files it wrote. It is run first.
#
#   The explicit pattern- and directory-based removal steps later in main()
#   are NOT redundant: they act as a verified safety net that (a) still
#   cleans the repo correctly on machines where live-build isn't installed,
#   and (b) confirms via `find` that nothing generated was left behind, with
#   accurate counts/sizes for the final summary either way.
run_live_build_clean() {
    log_step "Live-build cleanup (primary purge via 'lb clean --purge')"

    if ! check_live_build_installed; then
        return 0
    fi

    if [[ "${DRY_RUN}" == true ]]; then
        log_info "[dry-run] Would run: lb clean --purge"
        return 0
    fi

    log_info "Running 'lb clean --purge' ..."
    if lb clean --purge; then
        log_ok "live-build cleaned successfully."
    else
        log_warn "'lb clean --purge' exited with a non-zero status; continuing cleanup."
    fi
}

# -----------------------------------------------------------------------------
# Cleanup: file patterns (ISO images, logs, temp files)
# -----------------------------------------------------------------------------

# remove_pattern_group:
#   $1 = human-readable label for status output
#   $2 = name of the counter variable to increment (nameref)
#   $3.. = glob patterns to match (e.g. "*.iso" "*.img")
#
# Finds every matching file under the project root (excluding protected
# paths), reports it, sums its size, and deletes it unless --dry-run is set.
remove_pattern_group() {
    local label="$1"
    local -n counter_ref="$2"
    shift 2
    local -a patterns=("$@")

    local -a name_args=()
    local pattern
    for pattern in "${patterns[@]}"; do
        if [[ ${#name_args[@]} -gt 0 ]]; then
            name_args+=( -o )
        fi
        name_args+=( -name "${pattern}" )
    done

    local -a prune_args
    mapfile -t prune_args < <(build_find_prune_args)

    local -a matches=()
    while IFS= read -r -d '' file; do
        matches+=("${file}")
    done < <(find . -type f "${prune_args[@]}" \( "${name_args[@]}" \) -print0 2>/dev/null)

    if [[ ${#matches[@]} -eq 0 ]]; then
        log_info "${label}: nothing to remove."
        return 0
    fi

    log_info "${label}: found ${#matches[@]} file(s)."

    local file size
    for file in "${matches[@]}"; do
        size=$(path_size_bytes "${file}")
        STAT_TOTAL_BYTES=$(( STAT_TOTAL_BYTES + size ))
        counter_ref=$(( counter_ref + 1 ))

        if [[ "${DRY_RUN}" == true ]]; then
            printf "  ${C_YELLOW}[dry-run] would remove:${C_RESET} %s (%s)\n" \
                "${file}" "$(human_readable_size "${size}")"
        else
            rm -f -- "${file}"
            printf "  ${C_GREEN}removed:${C_RESET} %s (%s)\n" \
                "${file}" "$(human_readable_size "${size}")"
        fi
    done
}

# -----------------------------------------------------------------------------
# Cleanup: build directories
# -----------------------------------------------------------------------------

remove_build_directories() {
    log_step "Removing build directories"

    local dir size
    for dir in "${BUILD_DIRS[@]}"; do
        if is_protected_path "${dir}"; then
            log_warn "Skipping '${dir}/' — listed as protected."
            continue
        fi

        if [[ ! -d "${PROJECT_ROOT}/${dir}" ]]; then
            log_info "${dir}/: not present, skipping."
            continue
        fi

        size=$(path_size_bytes "${PROJECT_ROOT}/${dir}")
        STAT_TOTAL_BYTES=$(( STAT_TOTAL_BYTES + size ))
        STAT_DIR_COUNT=$(( STAT_DIR_COUNT + 1 ))

        if [[ "${DRY_RUN}" == true ]]; then
            log_info "[dry-run] would remove directory: ${dir}/ ($(human_readable_size "${size}"))"
        else
            rm -rf -- "${PROJECT_ROOT:?}/${dir}"
            log_ok "Removed directory: ${dir}/ ($(human_readable_size "${size}"))"
        fi
    done
}

# -----------------------------------------------------------------------------
# Cleanup: leftover empty directories
# -----------------------------------------------------------------------------

remove_empty_directories() {
    log_step "Removing empty directories left behind by cleanup"

    if [[ "${DRY_RUN}" == true ]]; then
        log_info "[dry-run] skipping empty-directory pass (nothing was actually deleted yet)."
        return 0
    fi

    local -a prune_args
    mapfile -t prune_args < <(build_find_prune_args)

    # Run multiple passes: removing a leaf empty directory can turn its
    # parent into an empty directory too. Iterate until a pass finds none.
    local pass_removed=1
    while [[ "${pass_removed}" -gt 0 ]]; do
        pass_removed=0
        local -a empties=()
        while IFS= read -r -d '' dir; do
            empties+=("${dir}")
        done < <(find . -mindepth 1 -type d -empty "${prune_args[@]}" -print0 2>/dev/null)

        local dir
        for dir in "${empties[@]}"; do
            if is_protected_path "${dir}"; then
                continue
            fi
            rmdir -- "${dir}" 2>/dev/null && {
                STAT_DIR_COUNT=$(( STAT_DIR_COUNT + 1 ))
                pass_removed=$(( pass_removed + 1 ))
                log_ok "Removed empty directory: ${dir}"
            }
        done
    done
}

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------

print_summary() {
    local end_time elapsed
    end_time="$(date +%s)"
    elapsed=$(( end_time - START_TIME ))

    log_step "Cleanup summary"

    printf "${C_WHITE}"
    printf "  %-28s %s\n" "ISO / image files removed:" "${STAT_ISO_COUNT}"
    printf "  %-28s %s\n" "Log files removed:" "${STAT_LOG_COUNT}"
    printf "  %-28s %s\n" "Temporary files removed:" "${STAT_TMP_COUNT}"
    printf "  %-28s %s\n" "live-build manifests removed:" "${STAT_LIVEBUILD_COUNT}"
    printf "  %-28s %s\n" "Directories removed:" "${STAT_DIR_COUNT}"
    printf "  %-28s %s\n" "Total space reclaimed:" "$(human_readable_size "${STAT_TOTAL_BYTES}")"
    printf "  %-28s %ss\n" "Elapsed time:" "${elapsed}"
    printf "${C_RESET}\n"

    if [[ "${DRY_RUN}" == true ]]; then
        printf "${C_YELLOW}${C_BOLD}Dry-run complete — no files were actually deleted.${C_RESET}\n\n"
        return 0
    fi

    printf "${C_GREEN}${C_BOLD}✓ Cleanup completed successfully.${C_RESET}\n"
    printf "${C_WHITE}Recommended next step before committing:${C_RESET}\n"
    printf "  ${C_CYAN}git status${C_RESET}\n\n"
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

main() {
    parse_args "$@"

    print_banner
    print_warning_box

    run_preflight_checks
    confirm_action

    log_step "Starting cleanup at $(date '+%Y-%m-%d %H:%M:%S')"
    if [[ "${DRY_RUN}" == true ]]; then
        log_warn "DRY-RUN MODE ENABLED — no files or directories will be deleted."
    fi

    run_live_build_clean

    log_step "Removing generated ISO / image files"
    remove_pattern_group "ISO/image files" STAT_ISO_COUNT "${ISO_PATTERNS[@]}"

    log_step "Removing log files"
    remove_pattern_group "Log files" STAT_LOG_COUNT "${LOG_PATTERNS[@]}"

    log_step "Removing temporary and backup files"
    remove_pattern_group "Temporary files" STAT_TMP_COUNT "${TMP_PATTERNS[@]}"

    log_step "Removing live-build manifest files"
    remove_pattern_group "live-build manifest files" STAT_LIVEBUILD_COUNT "${LIVEBUILD_ARTIFACT_PATTERNS[@]}"

    remove_build_directories
    remove_empty_directories

    print_summary
}

main "$@"
