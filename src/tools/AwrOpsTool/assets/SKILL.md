---
name: awr-ops
description: Thor 开发板应用包和固件部署操作。当你需要刷大包(.run)、刷镜像(thor_vX.Xx)、切换 A/B slot、恢复部署后服务、rsync 高速传输、板子间中继传输、部署后E2E验证(锁精定位/recipe创建/HMI远程控制)、或抢占机器人快速验证闭环时使用。触发词: "部署到 thor", "刷大包", "刷镜像", "deploy to thor", "flash thor", "awr deploy", "烧录固件", "rsync 传输", "快速验证", "抢机器人", "上真机", "板子间传输", "relay", "部署后验证", "锁精定位", "ehmi", "HMI控制", "recipe创建", "ops.md", "冒烟测试", "gate1"。
---

# AWR Ops — Thor Board 全生命周期部署与验证

## 安全规则 (Safety Rules)

### 规则 1: 质检必须依次执行

标定质检 (quality-check, mode 154/155/156/157) **必须串行执行**，即：
- 前一项质检完全结束并返回结果 (PASS/FAIL/TIMEOUT) 后，才能下发下一项
- **禁止**使用 `for` 循环一次性连续下发多条质检命令
- **禁止**在未收到上一项结果前就下发下一项

```python
# ❌ 错误: for 循环批量下发质检
for mode in [154, 155, 156, 157]:
    await run_qc(mode)  # 没有等待结果就发下一个

# ✅ 正确: 逐项等待结果后再下发下一项
result = await run_qc(154)  # 等待 154 完成
if result.get('passed') is not None:
    result = await run_qc(155)  # 再发 155
```

### 规则 2: 机器人操作指令高度安全优先级

对机器人的所有操作指令（包括但不限于：锁精定位、标定、质检、启动作业、轨迹生成、复位、归零等）属于**高风险操作**，必须遵守：
- **只能通过调用 `scripts/ehmi/` 目录下的已有脚本命令来执行**，使用脚本提供的命令行参数
- **禁止**生成新的 Python 脚本或临时代码直接通过 WebSocket 操作机器人
- **如果确实需要生成新脚本，必须先获得人类确认后才能执行**

```bash
# ✅ 正确: 使用已有脚本 + 命令行参数
python3 scripts/ehmi/ehmi_client.py 192.168.10.15 quality-check 154
python3 scripts/ehmi/ehmi_client.py 192.168.10.15 lock

# ❌ 错误: 生成新的 py 脚本直接操作机器人
python3 -c "
import asyncio, websockets
async def main():
    ws = await websockets.connect('ws://192.168.10.15:9094')
    # ... 直接下发指令
"
```

违反以上规则可能导致：机器人异常动作、机械臂碰撞、硬件损坏或人员伤害。

---

## 快速决策树

```
测试同学给你 IP
  ├── 需要新编译？
  │     └── 优先板载编译 (aarch64 原生) ← 不要用 x86_64 容器产物给测试!
  │           1. 在板子上 cd /mnt/dji/partitions/user/gaea/repo && source gaea.bashrc
  │           2. env BAZEL_SH=/bin/bash bash scripts/apollo_build.sh -o dummy --config=gpu --config=nvidia <模块>
  │           3. 打包: PACKAGE_NAME=awr_$(date +%Y%m%d_%H%M%S)_release; echo "AWR" > ${PACKAGE_NAME}.txt
  │           4. bash scripts/apollo_install.sh "${PACKAGE_NAME}"
  │           5. 产物: ${PACKAGE_NAME}.run
  ├── 需要传输 .run 到板子？
  │     ├── 从自己板子 → 测试板子: 三跳中继传输 (PC 中转)
  │     │     bash scripts/awr-relay-transfer.sh <run> --to susan@192.168.85.183 --to-pass 777888
  │     ├── 从 PC → 测试板子: rsync daemon 跳板传输
  │     │     bash scripts/awr-rsync-transfer.sh --jump susan@192.168.85.183 --jump-pass 777888 <run>
  │     └── 小文件 (<1G): scp
  └── 部署
        └── bash xxx.run → 观察日志 → 闭环
```

