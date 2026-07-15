# AWR 应用包 & 固件镜像部署全流程实录

> 日期: 2026-07-03 | 目标板: NVIDIA Drive Thor (p3960-0010) | 操作人: AI Agent + 人类审核
> 构建: #9869 | 固件: thor_v5.2g → thor_v5.2h

---

## 环境拓扑

```
主机 (PC, 192.168.10.1)
  ├── USB 以太网 ──→ 开发板 (192.168.10.15)
  └── 公司内网 → 10.100.100.51:8080 (CI/CD HTTP 服务器)

开发板网络可达性:
  - 板子 → 10.100.100.51: 需要主机做 IP 转发 + NAT (见 1.1)
  - 主机 → 10.100.100.51: 直接可达
```

### 1.1 网络转发前置配置 (在主机上执行)

```bash
# 启用 IP 转发
sudo sysctl -w net.ipv4.ip_forward=1

# NAT 伪装 (假设 USB 网卡是 enx00e04c920692)
sudo iptables -t nat -A POSTROUTING -s 192.168.10.0/24 -j MASQUERADE
sudo iptables -A FORWARD -i enx00e04c920692 -j ACCEPT
sudo iptables -A FORWARD -o enx00e04c920692 -j ACCEPT

# 验证: 在板子上
curl -sI http://10.100.100.51:8080/ | head -1  # 应返回 HTTP/1.1 200 OK
```

### 1.2 SSH 免密 (可选，避免每次输密码)

```bash
# 创建密码提供脚本 (sudo 未安装 sshpass 时)
cat > /home/pc/ssh-pass.sh << 'SCRIPT'
#!/bin/bash
echo "nvidia"
SCRIPT
chmod +x /home/pc/ssh-pass.sh

# 每次 SSH 使用:
export SSH_ASKPASS=/home/pc/ssh-pass.sh
export DISPLAY=dummy:0
setsid ssh -o StrictHostKeyChecking=no nvidia@192.168.10.15 '<command>'
```

---

## 2. 下载前准备

### 2.1 确认服务器端文件

```bash
# 在主机上检查文件是否存在及大小
curl -sI "http://10.100.100.51:8080/gitlab-ci/2026/07/02/gitlab-ci-thor-awr-9869/awr_20260702_100429_release.run" | grep -i content-length
# Content-Length: 9835039845  (9.16 GB)

curl -sI "http://10.100.100.51:8080/gitlab-ci/Thor_Images/thor_v5.2h.tar.gz" | grep -i content-length
# Content-Length: 2902506701  (2.70 GB)
```

### 2.2 检查板子磁盘空间

```bash
setsid ssh -o StrictHostKeyChecking=no nvidia@192.168.10.15 '
echo "=== 磁盘空间 ==="
df -h /mnt/gaea/
# /dev/vblkdev80p1  177G   23G  146G  14% /mnt/dji/partitions/user
'
```

---

## 3. 下载大包和镜像

### 3.1 启动并行下载

```bash
setsid ssh -o StrictHostKeyChecking=no nvidia@192.168.10.15 '
# 大包 (9.16 GB)
cd /mnt/gaea/package
wget -c "http://10.100.100.51:8080/gitlab-ci/2026/07/02/gitlab-ci-thor-awr-9869/awr_20260702_100429_release.run" &

# 镜像 (2.70 GB)
cd /mnt/gaea/images
mkdir -p /mnt/gaea/images
wget -c "http://10.100.100.51:8080/gitlab-ci/Thor_Images/thor_v5.2h.tar.gz" &

wait
echo "下载完成"
'
```

### 3.2 监控下载进度 (在主机上)

```typescript
// 保存为 monitor-download.ts，用 bun run 执行
import { exec } from './builtins/shell.js';

const SSH = `export SSH_ASKPASS=/home/pc/ssh-pass.sh DISPLAY=dummy:0; setsid ssh -o StrictHostKeyChecking=no nvidia@192.168.10.15`;

async function ssh(cmd: string) {
  const r = await exec(`${SSH} '${cmd}'`, { timeout: 15000 });
  return r.stdout.trim();
}

function fmt(bytes: number) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}

const APP = '/mnt/gaea/package/awr_20260702_100429_release.run';
const IMG = '/mnt/gaea/images/thor_v5.2h.tar.gz';

let lastApp = 0, lastImg = 0;
console.log('监控下载进度...\n');

for (let i = 0; i < 40; i++) {  // 最多 20 分钟
  await new Promise(r => setTimeout(r, 30000));
  const appSize = parseInt(await ssh(`stat --format=%s ${APP} 2>/dev/null || echo 0`)) || 0;
  const imgSize = parseInt(await ssh(`stat --format=%s ${IMG} 2>/dev/null || echo 0`)) || 0;

  console.log(`[${((i+1)*0.5).toFixed(1)}min] APP=${fmt(appSize)} (+${fmt(appSize-lastApp)}) | IMG=${fmt(imgSize)} (+${fmt(imgSize-lastImg)})`);

  const wgets = await ssh('ps aux | grep "[w]get" | wc -l');
  if (wgets === '0') {
    console.log('下载完成!');
    break;
  }
  lastApp = appSize; lastImg = imgSize;
}
```

