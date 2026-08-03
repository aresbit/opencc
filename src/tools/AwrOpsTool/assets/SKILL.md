---
name: awr-ops
description: Thor 开发板应用包和固件部署操作。当你需要刷大包(.run)、推模块小包(.run 单模块覆盖)、刷镜像(thor_vX.Xx)、切换 A/B slot、恢复部署后服务、rsync 高速传输、板子间中继传输、部署后E2E验证(锁精定位/recipe创建/HMI远程控制)、或抢占机器人快速验证闭环时使用。触发词: "部署到 thor", "刷大包", "推小包", "部署小包", "module .run", "刷镜像", "deploy to thor", "flash thor", "awr deploy", "烧录固件", "rsync 传输", "快速验证", "抢机器人", "上真机", "板子间传输", "relay", "部署后验证", "锁精定位", "ehmi", "HMI控制", "recipe创建", "ops.md", "冒烟测试", "gate1"。
---

# AWR Ops — Thor Board 全生命周期部署与验证

## 安全规则 (Safety Rules)

### 规则 1: 质检必须依次执行

标定质检 (quality-check, mode 154/155/156/157) **必须串行执行**，即：
- 前一项质检完全结束并返回结果 (PASS/FAIL/TIMEOUT) 后，才能下发下一项
- **禁止**使用 `for` 循环一次性连续下发多条质检命令
- **禁止**在未收到上一项结果前就下发下一项

**标定质检标准流程 (先质检 → 不通过再标定 → 再质检)**:

```
QC mode → passed=True? → ✅ 下一项
        → passed=False? → calibrate 重新标定 → 再 QC → 下一项
```

**重要**: 不要 QC 不通过就直接跳过或放弃，必须先重新标定再质检。标定是解决问题的途径。

**左手/右手顺序**: 完成左手四个项目 (check_type 4/7/10/13, arm=0) 的质检标定后，再开始右手 (arm=1)。

```python
# ✅ 正确: 逐项等待结果后再下发下一项，不通过则标定后重试
result = await run_qc(154, arm=0)  # 等待 154 完成
if not result.get('passed'):
    await run_calibrate(4, arm=0)   # 重新标定
    result = await run_qc(154, arm=0)  # 再质检
result = await run_qc(155, arm=0)  # 再发 155
```

### 规则 2: 机器人操作指令高度安全优先级

对机器人的所有操作指令（包括但不限于：锁精定位、标定、质检、启动作业、轨迹生成、复位、归零等）属于**高风险操作**，必须遵守：
- **只能通过调用 `scripts/ehmi/` 目录下的已有脚本命令来执行**，使用脚本提供的命令行参数
- **禁止**生成新的 Python 脚本或临时代码直接通过 WebSocket 操作机器人
- **如果确实需要生成新脚本，必须先获得人类确认后才能执行**

```bash
# ✅ 正确: 使用已有脚本 + 命令行参数
python3 scripts/ehmi/ehmi_client.py 127.0.0.1 quality-check 154
python3 scripts/ehmi/ehmi_client.py 127.0.0.1 lock <recipe_id> <wire_id>

# ❌ 错误: 生成新的 py 脚本直接操作机器人
python3 -c "
import asyncio, websockets
async def main():
    ws = await websockets.connect('ws://192.168.10.15:9094')
    # ... 直接下发指令
"
```

### 规则 3: 机器人运行时操作禁止 sudo

在 nvidia 机器人上，**运行时/应用层操作**（解压部署大包 `.run`、起 AWR 节点 `start_awr.sh`、跑 ehmi 脚本、执行 job 等）**禁止用 sudo 执行**，必须直接以 nvidia 用户运行。用 sudo 会让产物/进程归属 root，破坏运行环境。

- ✅ `bash awr_*.run`（解压大包，不加 sudo）
- ✅ `bash /apollo/scripts/humanoid/start_awr.sh`（起节点，不加 sudo）
- ❌ `sudo bash awr_*.run` / `echo pass | sudo -S bash start_awr.sh`

**例外（确实需要 root 的系统管理操作，不在此规则）**：`tars_flash` 烧录镜像、`sudo systemctl restart/enable` systemd 服务、写入 `/usr/local/bin`·`/etc/systemd/system`·`/apollo` 符号链接、`apt-get install`、`sysctl/iptables`、`nvidia-ctk` 等。

违反以上规则可能导致：机器人异常动作、机械臂碰撞、硬件损坏或人员伤害。

---

## tibai ST 现场规则 (2026-07)

这些规则来自 `tibai-edge` 前端/后端和真机 ST 联调，后续复用 eHMI 脚本做确定性机器人控制软件时优先遵守。

### eHMI 命令只考虑端侧执行