## 板载编译 (优先，aarch64 原生)

**重要**: 不要用 x86_64 容器编译产物部署到 aarch64 板子。容器编译出的 `mainboard` 是 x86_64 ELF，板子无法执行。

### 板载编译环境

板子已配置好编译环境，直接编译：

```bash
ssh thor
cd /mnt/dji/partitions/user/gaea/repo && source gaea.bashrc

# 编译全部 C++ 模块
env BAZEL_SH=/bin/bash bash scripts/apollo_build.sh -o dummy --config=gpu --config=nvidia \
  ts_bridge awr_bridge cyber common_msgs ts_common_msgs ts_quickdata ts_collect \
  awr_common awr_qualitycheck awr_control ts_hmi common awr_envcheck

# 打包
PACKAGE_NAME="awr_$(date +%Y%m%d_%H%M%S)_release"
echo "AWR Release - $(date)" > ${PACKAGE_NAME}.txt
bash scripts/apollo_install.sh "${PACKAGE_NAME}"
# 产物: ${PACKAGE_NAME}.run (7-10GB)
```

### 编译环境关键修复

板载编译需要的环境调整（已配置好）：
- `/.dockerenv` 文件（绕过 Docker 检测）
- CUDA 头文件 (`/usr/local/cuda/include/`)
- cuDNN 头文件 (`/usr/include/cudnn*.h`)
- TensorRT 头文件 (`/usr/include/NvInfer*.h`)
- CUDA 库 stubs 和 symlinks
- `BAZEL_SH=/bin/bash` 环境变量

### 已知限制

以下模块需要 aarch64 Python wheels（open3d, torch, curobo），目前无法板载编译：
- `awr_workflow` (需 torch, open3d, numpy, curobo)
- `awr_icp` (需 open3d)
- `ts_e2e` (需 ML 包)
- `ts_visualization` (需 foxglove-sdk)

---

## 三跳中继传输: 自己板子 → PC → 测试板子

当你在自己板子上编译好了 .run，需要传给测试同学的板子：

```
用户板子 (192.168.10.15) ─USB─→ 用户PC (中继) ─WiFi─→ 测试PC ─USB─→ 测试板子
```

```bash
cd /home/pc/yyscode/work/thor_workspace/deployment/scripts
bash awr-relay-transfer.sh <run文件> --to susan@192.168.85.183 --to-pass 777888
```

如果 .run 文件在本地 PC 上（不是板子上），用：
```bash
bash awr-rsync-transfer.sh --jump susan@192.168.85.183 --jump-pass 777888 <run文件>
```

---

## 板载部署

```bash
ssh thor
cd /mnt/dji/partitions/user/gaea/repo
sudo bash awr_*.run
# 重启服务
sudo systemctl restart humanoid-startup
# 检查
systemctl status humanoid-startup
ps aux | grep mainboard | grep -v grep
journalctl -u humanoid-startup -f
```

---

## 裸 TCP 传输优化 (待实施)

裸 TCP 跳过 rsync 协议和 SSH 加密开销，打满千兆带宽：

```bash
# 接收端 (板子)
nc -l -p 9000 | pv -s 7G > /mnt/dji/partitions/user/gaea/package/file.run

# 发送端 (PC)
dd if=file.run bs=64M | pv -s 7G | nc <板子IP> 9000
```

配合 AVX-512 加速校验：
```bash
# 传输后两端分别计算 checksum
gcc -O3 -mavx512f -mavx512dq -o avx512_checksum avx512_checksum.c
./avx512_checksum file.run  # 理论吞吐 20-40 GB/s
```

---

## SSH 连接模式