实际下载速度: ~18 MB/s (内网 HTTP)，大包约需 8-10 分钟，镜像约需 2-3 分钟。

---

## 4. 关键陷阱: 断点续传的 Garbage Bytes

### 4.1 问题

如果 `wget -c` 续传中断文件，本地文件可能**大于**服务器的 Content-Length。本次遇到的情况:

```bash
setsid ssh -o StrictHostKeyChecking=no nvidia@192.168.10.15 '
stat --format="本地: %s 字节" /mnt/gaea/package/awr_20260702_100429_release.run
stat --format="本地: %s 字节" /mnt/gaea/images/thor_v5.2h.tar.gz
'
# 本地比服务器多 ~1.6MB (大包) 和 ~261KB (镜像)
```

### 4.2 诊断

```bash
setsid ssh -o StrictHostKeyChecking=no nvidia@192.168.10.15 '
# 对比服务器 Content-Length
echo "服务器:"
curl -sI "http://10.100.100.51:8080/gitlab-ci/2026/07/02/gitlab-ci-thor-awr-9869/awr_20260702_100429_release.run" | grep content-length
curl -sI "http://10.100.100.51:8080/gitlab-ci/Thor_Images/thor_v5.2h.tar.gz" | grep content-length

echo "本地:"
stat --format="%s 字节: %n" /mnt/gaea/package/awr_20260702_100429_release.run /mnt/gaea/images/thor_v5.2h.tar.gz

# 验证镜像 gzip 完整性
gzip -t /mnt/gaea/images/thor_v5.2h.tar.gz
# 输出: decompression OK, trailing garbage ignored
# ↑ 确认有多余尾部数据
'
```

### 4.3 修复: 截断到正确大小

```bash
setsid ssh -o StrictHostKeyChecking=no nvidia@192.168.10.15 '
# 截断到服务器 Content-Length
truncate -s 9835039845 /mnt/gaea/package/awr_20260702_100429_release.run
truncate -s 2902506701 /mnt/gaea/images/thor_v5.2h.tar.gz

# 重新验证
gzip -t /mnt/gaea/images/thor_v5.2h.tar.gz && echo "镜像 OK" || echo "镜像损坏!"

# 验证大包文件头
head -1 /mnt/gaea/package/awr_20260702_100429_release.run
# #!/usr/bin/env bash  ← 正确的自解压脚本
'
```

---

## 5. 部署应用大包

### 5.1 执行自解压安装

大包是 bash 自解压脚本，内嵌 install.tar 和 MD5 校验文件。

```bash
setsid ssh -o StrictHostKeyChecking=no nvidia@192.168.10.15 '
cd /mnt/gaea/package
bash awr_20260702_100429_release.run 2>&1 | tee /tmp/deploy_app.log
'
```

**实际输出**:
```
检测到节点清理脚本，开始清理已有节点...
准备释放安装 payload 到: /mnt/gaea/package/.awr_20260702_100429_release.install.tar.payload.KNujc1
安装 payload 释放完成
启动解压脚本...
=== 开始处理压缩文件 ===
开始校验文件完整性...
✓ 文件完整性校验通过
开始解压文件...
pv 未安装，正在安装 pv
警告: pv 安装失败，将继续解压但不显示分片进度
清理历史中间产物...
解压外层安装包...
校验分片文件完整性...
并行解压分片文件，jobs=8...
✓ 解压完成到目录: /mnt/gaea/package
修改启动脚本的工作目录路径...
挂接 /apollo 到当前解压目录...
设置开机自启服务
Created symlink /etc/systemd/system/multi-user.target.wants/humanoid-startup.service
服务设置完成，需要重启生效
=== 所有操作完成 ===
```

### 5.2 验证

```bash
setsid ssh -o StrictHostKeyChecking=no nvidia@192.168.10.15 '
echo "=== /apollo 符号链接 ==="
ls -la /apollo
# /apollo -> /mnt/gaea/package/awr_20260702_100429_release_output/output

echo "=== 包内容 ==="
ls /mnt/gaea/package/awr_20260702_100429_release_output/output/ | head -20
# DEFAULT_CONFIG  awr_power_firmware  bazel-bin  cyber  data
# gaea.bashrc  modules  scripts  tools

echo "=== 服务状态 ==="
systemctl status humanoid-startup.service | head -5
# Active: active (running)

echo "=== mainboard 进程 ==="
ps aux | grep mainboard | grep -v grep | wc -l
# 6 个 mainboard 进程
'
```

