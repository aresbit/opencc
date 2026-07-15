#!/bin/bash
# Generic SSH_ASKPASS script — reads password from AWR_SSH_PASS env var.
# Usage: export AWR_SSH_PASS=<password> SSH_ASKPASS=scripts/ssh/ssh-askpass.sh DISPLAY=dummy:0
echo "${AWR_SSH_PASS}"