所有连接参数通过环境变量注入，**不硬编码用户名、IP、密码**：

| 环境变量 | 说明 | 示例 |
|----------|------|------|
| `AWR_JUMP_USER` | 跳板用户名 | `saglen` |
| `AWR_JUMP_IP` | 跳板 IP | `192.168.84.160` |
| `AWR_JUMP_PASS` | 跳板密码 | `111111` |
| `AWR_ROBOT_USER` | 机器人用户名 | `nvidia` |
| `AWR_ROBOT_IP` | 机器人 IP | `192.168.10.15` |
| `AWR_ROBOT_PASS` | 机器人密码 | `nvidia` |

脚本已内置在 `scripts/ssh/` 目录下：

| 脚本 | 用途 | 依赖环境变量 |
|------|------|------|
| `scripts/ssh/ssh-askpass.sh` | SSH_ASKPASS 密码提供 | `AWR_SSH_PASS` |
| `scripts/ssh/ssh-askpass-wrapper.sh` | 密码认证 SSH 连接 | `AWR_SSH_PASS`, `SSH_ASKPASS`, `DISPLAY` |
| `scripts/ssh/ssh-tunnel.sh` | 建立 SSH 隧道 (9094/1995/2222) | `AWR_JUMP_*`, `AWR_ROBOT_IP` |
| `scripts/ssh/ssh-via-jump.sh` | 通过跳板在机器人上执行命令 | 全部 6 个 |

```bash
# 配置环境变量 (按实际情况修改)
export AWR_JUMP_USER=saglen AWR_JUMP_IP=192.168.84.160 AWR_JUMP_PASS=111111
export AWR_ROBOT_USER=nvidia AWR_ROBOT_IP=192.168.10.15 AWR_ROBOT_PASS=nvidia

# 方式 A: 建立隧道 (推荐 — eHMI 用)
bash scripts/ssh/ssh-tunnel.sh
# 然后 eHMI 命令直连 127.0.0.1:9094

# 方式 B: 通过跳板在机器人上执行命令
bash scripts/ssh/ssh-via-jump.sh "ls /apollo/data/log/"

# 方式 C: 直连 (免密)
ssh thor

# 方式 D: 手动 SSH_ASKPASS (隧道过期时重建)
export AWR_SSH_PASS="${AWR_JUMP_PASS}" SSH_ASKPASS=$(realpath scripts/ssh/ssh-askpass.sh) DISPLAY=dummy:0
setsid ssh -f -N -M -S ~/.ssh/awr-tunnel.ctl -o StrictHostKeyChecking=no \
  -o ControlPersist=1800 -o PreferredAuthentications=password -o PubkeyAuthentication=no \
  -L 127.0.0.1:9094:${AWR_ROBOT_IP}:9094 ${AWR_JUMP_USER}@${AWR_JUMP_IP}
```

## 板子间传输 (三跳中继)

```bash
# 从自己板子传到测试板子 (PC 自动中继)
bash scripts/awr-relay-transfer.sh <run> --to susan@192.168.85.183 --to-pass 777888

# 从 PC 传到测试板子
bash scripts/awr-rsync-transfer.sh --jump susan@192.168.85.183 --jump-pass 777888 <run>
```

## 部署应用大包

应用大包是 bash 自解压脚本，执行后自动完成解压、校验、/apollo 链接、服务安装。

**前置条件**: 磁盘空间 ≥ 50GB 空闲（解压需要）。

```bash
# 部署前先确认磁盘空间
ssh thor
df -h /mnt/dji/partitions/user             # 确认 ≥50GB 可用

# 如果空间不足，只清理当前不需要的旧解压目录（保留 .run 文件）
cd /mnt/dji/partitions/user/gaea/package
ls -d *_output *_release_output 2>/dev/null  # 先看有哪些旧目录
# 手动指定要删除的旧目录名，不要用通配符 rm -rf

# 部署
sudo bash awr_*.run
sudo systemctl restart humanoid-startup
```