---

## 6. 部署系统镜像 (固件)

### 6.1 解压镜像包

```bash
setsid ssh -o StrictHostKeyChecking=no nvidia@192.168.10.15 '
cd /mnt/gaea/images
tar xzf thor_v5.2h.tar.gz

echo "=== 解压内容 ==="
ls -lh thor_v5.2h/
# total 2.8G
# -rwxr-xr-x tars_flash                             (29K)
# -rw-rw-r-- thor_v5.2h_20260630_163106.img.gz       (2.8G, 压缩的 rootfs)
# -rw-rw-r-- thor_v5.2h_20260630_163106.img.gz.md5   (68B)

echo "=== MD5 校验 ==="
cd thor_v5.2h
md5sum -c thor_v5.2h_20260630_163106.img.gz.md5
# thor_v5.2h_20260630_163106.img.gz: OK
'
```

### 6.2 烧录到非活跃分区

`tars_flash` 脚本的工作流程:
1. 检测当前活动 slot (B)
2. 确定非活动 slot (A)
3. `pigz -cd img.gz | dd of=/dev/vblkdev80p9`
4. `switch_slot A`
5. `reboot`

**关键问题**: 脚本有交互式确认 `read -p "确认继续? [y/N]"`，但 `sudo -S` 会消耗全部 stdin。解决方案:

```bash
setsid ssh -o StrictHostKeyChecking=no nvidia@192.168.10.15 '
# 先验证 sudo 密码，缓存凭证 (5分钟内有效)
echo qwertqwert | sudo -S -v 2>/dev/null

# 然后直接管道传入确认
echo y | sudo /usr/local/bin/tars_flash -r /mnt/gaea/images/thor_v5.2h/thor_v5.2h_20260630_163106.img.gz 2>&1 | tee /tmp/flash.log
'
```

**实际输出 (成功)**:
```
[INFO] 检测可用工具...
[INFO]   DD: /mnt/ro/usr/bin/dd
[INFO]   MD5SUM: /mnt/ro/usr/bin/md5sum
[INFO]   PIGZ: pigz
[INFO]   ZEROFREE: zerofree
[INFO] 检测当前活动分区...
[OK] 当前活动分区: Slot B (/dev/vblkdev80p10)
[OK] 非活动分区:   Slot A (/dev/vblkdev80p9)
[INFO] 分区大小: 10.00GB (10737418240 bytes)
[INFO] ==========================================
[INFO] 恢复 ... -> Slot A
[INFO] ==========================================
[INFO] 验证 MD5 校验值...
[OK] MD5 校验通过: 2fa47316b91bf59c7581572505e66dc9
[INFO] 镜像大小: 2.8G
[INFO] 开始恢复...
...dd 进度 (10GB @ ~244 MB/s, 耗时 44 秒)...
[OK] 恢复完成!
[INFO] 准备切换到 Slot A 并重启...
[INFO] 执行: switch_slot A
Success to switch to SLOT_A, do reset to take effect
[OK] Slot 切换成功 -> Slot A
[WARN] 系统将在 5 秒后重启...
[INFO] 正在重启...
```

### 6.3 等待板子恢复

```bash
# 监控板子是否恢复在线
echo "等待板子重启..."; for i in $(seq 1 30); do
  sleep 5
  if ping -c1 -W2 192.168.10.15 >/dev/null 2>&1; then
    echo "板子在线! ($((i*5))秒)"
    break
  fi
done
# 实际: 10 秒即恢复
```

### 6.4 验证新固件

```bash
setsid ssh -o StrictHostKeyChecking=no nvidia@192.168.10.15 '
cat /etc/tars_fw_version | head -1
# thor_v5.2h  ✅
'
```

---

## 7. 关键: Slot 切换后的恢复操作

**为什么会出问题**: 烧录新镜像 → 切换 slot → rootfs 是全新的。以下内容全部丢失:
- `/apollo` 符号链接
- `/usr/local/bin/humanoid_start_up.sh`
- `/etc/systemd/system/humanoid-startup.service`

### 7.1 完整恢复流程