当前 ST / DAG 中所有 `{ehmi}` 命令都按**端侧执行**处理：通过 SSH 到板上，在机器人本地运行同一份 `ehmi_client.py`，并连接 `127.0.0.1:9094`。

```bash
# 推荐: SSH 到板上后本地执行 eHMI
python3 /tmp/tibai-ehmi_client.py 127.0.0.1 agents
python3 /tmp/tibai-ehmi_client.py 127.0.0.1 recipe-list <device_id>
python3 /tmp/tibai-ehmi_client.py 127.0.0.1 recipe-create auto <device_id>
```

原因：PC 侧直连 `192.168.10.x:9094` 可能 TCP 可达但 WebSocket opening handshake 超时；端侧 `127.0.0.1:9094` 已验证稳定。不要为 ST 临时改成云端 REST 或 PC 直连 WS。只读页面可以调用 Go/REST 展示数据，但“eHMI 命令执行”一律按板上脚本执行。

### 配置与启动脚本

- `tibai-edge` 调试默认使用项目根配置：`~/yystest/tibai/configs/config.yaml`，不要误用 `edge/configs/config.yaml` 或 `/etc` 下旧配置。
- 修改 YAML 后必须重启 `tibai-edge daemon --config ~/yystest/tibai/configs/config.yaml`，前端 ST 页面才会重新加载。
- `start_awr.sh -y --auto` 默认 recipe 类型是 `THD30`，但现场常用 THHB；`--recipe-type` 只能是 `THD30|THHB|C134|WAIC|AIO`，不能传 `auto`。
- ST YAML 默认 `wire_type` 使用 `THHB`，人工确认后可覆盖。

### board / robot / recipe 关系

- robot 和 board 是弱绑定，board 和 recipe 是强绑定。
- `agent` 是 HMI robot serial；`device_id` 是 board id。二者不能混用。
- recipe 列表和 recipe 创建必须按已选择的 `device_id` 查询/创建。
- `map_name` 默认应是 `board<device_id>`，例如 `board142`，不要用 agent serial。当 `bindmap` 返回 `provision_required` 且名字是 `board142` 这类值时，才表示真缺地图素材，需要人工选择 `pattern` (`AIO|LZY_TH|OP`) 做 provision。

### 轨迹生成与 start-job 队列语义

- 轨迹生成默认从线束 3 开始，但 UI/脚本必须支持人工选择，例如 `4` 或 `4 6 7`。
- 轨迹生成有队列含义：必须等线束 4 生成完成并验证轨迹文件后，才能下发线束 6；再等 6 完成后下发 7。禁止并发下发多条 `single-traj`。
- 线束序号不等于 DB `wire_id`。先用 `wireInfo/getList` 查映射，再把实际 `wire_id` 传给 `single-traj` / `start-job`。
- `start-job` 也要支持选择从第几根线束开始，但只下发一次起始线束；机器人会自动执行后续线束。中途失败恢复时，才从失败线束重新触发。

### 日志校验规则

- 不要在 `{board_log}` 全目录宽泛 grep 历史 `error code: 200`，会命中过期日志或命令回显。
- `20002` 验证只看当前活动日志目录 `double_orin`、近 60 分钟、真实 glog ERROR 行：

```bash
find {board_log}/double_orin -type f -mmin -60 -name '*.log*' -print0 2>/dev/null \
  | xargs -0 grep -haE '(^|\x1b\[[0-9;]*m)E[0-9]{8} .*error code: 20002' 2>/dev/null \
  | wc -l
```

- 回初始姿态 `safe-pose` 校验要直接验证 `mode = 110`，不要只 tail `JOINT_MOVE|joint_values` 后再在上一条输出中找 `mode = 110`。

---

## 节点重启

当用户说"节点挂了"/"重启节点"/"节点起不来"时，执行以下步骤：

### 1. 优先读脚本确认参数

`start_awr.sh` 有交互式选择，**必须先读脚本确认当前支持的选项**，然后让人确认线束类型：

```bash
# 查看脚本支持的 recipe 类型选项
grep -A10 'select_and_set_recipe_type' /apollo/scripts/humanoid/start_awr.sh | head -20
```

脚本的交互式选择项（`-y` 时的默认值）：
| # | 选择项 | 默认值 | 说明 |
|---|--------|:---:|------|
| 1 | recipe 类型 | **THD30** | 1=THD30 2=THHB 3=C134 4=WAIC 5=AIO |
| 2 | 部署地区 | shanghai | shanghai / suzhou |
| 3 | 标定码类型 | charuco | charuco / aruco |
| 4 | pose 模型 | T (TH) | T(TH) / LZY |
| 5 | 外接盘挂载 | 跳过 | 数据录制用 |

