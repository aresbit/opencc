#!/bin/bash
# SSH wrapper using SSH_ASKPASS for password auth.
# All connection params come from env vars — no hardcoded credentials.
#
# Required env:
#   AWR_SSH_PASS      password for the target host
#   SSH_ASKPASS       path to ssh-askpass.sh (or any askpass script)
# Optional env:
#   DISPLAY           default "dummy:0"
#
# Usage:
#   export AWR_SSH_PASS=<password>
#   export SSH_ASKPASS=scripts/ssh/ssh-askpass.sh DISPLAY=dummy:0
#   bash scripts/ssh/ssh-askpass-wrapper.sh user@host [command]

export DISPLAY="${DISPLAY:-dummy:0}"
exec setsid -w ssh \
  -o StrictHostKeyChecking=no \
  -o PreferredAuthentications=password \
  -o PubkeyAuthentication=no \
  "$@"