**部署后验证**:
```bash
systemctl status humanoid-startup    # Active: active (running)
ps aux | grep mainboard | grep -v grep | wc -l  # 应 ≥6
journalctl -u humanoid-startup -f    # 观察日志
```

## 部署系统镜像 (thor_vX.Xx.tar.gz)

系统镜像是完整的 rootfs 镜像，通过 tars_flash 写入非活跃 A/B 分区。

步骤:
1. cd /mnt/gaea/images && tar xzf thor_vX.Xx.tar.gz
2. cd thor_vX.Xx && md5sum -c *.md5
3. 先 `echo qwertqwert | sudo -S -v` 缓存 sudo 凭证
4. `echo y | sudo /usr/local/bin/tars_flash -r <img.gz 路径>` — 关键: sudo -S 会消耗 stdin，必须先 -v 再单独管道 y
5. 板子自动切换 slot 并重启
6. 等待 10-30 秒板子恢复在线
7. **必须执行 slot 切换后恢复** (见下节)

## Slot 切换后的恢复

烧录新镜像 → slot 切换 → rootfs 是全新的。以下均丢失，必须重建:

1. `/apollo` 符号链接 → `sudo ln -sfn /mnt/gaea/package/awr_*_output/output /apollo`
2. `cd /apollo && source gaea.bashrc` 加载环境
3. `/usr/local/bin/humanoid_start_up.sh` → `sudo cp /apollo/scripts/humanoid/humanoid_start_up.sh /usr/local/bin/ && sudo chmod +x`
4. systemd 服务 → `sudo cp /apollo/scripts/humanoid/humanoid-startup.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now humanoid-startup`
5. 验证: systemctl status humanoid-startup tars-executor, ps aux | grep mainboard (应≥6个进程)

## 关键路径

| 路径 | 用途 |
|------|------|
| `/mnt/dji/partitions/user/gaea/repo/` | 源码 + 编译产物 |
| `/mnt/dji/partitions/user/gaea/package/` | .run 大包 |
| `/mnt/gaea/package/` | 部署后解压目录 |
| `/apollo` | → 部署目录符号链接 |
| `/etc/tars_fw_version` | 固件版本 |
| `scripts/awr-relay-transfer.sh` | 三跳中继传输 |
| `scripts/awr-rsync-transfer.sh` | 跳板 rsync 传输 |
| `scripts/awr-quick-deploy.sh` | 传输+部署全流程 |

## 常见陷阱

| 陷阱 | 症状 | 修复 |
|------|------|------|
| x86_64 容器产物给板子 | Exec format error | 板载编译，不要用容器产物 |
| 板子磁盘不足 | 解压失败 "可用空间不足 50G" | 清理旧 .run 和旧解压目录 |
| wget -c 续传尾部垃圾 | 文件 > Content-Length, gzip 报 trailing garbage | truncate -s <正确字节数> <文件> |
| sudo -S 吃 stdin | tars_flash 的 read -p 被跳过 | 先 sudo -v 再 echo y \| sudo ... |
| slot 切换后 /apollo 丢失 | ls: cannot access '/apollo' | ln -sfn <路径> /apollo |
| humanoid-startup status=203 | ExecStart 脚本不存在 | cp 脚本到 /usr/local/bin/ |
| rsync daemon 端口被占 | Failed to bind port 873 | `sudo kill $(cat /var/run/rsyncd.pid)` |
| 板子时钟不准 | apt update 报 Release invalid | `date -s "YYYY-MM-DD HH:MM:SS"` |
| 强制"逐条 start-job" | robot 自动执行后续线束，重复触发会报错/混乱 | 只需从起始线束发一次 start-job，中途失败才从失败线束重新触发 |
| 从无轨迹的线束 start-job | 机械臂不动/报错 | 先确认 `ls /apollo/data/trajectories/*_joint.npz \| grep 线束N` 有 3 个文件 |
| 轨迹生成用 gen-traj 一次全下 | 实际是异步的，需要逐条确认 | 用 single-traj 逐条生成，每条确认 3 个 npz 文件后再继续下一条 |