```bash
setsid ssh -o StrictHostKeyChecking=no nvidia@192.168.10.15 '
# === Step 1: 重建 /apollo 符号链接 ===
sudo ln -sfn /mnt/gaea/package/awr_20260702_100429_release_output/output /apollo
# 注意: 包名 awr_YYYYMMDD_HHMMSS_release_output 因构建而异

# === Step 2: Source 环境 ===
cd /apollo
source gaea.bashrc
# 输出:
# ==============================
# GAEA_env: [prod]
# CYBER_PATH: [.../cyber]
# CYBER_DOMAIN_ID: [80]
# ==============================

# === Step 3: 复制启动脚本到系统路径 ===
sudo cp /apollo/scripts/humanoid/humanoid_start_up.sh /usr/local/bin/
sudo chmod +x /usr/local/bin/humanoid_start_up.sh

# === Step 4: 安装并启动 systemd 服务 ===
sudo cp /apollo/scripts/humanoid/humanoid-startup.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now humanoid-startup.service

# === Step 5: 验证 ===
sleep 5
systemctl status humanoid-startup.service tars-executor.service | grep Active
# Active: active (running) for both
ps aux | grep mainboard | grep -v grep | wc -l
# 6 个进程
'
```

---

## 8. 最终状态快照

```bash
setsid ssh -o StrictHostKeyChecking=no nvidia@192.168.10.15 '
echo "固件: $(cat /etc/tars_fw_version | head -1)"
echo "Slot:  $(df / | tail -1 | awk '\''{print $1}'\'')"
echo "内核: $(uname -r)"
echo "/apollo: $(readlink /apollo)"
echo "服务: humanoid=$(systemctl is-active humanoid-startup) tars-executor=$(systemctl is-active tars-executor)"
echo "磁盘: $(df -h /mnt/dji/partitions/user/ | tail -1 | awk '\''{print $4" 可用 / "$2" 总量"}'\')"
'
```

| 项目 | 最终值 |
|------|--------|
| 固件 | **thor_v5.2h** |
| 应用包 | **awr build #9869** (2026-07-02) |
| 活跃 Slot | **A** (/dev/vblkdev80p9) |
| 内核 | 6.1.119-rt45-prod-rt-tegra |
| /apollo | → `awr_20260702_100429_release_output/output` |
| humanoid-startup | active (6 mainboard 进程) |
| tars-executor | active (端口 8765) |
| 可用空间 | ~116 GB |

---

## A. 快速命令索引

```bash
# === SSH 连接 ===
export SSH_ASKPASS=/home/pc/ssh-pass.sh DISPLAY=dummy:0
SSH="setsid ssh -o StrictHostKeyChecking=no nvidia@192.168.10.15"

# === 下载 ===
$SSH 'cd /mnt/gaea/package && wget -c "http://10.100.100.51:8080/gitlab-ci/2026/07/02/gitlab-ci-thor-awr-9869/awr_20260702_100429_release.run"'
$SSH 'cd /mnt/gaea/images && wget -c "http://10.100.100.51:8080/gitlab-ci/Thor_Images/thor_v5.2h.tar.gz"'

# === 修复断点续传 ===
$SSH 'truncate -s $(curl -sI "URL" | grep content-length | awk "{print \$2}" | tr -d "\r") /path/to/file'
$SSH 'gzip -t /mnt/gaea/images/thor_v5.2h.tar.gz'  # 验证镜像

# === 部署应用包 ===
$SSH 'cd /mnt/gaea/package && bash awr_20260702_100429_release.run'

# === 烧录镜像 ===
$SSH 'echo qwertqwert | sudo -S -v && echo y | sudo /usr/local/bin/tars_flash -r /mnt/gaea/images/thor_v5.2h/thor_v5.2h_20260630_163106.img.gz'

# === Slot 切换后恢复 ===
$SSH 'sudo ln -sfn /mnt/gaea/package/awr_*_output/output /apollo && cd /apollo && source gaea.bashrc'
$SSH 'sudo cp /apollo/scripts/humanoid/humanoid_start_up.sh /usr/local/bin/ && sudo chmod +x /usr/local/bin/humanoid_start_up.sh'
$SSH 'sudo cp /apollo/scripts/humanoid/humanoid-startup.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now humanoid-startup.service'
```

---

## B. 错误速查

| 症状 | 原因 | 解决 |
|------|------|------|
| `gzip: trailing garbage ignored` | 断点续传引发尾部多余字节 | `truncate -s <Content-Length> <file>` |
| `systemctl: Unit not found` | Slot 切换后服务文件丢失 | 重新安装 service 文件 |
| systemctl status=203/EXEC | `ExecStart` 脚本路径不存在 | 复制脚本到 `/usr/local/bin/` |
| `/apollo: No such file` | Slot 切换后符号链接丢失 | `ln -sfn <path> /apollo` |
| `read -p` 确认被跳过 | `sudo -S` 消耗 stdin | 先 `sudo -v` 缓存，再单独管道确认 |
| `Permission denied (publickey,password)` | SSH 无终端无法输密码 | 使用 `SSH_ASKPASS` + `setsid` |
