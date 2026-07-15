#!/bin/bash
# Set up SSH tunnel to robot via jump host, then verify connectivity.
# All connection params come from env vars — no hardcoded credentials.
#
# Required env:
#   AWR_JUMP_USER    jump host username (e.g. saglen)
#   AWR_JUMP_IP      jump host IP (e.g. 192.168.84.160)
#   AWR_JUMP_PASS    jump host password
#   AWR_ROBOT_IP     robot IP (e.g. 192.168.10.15)
#
# Forwards:
#   127.0.0.1:9094 → robot:9094 (eHMI WebSocket)
#   127.0.0.1:1995 → robot:1995 (HMI frontend)
#   127.0.0.1:2222 → robot:22   (SSH to robot)
#
# Usage:
#   export AWR_JUMP_USER=saglen AWR_JUMP_IP=192.168.84.160 AWR_JUMP_PASS=...
#   export AWR_ROBOT_IP=192.168.10.15
#   source scripts/ssh/ssh-tunnel.sh

set -e

CTL="${HOME}/.ssh/awr-tunnel.ctl"
SSH_ASKPASS_REAL="${SSH_ASKPASS:-$(dirname "$0")/ssh-askpass.sh}"

# Kill existing tunnel if any
if [ -S "$CTL" ]; then
  ssh -S "$CTL" -O exit saglen@placeholder 2>/dev/null || true
  sleep 1
fi

echo "=== 建立 SSH 隧道 ==="
echo "  跳板: ${AWR_JUMP_USER}@${AWR_JUMP_IP}"
echo "  机器人: ${AWR_ROBOT_IP}"
echo "  转发: 9094→eHMI, 1995→HMI, 2222→SSH"

export AWR_SSH_PASS="${AWR_JUMP_PASS}"
export SSH_ASKPASS="$SSH_ASKPASS_REAL" DISPLAY=dummy:0
setsid ssh -f -N -M -S "$CTL" \
  -o StrictHostKeyChecking=no \
  -o ExitOnForwardFailure=yes \
  -o ControlPersist=1800 \
  -o PreferredAuthentications=password \
  -o PubkeyAuthentication=no \
  -L 127.0.0.1:9094:${AWR_ROBOT_IP}:9094 \
  -L 127.0.0.1:1995:${AWR_ROBOT_IP}:1995 \
  -L 127.0.0.1:2222:${AWR_ROBOT_IP}:22 \
  "${AWR_JUMP_USER}@${AWR_JUMP_IP}"

sleep 1
echo "=== 隧道已建立 ==="
echo "  eHMI: 127.0.0.1:9094"
echo "  SSH:  ssh -p 2222 nvidia@127.0.0.1  (需要 AWR_ROBOT_PASS)"
echo "  关闭: ssh -S $CTL -O exit ${AWR_JUMP_USER}@${AWR_JUMP_IP}"