**重要**: `-y` 默认 recipe 类型是 THD30，但机器人实际线束可能是 THHB。**必须让人确认后再启动**。

### 2. 让人确认线束类型

```bash
# 先问人: "这台机器人的线束类型是? 1=THD30 2=THHB 3=C134 4=WAIC 5=AIO"
# 人确认后，用对应类型启动
```

### 3. 执行启动

```bash
# 先 source gaea 环境
cd /apollo && source gaea.bashrc
# 再启动节点 (推荐自动模式 -y，加 --recipe-type 指定线束)
bash /apollo/scripts/humanoid/start_awr.sh -f --skip-coredump --region shanghai -y --auto --recipe-type THHB 2>&1
```

**注意**：
- 直接以 nvidia 用户执行，不加 sudo（加 sudo 会破坏运行环境，见规则 3）
- `--recipe-type` 必须指定，否则默认 THD30 可能与实际硬件不匹配
- 重启后验证：`ps aux | grep mainboard | grep -v grep | wc -l` 应 ≥6
- 如果重启失败，检查 `journalctl -u humanoid-startup -f` 查看错误日志

---

## 轨迹生成: 必须先查询实际线束列表

**重要**: 每个 recipe 的 wire_id 不同，**绝对不能假设默认值** (如 30103-30114 仅适用于 recipe 1841)。轨迹生成前必须先查询实际线束列表。

```bash
# 1. 查询 recipe 的实际线束列表
curl -s 'https://awr-backend-test.tars-ai.com/api/wireInfo/getList?recipe_id=<recipe_id>&page_size=0' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); [print(f'wire_id={w[\"id\"]}  name={w.get(\"wire_name\",\"?\")}') for w in d.get('data',d) if isinstance(w,dict) and 'id' in w]" 2>/dev/null

# 2. 确认线束 5 对应的 wire_id 后再生成轨迹
# 3. 逐条生成: single-traj <实际wire_id> <recipe_id>
```

**常见陷阱**: 线束编号 ≠ wire_id。线束5 在 recipe 2004 中 wire_id=31499，而在 recipe 1841 中 wire_id=30105。**永远先查再生成**。

### 板载确认轨迹文件（重要）

**轨迹文件命名使用连接器 ID 而非 wire_id**，不能用 `grep <wire_id>` 来确认。正确方式：

```bash
# 1. 先用线束名称（线束N）确认，不能用 wire_id（30112 等）
ls /apollo/data/trajectories/*_joint.npz | grep '线束12'

# 2. 每条线束必须有 3 个 npz 文件：
#    - init_to_load_start_pose_*_线束N_joint.npz
#    - organize_and_connection_start_pose_*_线束N_joint.npz
#    - exit_poses_*_线束N_joint.npz

# 3. 确认命令示例
ls /apollo/data/trajectories/ | grep '线束12' | grep '_joint.npz'
```

---

## ST 测试报告 (report.md)

**每次 ST 测试必须在当前测试目录生成 `report.md`**，每条指令执行后立即追加结果，形成可追溯的验证 checklist。

### 报告格式

```markdown
# ST 测试报告 — <board> / <recipe> / <日期>

| # | 步骤 | 状态 | 结果/详情 | 时间 |
|---|------|:---:|------|------|
| 1 | 绑定机器人 | ✅ | agent72 bound, is_bound=1 | 14:30:01 |
| 2 | 绑定地图 | ✅ | board188 THHB, operation_map published | 14:30:15 |
| 3 | 锁精定位 | ✅ | is_accepted=1 | 14:30:32 |
| ... | ... | ... | ... | ... |
```

### 规则

- **每条指令执行完立即 `append` 进 `report.md`**，不要等到最后一次性写入
- 每行包含：**步骤编号、步骤名、状态 (✅/❌/⚠️)、关键结果详情、时间戳**
- 失败步骤用 `❌` 标记，并在详情中附上错误信息和日志路径
- 需要人工介入的步骤 (打点/扫码/摆位) 用 `⏸️` 标记，等待人类确认后更新为 `✅`

### 质检 (QC) 详细数据要求

质检操作 (`quality-check`, mode 154/155/156/157) **不能只输出 pass/fail**，必须把详细数据写入 report.md：

```markdown
| 8 | 质检 mode=155 (鱼眼手眼左手) | ✅ | overall_std_mm=0.24mm (<1.5mm), validate_success=True, 耗时 48s | 14:45:10 |
| 9 | 质检 mode=154 (鱼眼双目) | ❌ | std=2.3mm (≥1.5mm), task_id=xxx, 重新标定后通过 | 14:46:30 |
```

**QC 各模式通过标准**:

