# ST 测试端到端复现 SOP(eHMI 脚本驱动)

> 目标:不开浏览器,用 `scripts/ehmi/ehmi_client.py` 复现整条 ST 测试
> (绑定→地图→锁精定位→recipe→打点→黄金模板→点位验证→标定质检→轨迹生成→执行 job)。
> 本文是"明天能不能只靠 awr-ops 复现"的权威答案 + 可复制粘贴的命令序列。

---

## 结论:明天能否仅靠 awr-ops 复现?

**后端交互链路(WS/REST)已 100% 脚本化在 skill 里,可复现。** 但有三类边界:

| | 能否纯脚本复现 | 说明 |
|---|:---:|---|
| 绑定机器人 / 绑地图 / 锁精定位 / 建 recipe | ✅ | 命令齐备,板载可验证 |
| 轨迹生成(单条/全部)/ 执行 job | ✅ | job 已修成三步序列(见下) |
| 标定 / 质检 的**触发** | ✅ | `calibrate`/`quality-check` |
| 去人工打点(拖手臂)、黄金模板 app 扫码、点位验证精修、标定质检**摆位** | ❌ | 天生人工,脚本无法替代 |
| 机器人硬件健康(力传感器、无故障态) | ⚠️ 只能诊断不能修 | 见 §5 |

**因此:**
- **复用一个已完成的 recipe**(status=11,已含 wiring + 黄金模板,如 `1841 refined_thhb_imported`)→ 跳过全部人工步骤 → **后端链路可纯脚本一键复现**。
- **全新 recipe 从零打点** → 打点/黄金模板/点位验证/标定摆位**必须人工**,不可纯脚本复现。
- 前提:机器人硬件健康(力传感器 .20/.21 可达、无 `LOAD_ERROR 20002`)。不健康时脚本只能诊断,需重启/物理处理。

---

## 0. 访问 & 前置

### 0.1 SSH 隧道(每次会话先做;ControlPersist 会过期,断了重建)

所有连接参数通过环境变量注入，**无硬编码**：

```bash
# 配置环境变量 (按实际机器修改)
export AWR_JUMP_USER=saglen AWR_JUMP_IP=192.168.84.160 AWR_JUMP_PASS=111111
export AWR_ROBOT_USER=nvidia AWR_ROBOT_IP=192.168.10.15 AWR_ROBOT_PASS=nvidia

# 一键建立隧道 (9094→eHMI, 1995→HMI, 2222→SSH)
bash scripts/ssh/ssh-tunnel.sh

# 通过跳板在机器人上执行命令
bash scripts/ssh/ssh-via-jump.sh "ls /apollo/data/trajectories/"

# 隧道过期时手动重建:
export AWR_SSH_PASS="${AWR_JUMP_PASS}" SSH_ASKPASS=$(realpath scripts/ssh/ssh-askpass.sh) DISPLAY=dummy:0
setsid ssh -f -N -M -S ~/.ssh/awr-tunnel.ctl -o StrictHostKeyChecking=no \
  -o ControlPersist=1800 -o PreferredAuthentications=password -o PubkeyAuthentication=no \
  -L 127.0.0.1:9094:${AWR_ROBOT_IP}:9094 \
  -L 127.0.0.1:1995:${AWR_ROBOT_IP}:1995 \
  ${AWR_JUMP_USER}@${AWR_JUMP_IP}
```
所有 eHMI 命令都对 `127.0.0.1` 跑(经隧道)。

### 0.2 硬件健康前置(不过则 job 必失败,先修)
```bash
# 力传感器可达(插接必需)
ssh -p 2222 nvidia@127.0.0.1 'ping -c1 -W1 192.168.10.20 && ping -c1 -W1 192.168.10.21'   # 左/右, 都要通
# 无故障态(20002=LOAD_ERROR)
ssh -p 2222 nvidia@127.0.0.1 'grep -rhE "error code: 200" /apollo/data/log/ | tail -3'
```
力传感器断连 / 20002 → 通常挪动机器人导致,需**重启相关服务**恢复;脚本层面 `clear-alarm` 只能清软告警,传感器网络不可达要物理处理。

### 0.3 环境确认
```bash
python3 ehmi_client.py 127.0.0.1 status      # HMI/9094 通, 拿 serial
ssh -p 2222 nvidia@127.0.0.1 'ps aux|grep -c "[m]ainboard"; curl -s -o /dev/null -w "%{http_code}" http://localhost:1995/'
```

---

## 1. 全流程步骤表

