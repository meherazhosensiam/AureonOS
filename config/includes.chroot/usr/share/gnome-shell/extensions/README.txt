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