---

## 部署后 E2E 验证 (ops.md Checklist)

大包部署完成后，按 `ops.md` 流程执行验证。**优先使用 eHMI WebSocket 远程控制**，无需打开浏览器。

### 架构说明

HMI 有两套通信通道：

```
HMI 前端 (Vue.js, :1995)
  ├── WS protobuf → ws://<robot>:9094  (ROS Bridge — 实时控制)
  │   协议: apollo.ts_awr_bridge.Json (proto2) over binary WebSocket
  │   用途: 订阅状态、发送原子指令(锁精定位/标定/轨迹/Job)
  └── REST API → https://awr-backend-test.tars-ai.com/api (云端 — 数据持久化)
      用途: Recipe CRUD、设备配置、操作地图
```

详细协议参考: `references/ehmi-protocol.md`

### Step 1-2: 环境确认 + 节点启动

```bash
# 通过跳板 SSH 到机器人
ssh -J saglen@<测试机IP> nvidia@192.168.10.15

# 确认 Apollo 路径
ls -la /apollo
cd /apollo && source gaea.bashrc
echo $CYBER_PATH  # 应指向当日大包

# 确认节点
ps aux | grep mainboard | grep -v grep | wc -l  # ≥6
curl -s -o /dev/null -w "%{http_code}" http://localhost:1995/  # 200
```

### Step 3-5: 绑定状态 + 地图 + 坐标检查

使用 eHMI Python 客户端（通过 WebSocket protobuf）：

```bash
# 方式 A: 在机器人本地运行 (推荐，无需处理跳板网络)
python3 scripts/ehmi/ehmi_client.py 127.0.0.1 status

# 方式 B: 从 PC 远程运行
python3 scripts/ehmi/ehmi_client.py 192.168.10.15 status
```

输出示例:
```
Board: 142  State: ?  IsBound: True
```

**这步验证了**: 机器人绑定状态(is_bound=1)、板号(board142)、HMI 通信正常。

### Step 6-7: 锁精定位 (远程执行)

```bash
python3 scripts/ehmi/ehmi_client.py 192.168.10.15 lock
```

输出:
```
Accepted: True  → TC-04 PASS
```

**原理**: 通过 `/aw_task_manager_service` WebSocket RPC 发送 `AwRobotServiceRequest{mode=15, scenario=2}`。
- mode=15: LOCK_PRECISION_POSITIONING
- scenario=2: MAINTAIN
- 返回值 is_accepted=1 表示锁精定位已接受

**注意**: 锁精定位前需确保 Maintain 页面已选择 Recipe 和 Wire。若未选择，可通过 cloud API 获取 recipe id 并在 service request 中带上 `recipe_id` 和 `wire_id`。

### Step 8: 创建 Recipe (远程执行)

```bash
python3 scripts/ehmi/ehmi_client.py 192.168.10.15 recipe-create "109#0713"
```

**原理**: 调用云端 REST API `POST /recipe/create` 创建空白 recipe。
- 关键: 后端 schema 比前端 TypeScript 类型宽松，`op_map_id` 和 `nav_map_id` 可在创建时直接传入
- **op_map_id 按板不同**: board142→86, board188→132。`recipe_create` 已改为按 device 自动解析(`resolve_op_map`)，别硬编码。
- 创建后 recipe 状态为 0 (draft)，HMI Maintain 页面可看到

**注意**: 不要导入其他 recipe 的 wiring config！新 recipe 是空白的，wiring 数据在后续"去人工打点"过程中生成。