`脚本`=可 eHMI / `人工`=必须人手 / `前置`=硬件或状态门槛。命令均省略 `python3 ehmi_client.py 127.0.0.1`。

| # | 步骤 | 类型 | 命令 / 说明 | 板载确认关键字 |
|---|------|:---:|------|------|
| 0 | 大包部署 + start_awr.sh | 脚本/SSH | SSH 跑 `start_awr.sh`(y/y);或 `launcher` START_PIPELINE | — |
| 1 | 绑定机器人 | 脚本 | `rebind agent72` | `ADD TO WORKSPACE` |
| 2 | 保存/绑定地图 | 脚本 | `bindmap board188 THHB agent72` | `OnBindRequest`+`operation_map published`+`ReloadMap` |
| 3 | 锁精定位 | 脚本 | `AWR_DEVICE_ID=188 ... lock <recipe_id> <wire_id>` | `mode = 15 ... execute_task` |
| 4 | 新建 recipe | 脚本 | `recipe-create <name> 188`(op_map 自动解析) | — |
| 5 | 去人工打点(拖手臂扫描) | **人工** | 生成 wiring 数据 | — |
| 6 | 黄金模板配置(app 扫码绑 kit) | **人工** | — | — |
| 7 | 点位验证 / 精修 | **人工** | — | — |
| 8 | 标定质检 | 半自动 | 人工摆位 → `calibrate <4\|7\|10\|13> [arm]` / `quality-check <154..157> [arm]` | `handeye_validate success` |
| 9 | 轨迹生成 | 脚本 | `AWR_DEVICE_ID=188 ... single-traj <wire_id> <recipe_id>` 或 `gen-traj <recipe_id>`(从线束3起,1/2不生成) | `TrajMgmtService action=1x` |
| 10 | 执行 job | 脚本 | `AWR_DEVICE_ID=188 ... start-job <recipe_id> <起始wire_id> 0` | `load verify`+`is_cruise_load_over SUCCESS`+`Trajectory replay submitted` |

---

## 2. 纯脚本 Happy Path(复用已完成 recipe,跳过 §5-7 人工)

复用 status=11 的完成 recipe,可从头到尾脚本跑通。以本机(agent72 / board188 / DEVICE_ID 188 / recipe 1841)为例:

```bash
export AWR_DEVICE_ID=188
IP=127.0.0.1; CLI="python3 ehmi_client.py $IP"

# 1. 硬件健康(见 §0.2),必须先通过

# 2. 绑定 + 地图
$CLI rebind agent72
$CLI bindmap board188 THHB agent72

# 3. 查该 recipe 的线束 id(wire_id 是 DB id 不是序号!)
#    GET /wireInfo/getList?recipe_id=1841&page_size=0  → 线束3=30103 ... 线束14=30114

# 4. 锁精定位(需 recipe + 一个 wire)
$CLI lock 1841 30103

# 5. 轨迹生成 — ⚠️ 串行！每条线束必须逐个生成并确认完成后才能继续下一条
#    每条线束生成 3 个 _joint.npz 文件(init_to_load / organize_and_connection / exit_poses)
#    确认命令: ls -aln /apollo/data/trajectories/*_joint.npz | grep -E "线束n"
#    必须等 3 个文件全部出现后才能继续生成下一条线束！
#    逐条生成(线束3..14, wire_id 30103..30114):
$CLI single-traj 30103 1841
#    ssh nvidia@192.168.10.15 'ls -aln /apollo/data/trajectories/*_joint.npz | grep -E "线束3"'
#    确认 3/3 → 继续下一条
$CLI single-traj 30104 1841
#    ... 逐条确认到 30114

# 6. 执行 job — ⚠️ 只需触发一次！
#    start-job 从起始线束触发后，机器人会自动执行后续所有线束的插接。
#    不要每条线束都发一次 start-job！如果从线束4开始但没有线束4的轨迹会报错。
#    确保起始线束的轨迹已存在，然后只发一次：
$CLI start-job 1841 30103 0
#    如果中途某条线束失败，从该线束重新触发即可:
#    $CLI start-job 1841 30110 0   (例如从线束10继续)
```

> **标定质检**若要跑:人工把手臂/标定板摆到位后
> `$CLI calibrate 7 0`(鱼眼手眼左手)/ `$CLI quality-check 155 0`,四类相机组 × 左右手(见 ehmi-protocol.md)。

---

## 3. 关键参数速查(本机;换机需重查)