| mode | 名称 | 判定来源 | 通过标准 |
|------|------|----------|----------|
| 154 | 鱼眼双目 | stereo_validation_report (field 2) | report 存在且非空 |
| 155 | 鱼眼手眼 | handeye_validation_report (field 3) | validate_success=1 **且 overall_std_mm < 1.5mm** |
| 156 | 内窥镜双目 | stereo_validation_report (field 2) | report 存在且非空 |
| 157 | 鱼眼左目→内窥镜左目 | fisheye_pinhole_left (field 4) | report 存在且非空 |

**QC 详细数据必须包含**：
- `std` 值 (标准差，单位 mm) 和阈值 (1.5mm，仅 mode=155)
- `validate_success` / 各校验项逐项结果
- 耗时
- 失败时附上 `task_id` 和日志路径，方便后续排查

**标定各模式 (calibrate)**:

| check_type | 名称 | mode | 说明 |
|------------|------|------|------|
| 4 | 鱼眼双目 | 150 | 左手 arm=0，右手 arm=1 |
| 7 | 鱼眼手眼 | 151 | 左手 arm=0，右手 arm=1 |
| 10 | 内窥镜双目 | 152 | 左手 arm=0，右手 arm=1 |
| 13 | 鱼眼左目→内窥镜左目 | 153 | 左手 arm=0，右手 arm=1 |

**左手/右手完整流程**:
1. 先完成左手 (arm=0) 四个 check_type 的 质检→标定→质检 循环
2. 再完成右手 (arm=1) 四个 check_type 的 质检→标定→质检 循环
3. 每个 check_type 的 QC 通过后才进入下一个

---

## ST 参数发现流程

### 核心原则

**不写死站点参数，通过"发现 -- 展示 -- 确认"逐步确定。**

每次 ST 测试的机器人、板子、线束、recipe 都不同，参数必须动态发现，不能硬编码默认值。流程是：agent 自动发现候选参数 -- 展示给人类 -- 人类确认后继续。

### 需要发现的参数

| 参数 | 说明 | 示例 |
|------|------|------|
| `robot_ip` | 机器人 IP 地址 | `192.168.10.15` |
| `agent` (serial) | HMI agent 序列号，用于 WebSocket 绑定 | `72` |
| `device_id` | 设备 ID，用于 backend API 请求 | `188` |
| `map_name` | 操作地图名称，用于锁精定位前绑定 | `board188_THHB` |
| `wire_type` | 线束类型，决定标定/质检参数 | `THHB` / `THD30` / `C134` / `AIO` |
| `recipe_id` | 已完成的 recipe ID，用于轨迹生成 | `2004` |
| `start_wire_id` | 起始线束的 DB id（不是线束序号），发给 start-job | `31499` |

### 各参数发现方法

#### 1. robot_ip -- 从 config.yaml

```yaml
# 读取部署配置文件中的机器人列表
# 路径: 项目根目录 config.yaml → robots[].host
robots:
  - host: 192.168.10.15
    name: board188
```

agent 解析后展示可选机器人列表，人类选择目标。

#### 2. agent (serial) -- 从 HMI /aw_robot_status

```bash
python3 scripts/ehmi/ehmi_client.py <robot_ip> status
```

HMI 返回的 `/aw_robot_status` 消息中，**field 3** 是 agent 序列号。输出示例：

```
Board: 188  Agent: 72  IsBound: True
```

agent 解析后展示，人类确认。

#### 3. device_id -- 从 HMI /aw_robot_status field 13 (board_id)

同一个 `/aw_robot_status` 消息的 **field 13** 是 board_id（即 device_id）。常见映射：board142 → device_id=142, board188 → device_id=188。

**注意**：device_id 和 agent serial 是不同概念。device_id 用于 backend API（recipe CRUD、op_map 解析），agent serial 用于 WebSocket 绑定。不要混淆。

#### 4. map_name -- 从 opmap API 获取列表

```bash
# 获取操作地图列表
curl -s 'https://awr-backend-test.tars-ai.com/api/opmap/getList?device_id=<device_id>' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); [print(m['name']) for m in d.get('data',d)]"
```

agent 获取列表后展示，人类选择对应的地图名称。

#### 5. wire_type -- 从机器人 parameter.json 或人类选择

**方式 A（自动）**：从机器人本地配置文件读取：

```bash
cat /apollo/data/parameter.json | python3 -c "import sys,json; print(json.load(sys.stdin).get('recipe_type','unknown'))"
```

**方式 B（手动）**：如果自动读取失败，展示候选列表让人类选择：
`THHB` / `THD30` / `C134` / `AIO`

wire_type 决定后续标定/质检所用的 check_type 和 mode 参数。

#### 6. recipe_id -- 从 backend API 获取 completed 状态 recipe

