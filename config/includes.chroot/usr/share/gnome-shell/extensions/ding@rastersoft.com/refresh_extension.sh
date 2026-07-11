#!/bin/sh

DINGUBUNTU=0
DING=0
if [ -d ~/.local/share/gnome-shell/extensions/dingubuntu@rastersoft.com ]; then
        DINGUBUNTU=1
fi
if [ -d ~/.local/share/gnome-shell/extensions/ding@rastersoft.com ]; then
        DING=1
fi

if [ ${DINGUBUNTU} = "1" ]; then
        ./ubuntu_install.sh
fi
if [ ${DING} = "1" ]; then
        ./local_install.sh
fi
./kill.py