| 参数 | 值 | 怎么查 |
|------|-----|------|
| agent 序列号 | 72 | `agents` / `/aw_robot_status` field3 |
| 操作地图 | board188(或 board142) | 设置页 / `opmap-list` |
| **DEVICE_ID / workspace_id** | **188**(=board名去 board 前缀) | ≠ agent serial! `AWR_DEVICE_ID=188` |
| op_map_id | board188→132 / board142→86 | `recipe_create` 自动解析 |
| nav_map_id | 6 | — |
| recipe(完成态) | 1841 refined_thhb_imported status=11 | `recipe-list 188` |
| **wire_id** | 线束3=30103 … 线束14=30114 | **DB id 非序号**; `/wireInfo/getList?recipe_id=&page_size=0` |
| 力传感器 | 左 192.168.10.20:502 / 右 .21:502 | ping / force_sensor 日志 |

---

## 4. 执行 Job = 三步序列(2026-07-14 血泪,少一步机械臂不动)

前端 `jobPage.vue` `handleStartClick→handleAction(START_JOB)` 的后端序列,`start_job()` 已复刻:
1. `REQUEST_DATABASE`(ROBOT_MODE **154** / MAINTAIN,recipe_id)—— 同步数据库到机器人。
2. `START_JOB`(ACTION **22** / JOB,recipe_id,wire_id=起始线束,start_job_type)—— 建行为树,此时 `load` 节点**等待**。
3. `LOAD_VERIFY`(ACTION **26** / JOB,同参)—— 确认上料 → `is_cruise_load_over` SUCCESS → `async_trajectory_executor` 提交 `init_to_load_start_pose_线束N` → 机械臂开动。

只发 START_JOB(缺 1、3)= 建好树但不动。`start_job(sync=True, load_verify=True)` 默认三步全做。
> 前端中间还有 Recipe自检 / 端子校验 / **二次确认弹框(物料/布线)**——人工安全门,脚本由调用方负责已确认。

---

## 5. 故障诊断合集(今天真实踩过)

| 症状 | 根因 | 处理 |
|------|------|------|
| job `is_accepted=1` 但机械臂不动、树只建不 tick | 缺 `LOAD_VERIFY`(上料确认) | 用 `start-job`(已含三步)或补发 `action LOAD_VERIFY` |
| `load` 节点 FAILURE,停在初始姿态 | `cruise robot is in error state 20002`(LOAD_ERROR)+ 力传感器 .20/.21 断连(errno113) | 挪机器人致断连;**重启服务**恢复,`clear-alarm` 清软告警 |
| `affordance_info ... has not received`(每10s) | 空闲噪声(该 topic 插接时才有生产方) | **不是** job 不动的原因,忽略 |
| 轨迹生成 `is_accepted=1` 但没文件 | 后台运动规划耗时;看 `/arm_planner/generate_joint_trajectory/goal_feedback` 索引在涨=在跑 | 等到 `线束14_*_joint.npz` 出现 |
| lock/job workspace 用了 72 | DEVICE_ID(188)≠serial(72) | `AWR_DEVICE_ID=188` |
| wire "线束3" 传了 3 | wire_id 是 DB id | 用 30103 |
| 轨迹/标定 mode 用错(138/139) | 轨迹走 ROBOT_MODE(10/11/12/13),标定 150-153,不是 ACTION | 已在 `ehmi_client.py` 对齐 |
| 隧道断(命令 ConnectionRefused 9094) | ControlPersist 过期 | 重建隧道(§0.1) |
| 手眼质检 50s 超时但其实通过 | 手眼两阶段 ~55s | `quality_check` 已按 mode 放宽到 120s |
| start-job 报错/机械臂不动 | 起始 wire_id 的轨迹不存在 | 先确认 `ls /apollo/data/trajectories/*_joint.npz \| grep 线束N` 有 3 个文件 |
| 逐条 start-job 导致重复执行 | 只需触发一次，机器人自动执行后续线束 | 从起始线束发一次 start-job 即可，中途失败才从该线束重新触发 |

**板载确认通用**:进板子 `grep -rhE "<关键字>" /apollo/data/log/`(glog `W20260714...` 级,`-rhE` 别用 `-o`),关键字见 §1 表 + ehmi-protocol.md「板载验证」。

---

## 相关
- 协议 + 命令全表 + 板载验证:`ehmi-protocol.md`
- 施工规范(把前端操作写成脚本):`ehmi-scripting-guide.md`
- 客户端:`scripts/ehmi/ehmi_client.py`(命令见 `python3 ehmi_client.py` 无参输出)