```bash
# 获取已完成 (status=completed) 的 recipe 列表
curl -s 'https://awr-backend-test.tars-ai.com/api/recipe/getList?device_id=<device_id>&status=completed' \
  | python3 -c "
import sys,json
d=json.load(sys.stdin)
recipes = d.get('data',d) if isinstance(d,dict) else d
if isinstance(recipes, dict): recipes = recipes.get('list', recipes.get('data',[]))
for r in recipes:
    print(f'recipe_id={r[\"id\"]}  name={r.get(\"name\",\"?\")}  status={r.get(\"status\",\"?\")}')
"
```

agent 展示 completed 状态的 recipe 列表，人类选择目标 recipe。

#### 7. start_wire_id -- 从 backend API 获取线束列表

```bash
# 查询 recipe 的实际线束列表
curl -s 'https://awr-backend-test.tars-ai.com/api/wireInfo/getList?recipe_id=<recipe_id>&page_size=0' \
  | python3 -c "
import sys,json
d=json.load(sys.stdin)
wires = d.get('data',d) if isinstance(d,dict) else d
if isinstance(wires, dict): wires = wires.get('list', wires.get('data',[]))
for w in wires:
    print(f'wire_id={w[\"id\"]}  name={w.get(\"wire_name\",\"?\")}')
"
```

**重要**：线束序号不等于 wire_id。例如 recipe 2004 中线束5 的 wire_id 可能是 31499，而 recipe 1841 中线束5 的 wire_id 是 30105。必须通过 API 查询实际映射。

### 与 tibai 前端的对应关系

```
tibai 前端 Parameters 面板
  └── [Discover] 按钮
        ├── 自动发现 robot_ip, agent, device_id, wire_type
        ├── 调用 API 获取 map_name 列表, recipe_id 列表, wire_id 列表
        └── 填充到参数面板 → 人类确认 → 开始执行
```

agent 执行时，需要模拟这个流程：先拉取所有候选数据，展示给人类，确认后再执行后续步骤（绑定、锁精、轨迹生成、start-job）。

### 示例：agent 操作时的参数发现流程

```
1. 人类提供: robot_ip=192.168.10.15
2. agent 通过 eHMI 查询 status → 发现 agent=72, device_id=188
3. agent 展示: "检测到 board188, agent=72, device_id=188，确认?"
4. 人类确认后，agent 查 parameter.json → wire_type=THHB
5. agent 展示: "线束类型 THHB，确认?"
6. agent 查 opmap API → 展示地图列表，人类选择
7. agent 查 recipe API → 展示 completed recipe 列表，人类选择 recipe_id=2004
8. agent 查 wireInfo API → 展示线束列表，人类选择起始线束
9. 全部参数确认完毕，开始执行 ST 测试
```

---

## 快速决策树

```
测试同学给你 IP
  ├── 节点挂了？
  │     └── cd /apollo && source gaea.bashrc 2>/dev/null && bash /apollo/scripts/humanoid/start_awr.sh 2>&1
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
        ├── 大包 (7-10GB): bash awr_*.run → sudo systemctl restart humanoid-startup → 观察日志
        └── 模块小包 (1-3MB, 单模块覆盖): bash tars_<MODULE>.run → 不重启服务 → kill+setsid 重启对应 dag (详见"部署模块小包"章节)
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
bash awr_*.run
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

**先问用户是哪种角色**，再选择对应的连接方式：

### 场景 A: 开发者 (需要跳板)

开发者在办公网络，无法直连实验室机器人，必须通过跳板机中转：

```
开发者PC ─WiFi─→ 跳板机 (<跳板IP>) ─USB─→ 机器人 (192.168.10.x)
```

**环境变量**（无硬编码，按实际情况修改）：

| 环境变量 | 说明 | 示例 |
|----------|------|------|
| `AWR_JUMP_USER` | 跳板用户名 | `<跳板用户名>` |
| `AWR_JUMP_IP` | 跳板 IP | `<跳板IP>` |
| `AWR_JUMP_PASS` | 跳板密码 | `111111` |
| `AWR_ROBOT_USER` | 机器人用户名 | `nvidia` |
| `AWR_ROBOT_IP` | 机器人 IP | `192.168.10.15` |
| `AWR_ROBOT_PASS` | 机器人密码 | `nvidia` |

```bash
# 配置环境变量
export AWR_JUMP_USER=<跳板用户名> AWR_JUMP_IP=<跳板IP> AWR_JUMP_PASS=111111
export AWR_ROBOT_USER=nvidia AWR_ROBOT_IP=192.168.10.15 AWR_ROBOT_PASS=nvidia