> ⚠ 反复踩的坑(详见 `references/ehmi-protocol.md`「板载验证 & 真机经验」):
> - **DEVICE_ID/workspace_id ≠ agent serial**: board188→DEVICE_ID 188, agent 序列号 72; 绑定/锁精/recipe 的 workspace_id 用 DEVICE_ID。
> - **wire_id 是线束 DB id 不是序号**: recipe 1820 线束1..14 → id 30003..30016; "从线束3" = wire_id 30005。先 `GET /wireInfo/getList?recipe_id=&page_size=0` 查。
> - **板载确认**(排除客户端自嗨): 进机器人 shell grep `/apollo/data/log/`: 绑机器人看 `ADD TO WORKSPACE`, 绑地图看 `OnBindRequest`+`operation_map published`+`ReloadMap`, 锁精定位看 `mode = 15 ... execute_task`, 用 request_id/参数+时间戳对账。
> - **map provision**: `/mnt/gaea/map/<board>` 有目录→秒成, 无→发 `provision_required` 需选板型解压 zip。

### Gate-1 判定

以上全部通过后输出:

```
[Gate-1 Ready]
  ✅ Apollo 路径指向当日 Daily
  ✅ 关键节点 Running (mainboard ≥6)
  ✅ HMI 可访问 (HTTP 200)
  ✅ 已绑定 board142 / THHB (is_bound=1)
  ✅ 锁精定位成功 (is_accepted=1)
  ✅ Recipe 已创建
→ 进入 Phase B: 人工去打点 + 黄金模板 + 点位验证
```

### eHMI 客户端命令参考

| 命令 | 功能 |
|------|------|
| `status` | 查看机器人绑定状态、板号 |
| `lock` | 执行锁精定位 (TC-04) |
| `recipe-list` | 列出 device 142 的所有 recipe |
| `recipe-create <name>` | 创建空白 recipe |
| `gate1` | 执行 Gate-1 全部检查 |
| `help` | 帮助 |

### 从 PC 远程运行 eHMI 脚本

eHMI 脚本需要 Python websockets 库。如果 PC 能直连机器人 9094 端口，直接运行:

```bash
pip3 install websockets
python3 scripts/ehmi/ehmi_client.py 192.168.10.15 <command>
```

如果 PC 不能直连（需要通过跳板），通过 base64 + SSH 上传到机器人本地运行:

```bash
# 1. 编码脚本
B64=$(base64 scripts/ehmi/ehmi_client.py | tr -d '\n')

# 2. 通过跳板 SSH 执行
ssh -J saglen@<测试机IP> nvidia@192.168.10.15 \
  "echo '$B64' | base64 -d > /tmp/ehmi.py && python3 /tmp/ehmi.py 127.0.0.1 <command>"
```

### 常见问题

| 症状 | 原因 | 修复 |
|------|------|------|
| is_accepted=0 | 未选 Recipe/Wire | 先通过 cloud API 查 recipe id，在 service request 中带 recipe_id |
| WebSocket 连接拒绝 | ROS bridge 未启动 | 检查 `/pkg/app/start-rosbridge.sh` 是否执行 |
| recipe create 返回 success 但查不到 | device_id 未传或格式不对 | device_id 必须是 string 类型 `"142"` |
| 锁精定位后坐标仍跳动 | 需要手动微调精定位先 | 先执行 mode=155 (MANUAL_MAKER_LOCAL)，再锁 |

## 参考文档

- 构建流程: `~/.claude/skills/awr-build.md`
- 部署实录: `references/awr-ops-deploy-guide.md`
- **⭐ ST 测试端到端复现 SOP(命令序列 + 能否纯脚本复现的结论): `references/st-test-sop.md`**
- **HMI 协议详解: `references/ehmi-protocol.md`**
- **eHMI 脚本化施工规范(前端操作→py 脚本,给执行 agent): `references/ehmi-scripting-guide.md`**
- **eHMI 客户端: `scripts/ehmi/ehmi_client.py`**