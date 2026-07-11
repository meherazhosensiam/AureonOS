#!/bin/bash

PREFIX=/usr

sudo rm -rf ${PREFIX}/share/gnome-shell/extensions/ding@rastersoft.com/*
rm -rf .build
mkdir .build
meson setup --prefix=${PREFIX} .build
ninja -C .build
sudo ninja -C .build install
rm -rf .build