# 方式 A: 建立隧道 (推荐 — eHMI 用，端口转发到本地)
bash scripts/ssh/ssh-tunnel.sh
# 然后 eHMI 命令直连 127.0.0.1:9094

# 方式 B: 通过跳板在机器人上执行单条命令
bash scripts/ssh/ssh-via-jump.sh "ls /apollo/data/log/"

# 方式 C: 交互式 SSH (需要手动输入密码)
ssh -J <跳板用户名>@<测试机IP> nvidia@192.168.10.15
```

### 场景 B: 测试人员 (直连机器人)

测试人员在实验室现场，PC 和机器人在同一网络，**不需要跳板**：

```
测试人员PC ─WiFi/USB─→ 机器人 (192.168.10.x)
```

```bash
# 直接 SSH 到机器人
ssh nvidia@192.168.10.15

# eHMI 命令直连机器人 IP
python3 /tmp/ehmi_client.py 192.168.10.15 status
python3 /tmp/ehmi_client.py 192.168.10.15 lock
```

**注意**：测试人员场景下，**不需要设置 `AWR_JUMP_*` 环境变量**，所有操作直连机器人 IP 即可。

### 脚本速查

| 脚本 | 用途 | 适用场景 |
|------|------|:---:|
| `scripts/ssh/ssh-tunnel.sh` | 建立 SSH 隧道 (9094/1995/2222) | 开发者 |
| `scripts/ssh/ssh-via-jump.sh` | 通过跳板在机器人上执行命令 | 开发者 |
| 直接 `ssh nvidia@<IP>` | 直连机器人 | 测试人员 |
| 直接 `python3 ehmi_client.py <IP>` | eHMI 命令直连 | 测试人员 / 开发者(隧道后 127.0.0.1) |

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
bash awr_*.run
sudo systemctl restart humanoid-startup
```

**部署后验证**:
```bash
systemctl status humanoid-startup    # Active: active (running)
ps aux | grep mainboard | grep -v grep | wc -l  # 应 ≥6
journalctl -u humanoid-startup -f    # 观察日志
```

## 部署模块小包 (.run)

模块小包是 bash 自解压脚本 (zstd tar payload)，**只覆盖单个模块**的 `bazel-bin` 和 `modules/`，不解包全量、不动 `/apollo` 软链、不装 systemd。常用于灰度替换某条 dag 对应的 .so / proto / conf。

**与部署大包的区别**:

| 维度 | 大包 (.run 7-10GB) | 模块小包 (.run 1-3MB) |
|---|---|---|
| 解压范围 | 全量 rootfs + /apollo 链接 + systemd | 仅 `bazel-bin/modules/<NAME>/` 和 `modules/<NAME>/` |
| 磁盘需求 | ≥50GB | ≤1GB |
| 需要重启 humanoid-startup | 是 | 否（除非要让新二进制对正在跑的 mainboard 生效） |
| 需要 sudo | 仅 `systemctl restart` 那步 | 否，全程 nvidia 用户 |

### 前置确认

```bash
# 1. 主包已部署、/apollo 软链指向有效大包
ssh nvidia@<robot_ip> 'ls -la /apollo && cat /apollo/V100*.txt | head -3'

# 2. 模块已在 /apollo/modules/ 存在（小包覆盖，不创建）
ssh nvidia@<robot_ip> 'ls /apollo/modules/<MODULE_NAME>/'

# 3. 磁盘空间
ssh nvidia@<robot_ip> 'df -h /mnt/dji/partitions/user'  # ≥1GB 可用即可
```

### 部署流程 (PC 直连 / 测试人员场景)

```bash
# 1. 下载 .run（注意: gitlab-ci 内网需要 --noproxy '*' 绕过 PC 代理）
curl -sSL --noproxy '*' --max-time 60 \
  -o /tmp/<MODULE_NAME>.run \
  http://10.100.100.51:8080/gitlab-ci/<YYYY>/<MM>/<DD>/<pipeline>/tars_<MODULE_NAME>_<hash>.run

# 2. 校验是 bash 自解压脚本 + Content-Length 匹配
file /tmp/<MODULE_NAME>.run
head -5 /tmp/<MODULE_NAME>.run   # 应看到 MODULE_NAME + PAYLOAD_MARKER

# 3. scp 上传到板上 /tmp/
sshpass -p nvidia scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  /tmp/<MODULE_NAME>.run nvidia@<robot_ip>:/tmp/<MODULE_NAME>.run

# 4. 在板上执行 (不加 sudo, 规则 3)
ssh nvidia@<robot_ip> 'bash /tmp/<MODULE_NAME>.run'
# 期望输出末尾: "模块 <MODULE_NAME> 部署完成！"
```

### 部署后验证

