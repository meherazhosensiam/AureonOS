#!/bin/bash
set -e
set -o pipefail
set -u

# Use system-wide extension directory so all users can access them
EXT_BASE_DIR="/usr/share/gnome-shell/extensions"
mkdir -p "$EXT_BASE_DIR"

# Install gnome-extensions-cli
export PATH=$PATH:/root/.local/bin
pipx install gnome-extensions-cli --force

install_extension() {
    local extension_id=$1
    local extension_path="$EXT_BASE_DIR/$extension_id"
    
    echo "Installing $extension_id..."
    # Install globally using --system flag
    /root/.local/bin/gext -F install --system "$extension_id"
    
    # Compile schemas if they exist
    if [ -d "$extension_path/schemas" ]; then
        glib-compile-schemas "$extension_path/schemas"
    fi
}

extensions=(
    "accent-gtk-theme@brgvos" "accent-user-theme@brgvos" "accent-icons-theme@brgvos"
    "arcmenu@arcmenu.com" "blur-my-shell@aunetx" "ProxySwitcher@flannaghan.com"
    "customize-ibus@hollowman.ml" "dash-to-panel@jderose9.github.com"
    "network-stats@gnome.noroadsleft.xyz" "simple-weather@romanlefler.com"
    "lockkeys@vaina.lt" "tiling-assistant@leleat-on-github"
    "mediacontrols@cliffniff.github.com" "clipboard-indicator@tudmotu.com"
)

for ext in "${extensions[@]}"; do
    install_extension "$ext"
done
