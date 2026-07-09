#!/bin/bash
# Automatically clean up temporary files
find /tmp -type f -atime +30 -delete
find /var/tmp -type f -atime +30 -delete
rm -rf /home/*/.cache/*