```bash
ssh nvidia@<robot_ip> 'set -e
  # 模块源文件时间戳更新
  ls -la /apollo/modules/<MODULE_NAME>/BUILD /apollo/modules/<MODULE_NAME>/cyberfile.xml
  # bazel-bin 产物
  ls /apollo/bazel-bin/modules/<MODULE_NAME>/ | head
  # version.txt 追加部署记录
  tail -10 /apollo/version.txt
'
# 期望 version.txt 末尾出现:
#   <YYYY-MM-DD HH:MM:SS> 部署小包 <MODULE_NAME>.run：
#     打包模块:      <MODULE_NAME>
#     打包者:        <author>
#     Thor分支:      <branch>
#     项目分支:      feature/<...>
```

### 让新二进制对正在跑的 mainboard 生效

小包部署**不会自动重启** mainboard。要让正在跑的 dag 用上新二进制，必须单独 kill + 重启该 dag（不是 `systemctl restart`，那是大包的事）：

```bash
ssh nvidia@<robot_ip> 'set +e
  cd /apollo && source gaea.bashrc
  # 1. 找该模块对应的 dag
  ls /apollo/modules/<MODULE_NAME>/dag/

  # 2. 杀旧进程 (按 dag 路径匹配,避免误杀)
  OLD_PIDS=$(pgrep -f "<MODULE_NAME>.*\.dag" || true)
  [ -n "$OLD_PIDS" ] && kill -9 $OLD_PIDS
  sleep 2
  pgrep -f "<MODULE_NAME>.*\.dag" && echo "STILL ALIVE" || echo "STOPPED OK"

  # 3. 用 setsid 脱离 ssh stdout 启动 (避免 ssh hang)
  LOG=/apollo/data/log/double_orin/<MODULE_NAME>.log.$(date +%Y%m%d.%H%M%S)
  setsid mainboard -d modules/<MODULE_NAME>/dag/<DAG_FILE>.dag \
    > "$LOG" 2>&1 < /dev/null &
  disown 2>/dev/null || true
  sleep 6
  ps aux | grep "<MODULE_NAME>.*\.dag" | grep -v grep | head -3
'
```

如果小包只是改 conf / proto / dag 文件、没改 .so，**可以不重启**——cyber reader/writer 在下次 dag reload 时自然加载新配置；但 protobuf 配置（.pb.txt）通常需要重启 dag 才生效。

### 常见陷阱

| 陷阱 | 症状 | 修复 |
|------|------|------|
| 走代理下载 .run | curl 502 Bad Gateway | `--noproxy '*'` 绕过 PC 代理直拉内网 |
| ssh nohup 卡住 | ssh 不返回、但进程已起 | 用 `setsid ... </dev/null &` + `disown` 完全脱离 |
| 误用 sudo 跑 .run | 产物属主变 root | 不加 sudo（规则 3），小包本就是 nvidia 自解压 |
| 小包部署后未重启 dag | 模块在跑但用的是旧二进制 | 必须 kill + setsid 重启对应 dag |
| `systemctl restart humanoid-startup` 当小包用 | 全节点重启、其他模块也掉线 | 小包只覆盖单模块，重启单 dag 即可 |

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
| `/apollo/version.txt` | 小包部署追加记录 (时间/打包者/分支/commit) |
| `/apollo/modules/<NAME>/` + `/apollo/bazel-bin/modules/<NAME>/` | 小包覆盖目录 |
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
| 起 job 前未回初始准备姿态 | 从残留位姿直接执行可能撞板/轨迹起点不匹配 | **start-job 前必须先 `safe-pose <recipe_id> 0`** 回到初始准备姿态 |
| 轨迹生成用 gen-traj 一次全下 | 实际是异步的，需要逐条确认 | 用 single-traj 逐条生成，每条确认 3 个 npz 文件后再继续下一条 |

---

## 部署后 E2E 验证 (ops.md Checklist)

大包部署完成后，按 `ops.md` 流程执行验证。**优先通过 SSH 在板上本地执行 eHMI 客户端**，无需打开浏览器。

### 架构说明

HMI 有两套通信通道：

```

ST / DAG 的确定性执行只把云端 REST 当数据面或只读辅助；真正会改变机器人状态的 `{ehmi}` 命令必须在端侧运行同一份 `ehmi_client.py` 并连接板内 `127.0.0.1:9094`。PC 侧直连 9094 可能握手超时，不作为默认路径。
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
ssh -J <跳板用户名>@<测试机IP> nvidia@192.168.10.15

# 确认 Apollo 路径
ls -la /apollo
cd /apollo && source gaea.bashrc
echo $CYBER_PATH  # 应指向当日大包

# 确认节点
ps aux | grep mainboard | grep -v grep | wc -l  # ≥6
curl -s -o /dev/null -w "%{http_code}" http://localhost:1995/  # 200
```

