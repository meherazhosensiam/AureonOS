# Supported Versions

This document describes which versions of **AUREON OS** are currently supported and eligible for updates.

## Release Policy

AUREON OS follows a version-based release model. Security updates, bug fixes, and maintenance are provided only for supported releases.

## Supported Versions

| Version | Status        | Security Updates | Bug Fixes |
| ------- | ------------- | ---------------- | --------- |
| 1.x     | ✅ Supported   | ✅ Yes            | ✅ Yes     |
| < 1.0   | ❌ Unsupported | ❌ No             | ❌ No      |

## End of Support

A release reaches **End of Support (EOS)** when:

* A newer major version replaces it.
* It is no longer actively maintained.
* It depends on an unsupported upstream Debian release.

Unsupported versions will not receive:

* Security updates
* Bug fixes
* Feature updates
* Official support

Users are encouraged to upgrade to the latest supported release.

## Upstream Dependencies

AUREON OS is based on **Debian**. Support for individual packages also depends on their upstream maintainers. Some components may receive updates directly from Debian repositories.

## Development Builds

Development builds, nightly builds, and pre-release versions are intended for testing only.

These versions:

* May contain unfinished features
* May contain known bugs
* Are not recommended for production use
* Do not receive guaranteed support

## Reporting Issues

If you encounter a bug in a supported version:

1. Ensure you are using the latest available updates.
2. Search existing GitHub Issues before creating a new report.
3. Include your AUREON OS version, hardware details, and steps to reproduce the issue.

## Upgrade Recommendation

For the best experience, always use the latest supported version of AUREON OS.

---

*Last updated: July 2026*
