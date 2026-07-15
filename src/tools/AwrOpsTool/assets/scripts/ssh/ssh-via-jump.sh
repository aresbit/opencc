#!/bin/bash
# Execute a command on the robot via the jump host.
# All connection params come from env vars — no hardcoded credentials.
#
# Required env:
#   AWR_JUMP_USER    jump host username (e.g. saglen)
#   AWR_JUMP_IP      jump host IP (e.g. 192.168.84.160)
#   AWR_JUMP_PASS    jump host password
#   AWR_ROBOT_USER   robot username (e.g. nvidia)
#   AWR_ROBOT_IP     robot IP (e.g. 192.168.10.15)
#   AWR_ROBOT_PASS   robot password
#
# Usage:
#   source scripts/ssh/ssh-via-jump.sh "command to run on robot"

set -e

SSH_ASKPASS_REAL="${SSH_ASKPASS:-$(dirname "$0")/ssh-askpass.sh}"

if [ -z "${1:-}" ]; then
  # Interactive shell on robot
  export AWR_SSH_PASS="${AWR_JUMP_PASS}"
  export SSH_ASKPASS="$SSH_ASKPASS_REAL" DISPLAY=dummy:0
  setsid -w ssh \
    -o StrictHostKeyChecking=no \
    -o PreferredAuthentications=password \
    -o PubkeyAuthentication=no \
    "${AWR_JUMP_USER}@${AWR_JUMP_IP}" \
    "export AWR_SSH_PASS='${AWR_ROBOT_PASS}' SSH_ASKPASS=/tmp/ssh-askpass-robot.sh DISPLAY=dummy:0; echo '${AWR_ROBOT_PASS}' > /tmp/ssh-askpass-robot.sh && chmod +x /tmp/ssh-askpass-robot.sh; setsid -w ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no ${AWR_ROBOT_USER}@${AWR_ROBOT_IP}"
else
  export AWR_SSH_PASS="${AWR_JUMP_PASS}"
  export SSH_ASKPASS="$SSH_ASKPASS_REAL" DISPLAY=dummy:0
  setsid -w ssh \
    -o StrictHostKeyChecking=no \
    -o PreferredAuthentications=password \
    -o PubkeyAuthentication=no \
    "${AWR_JUMP_USER}@${AWR_JUMP_IP}" \
    "export AWR_SSH_PASS='${AWR_ROBOT_PASS}' SSH_ASKPASS=/tmp/ssh-askpass-robot.sh DISPLAY=dummy:0; echo '${AWR_ROBOT_PASS}' > /tmp/ssh-askpass-robot.sh && chmod +x /tmp/ssh-askpass-robot.sh; setsid -w ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no ${AWR_ROBOT_USER}@${AWR_ROBOT_IP} '$1'"
fi