### Step 3-5: 绑定状态 + 地图 + 坐标检查

使用 eHMI Python 客户端（通过 WebSocket protobuf），默认在机器人端本地运行：

```bash
# 推荐: 在机器人本地运行，连接板内 127.0.0.1:9094
python3 scripts/ehmi/ehmi_client.py 127.0.0.1 status
```

输出示例:
```
Board: 142  State: ?  IsBound: True
```

**这步验证了**: 机器人绑定状态(is_bound=1)、板号(board142)、HMI 通信正常。

### Step 6-7: 锁精定位 (端侧执行)

```bash
AWR_DEVICE_ID=<device_id> python3 scripts/ehmi/ehmi_client.py 127.0.0.1 lock <recipe_id> <wire_id>
```

输出:
```
Accepted: True  → TC-04 PASS
```

**原理**: 通过 `/aw_task_manager_service` WebSocket RPC 发送 `AwRobotServiceRequest{mode=15, scenario=2}`。
- mode=15: LOCK_PRECISION_POSITIONING
- scenario=2: MAINTAIN
- 返回值 `is_accepted=1` **只表示 service 受理**,不代表机器人已经运动或锁精成功。
- 必须继续确认板端新日志出现 `execute_task mode = 15` / `Executing command: 15`,且没有 `execute false` / `report error code`。
- 常见失败: `error code: 5009`, `SLAM结果异常`, `Received ArUco reloc status is not successful`, `aruco_pose_error: null`。这表示 reloc/SLAM/地图绑定前置条件异常; 此时 HMI ack 仍可能是 `is_accepted=1`,但 ST 必须判 FAIL。

**注意**: 锁精定位前需确保 Maintain 页面已选择 Recipe 和 Wire。若未选择，可通过 cloud API 获取 recipe id 并在 service request 中带上 `recipe_id` 和 `wire_id`。

### Step 8: 创建 Recipe (端侧执行)

```bash
python3 scripts/ehmi/ehmi_client.py 127.0.0.1 recipe-create auto <device_id>
```

**原理**: 由端侧 eHMI 客户端调用数据面接口创建空白 recipe，执行入口仍是板上的 `ehmi_client.py`。
- 关键: 后端 schema 比前端 TypeScript 类型宽松，`op_map_id` 和 `nav_map_id` 可在创建时直接传入
- **op_map_id 按板不同**: board142→86, board188→132。`recipe_create` 已改为按 device 自动解析(`resolve_op_map`)，别硬编码。
- 创建后 recipe 状态为 0 (draft)，HMI Maintain 页面可看到
- `auto` 会由客户端展开为 `st_YYYYMMDD_HHMMSS`；ST YAML 里不要写 `st_$(date ...)`，runner 不保证 shell 展开。

**注意**: 不要导入其他 recipe 的 wiring config！新 recipe 是空白的，wiring 数据在后续"去人工打点"过程中生成。

> ⚠ 反复踩的坑(详见 `references/ehmi-protocol.md`「板载验证 & 真机经验」):
> - **DEVICE_ID/workspace_id ≠ agent serial**: board188→DEVICE_ID 188, agent 序列号 72; 绑定/锁精/recipe 的 workspace_id 用 DEVICE_ID。
> - **wire_id 是线束 DB id 不是序号**: recipe 1820 线束1..14 → id 30003..30016; "从线束3" = wire_id 30005。先 `GET /wireInfo/getList?recipe_id=&page_size=0` 查。
> - **板载确认**(排除客户端自嗨): 进机器人 shell grep `/apollo/data/log/`: 绑机器人看 `ADD TO WORKSPACE`, 绑地图看 `OnBindRequest`+`operation_map published`+`ReloadMap`, 锁精定位看 `mode = 15 ... execute_task` 和后续无 `execute false`/`error code: 5009`,用 request_id/参数+时间戳对账。
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
| `recipe-list <device_id>` | 列出指定 board/device 的所有 recipe |
| `recipe-create auto <device_id>` | 创建空白 recipe，名字由客户端生成 |
| `gate1` | 执行 Gate-1 全部检查 |
| `help` | 帮助 |

### 远程触发 eHMI 脚本

ST 默认通过 base64 + SSH 上传到机器人本地运行，目标地址仍是板内 `127.0.0.1`：

```bash
# 1. 编码脚本
B64=$(base64 scripts/ehmi/ehmi_client.py | tr -d '\n')

# 2. 通过跳板 SSH 到机器人，在板上连 127.0.0.1:9094
ssh -J <跳板用户名>@<测试机IP> nvidia@192.168.10.15 \
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
