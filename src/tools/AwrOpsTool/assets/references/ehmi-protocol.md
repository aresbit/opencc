# AWR HMI 远程控制协议参考

## 架构

```
HMI 前端 (Vue.js, :1995)
  ├── REST API  → https://awr-backend-test.tars-ai.com/api (云端数据: recipe/device/map CRUD)
  ├── WS protobuf → ws://<robot>:9094 (ROS Bridge: 实时控制/状态)
  │   封装: apollo.ts_awr_bridge.Json (proto2)
  │   消息类型: subscribe publish request response goal goalResponse goalResult
  └── WS JSON   → ws://<robot>:8766/power (电源状态)
```

## Json.proto (apollo.ts_awr_bridge.Json)

```protobuf
syntax = "proto2";
package apollo.ts_awr_bridge;

message Json {
    optional string type = 1;     // subscribe|publish|request|response|goal|goalResponse|...
    optional string topic = 2;    // topic name (e.g., /aw_robot_status)
    optional bytes msg = 3;       // nested protobuf payload
    optional string service = 4;  // service name (e.g., /aw_task_manager_service)
    optional string id = 5;       // request correlation UUID
    optional string action = 6;   // action name
    optional uint32 code = 7;     // response/error code
}
```

## AwRobotServiceRequest 字段编号

从 `awr_msgs.js` `AwRobotServiceRequest.encode()` 提取：

| 字段 | # | 类型 |
|------|---|------|
| node_id | 1 | uint32 |
| recipe_id | 2 | uint32 |
| task_id | 3 | uint32 |
| scenario | 4 | uint32 |
| mode | 5 | uint32 |
| param | 6 | double |
| axis_id | 7 | uint32 |
| gripper_id | 8 | uint32 |
| wire_id | 9 | uint32 |
| wire_type | 10 | uint32 |
| terminal_type | 11 | uint32 |
| camera_id | 12 | uint32 |
| camera_type | 13 | uint32 |
| row | 14 | uint32 |
| col | 15 | uint32 |
| gripper_action | 16 | uint32 |
| arm_id | 17 | uint32 |
| arm_motion_type | 18 | uint32 |
| aruco_id | 19 | uint32 |
| serial_number | 20 | string |
| database_ip | 21 | string |
| workspace_id | 22 | uint32 |
| agent_type | 23 | uint32 |
| index | 24 | uint32 |
| start_job_type | 25 | uint32 |
| kit_id | 26 | uint32 |
| kit_action | 27 | uint32 |
| kit_type | 28 | uint32 |
| board_gripper_id | 29 | uint32 |
| board_gripper_status | 30 | uint32 |

## 枚举值

```python
ACTION = {
    "LOCK_PRECISION_POSITIONING": 15,   # 锁精定位
    "UNLOCK_PRECISION_POSITIONING": 16, # 解锁精定位
    "MANUAL_MAKER_LOCAL": 155,          # 手动微调精定位
}

SCENARIO = {
    "JOB": 0,
    "RECIPE": 1,
    "MAINTAIN": 2,       # 维护页面
    "SINGLE_STEP": 3,
}

AGENT_TYPE = {
    "PLUGGING_ROBOT": 0,
}
```

## 关键 Topic

| Topic | 用途 |
|-------|------|
| /aw_robot_status | 机器人状态 (AwRobotStatus protobuf) |
| /aw_launcher/status | 启动器状态 |
| /aw_launcher/command | 启动器命令 |
| /kit_refine_result | 精定位结果 |
| /kit_refine_progress | 精定位进度 |
| /kit_refine_request | 精定位请求 |
| /issue_report | 问题报告 |
| /operation_map | 操作地图 |

## 关键 Service

| Service | 用途 |
|---------|------|
| /aw_task_manager_service | 任务管理（锁精定位、标定、轨迹、Job等原子指令） |
| /aw_robot_service | 机器人直连服务 |
| /robot_bind_service | 机器人绑定服务 |

## REST API (云端)

| 端点 | 方法 | 用途 |
|------|------|------|
| /recipe/create | POST | 创建 recipe (name, device_id, op_map_id, nav_map_id) |
| /recipe/getList | GET | 列出 recipe (?device_id=142) |
| /recipe/getOneById | GET | 获取单个 recipe (?id=xxx) |
| /recipe/updateStatus | PATCH | 更新 recipe 状态 ({id, status}) |
| /recipe/deleteById | DELETE | 删除 recipe (?id=xxx) |
| /recipe/copyRecipe | GET | 复制 recipe (?id=xxx) |
| /opMap/getList | GET | 列出操作地图 |
| /deviceConf/getDeviceConf | GET | 获取设备配置 |

## 机器人绑定 (RobotBindService) — 重要语义

Service: `/robot_bind_service`,消息 `awr_msgs.srv.RobotBindServiceRequest`。
前端实现: `components/BindAgent/BindRobotDialog.vue` + `composables/protobufService.ts` (`robotBindService`)。

请求字段(与前端一致):
| 字段 | # | 值 |
|------|---|-----|
| mode | 1 | 1=Bind(ADD_TO_WORKSPACE), 2=Unbind(EXIT_FROM_WORKSPACE) |
| serial_number | 2 | **机器人(agent)序列号,不是板号** — 从 `/aw_robot_status` field3 探测 |
| database_ip | 3 | 域名后端直接传完整 `https://host`;IP 后端传纯 IP,port 另给 |
| database_port | 4 | 域名后端为 0 |
| agent_type | 5 | 0=理线/插接(PLUGGING) |
| workspace_id | 6 | = DEVICE_ID(板号,如 72) |
| timestamp_ms | 7 | `Date.now()`;与板子时钟差 ≥24h 时板子会 `sudo date -s` 校时 |

响应 `RobotBindServiceResponse.is_accepted`:0=失败, 1=接受, 2=已绑定(**服务端未实现,永不返回**)。

### 服务端接受条件 (task_manager.cpp `robot_bind_service_callback`)
- `serial_number` 必须等于本节点 SN,否则发 INVALID_SN 且 **response 不设置 → is_accepted 默认 0**。
- Bind(mode=1) 仅当 `agent_status == ONLINE_WITHOUT_WORKSPACE(1)` 才 set(1)。
- Unbind(mode=2) 仅当 `agent_status == ONLINE_WITH_WORKSPACE(2)` 才 set(1)。
- **其余任何情况(尤其"已绑定再 Bind")都走不到任一分支 → is_accepted 保持默认 0。**

⇒ **绑定"失败(is_accepted=0)"最常见原因不是编码错,而是机器人已经绑定**(ONLINE_WITH_WORKSPACE)。
自动化里想稳定绑定要用 `rebind`(已绑定则先 unbind 再 bind),或先查 `/aw_robot_status` 的 agent_status(field 11)。

### call_service 必须按 id 关联响应
ROS bridge 在同一 socket 上多路复用 topic publish 与 service response。
若只做一次 `recv()`,很容易把 `/aw_robot_status` 的 publish 当成绑定响应(表现为 is_accepted 乱码/0,
但实际服务端已接受)。`ehmi_client.py` 的 `call_service` 现已循环 recv 并按请求 `id` + `type=="response"` 过滤。

### 复刻 HMI 绑定下拉框 (BindRobotDialog.vue)
下拉框 `agentList` = `/agent/getList` 里、其 `serial_number` 正在 `/aw_robot_status` 上报(非离线)、
且 `agent_type` 匹配(理线=0)的 agent。选项 `:label=item.name`(如 `agent72`),`:value=item.serial_number`(如 `72`)。
点选 `agent72` → `confirmBind` 发 `serial_number="72"`(**不是 name**)。

脚本 `agents` 命令复刻该下拉框;`bind/unbind/rebind` 可直接传 name(`agent72`)或 serial(`72`),
内部 `resolve_agent()` 按 name→serial 解析,等价于点选。

### eHMI 命令
```bash
python3 ehmi_client.py <ip> status              # 含 agent_status / in_workspace
python3 ehmi_client.py <ip> agents              # 列出可绑定机器人(=下拉框)
python3 ehmi_client.py <ip> bind agent72        # 按名字绑定(=点选 agent72);也可传 72 或 auto
python3 ehmi_client.py <ip> unbind agent72
python3 ehmi_client.py <ip> rebind agent72      # unbind→bind→校验,自动化推荐
```

### 跳板(踏板)访问 robot 9094
robot(nvidia@192.168.10.15)只需 9094(ROS bridge,无鉴权)即可绑定,无需登录板子。
经测试机 `book`(<跳板用户名>@<跳板IP>,pass 111111)做端口转发即可:
```bash
ssh -f -N -M -S ~/.ssh/book.ctl -o ControlPersist=1200 \
  -L 127.0.0.1:9094:192.168.10.15:9094 -L 127.0.0.1:1995:192.168.10.15:1995 \
  <跳板用户名>@<跳板IP>
python3 ehmi_client.py 127.0.0.1 rebind
```

## 绑定操作地图 (Map Bind / 设置页"保存地图")

**pub/sub 流程,不是 service。** 源:`settingPage.vue` `toPublishMap` + `modules/awr_envcheck/proto/map_bind.proto`。
前置:机器人须已绑定(前端校验 `getChooseAgent`),否则脚本/前端都会先弹绑定框。

1. **publish** `/tars/envcheck/map_bind_request` = `AwrMapBindRequest`:
   | # | 字段 | 值 |
   |---|------|-----|
   | 1 | header | tars.std_msgs.Header(optional,可给可省) |
   | 2 | request_id | HMI 生成 uuid,串联全生命周期 |
   | 3 | serial_number | 已绑定的 agent serial(如 72) |
   | 4 | map_name | 操作地图名(如 board188),= `/mnt/gaea/map` 下目录 |
   | 5 | wire_harness | WireType: `C134=1 THHB=2 THD30=3 AIO=4` |
2. **订阅** `/tars/envcheck/map_provision_required`(缺素材时来):需再 **publish**
   `/tars/envcheck/map_provision_select{request_id, pattern}`,pattern= `AIO=1 LZY_TH=2 OP=3`。
3. **订阅** `/tars/envcheck/map_bind_status`:`result` `1=SUCCESS`(已 forward 到 `/operation_map`)/`2=FAILED`
   (带 `error_code`+`failure_reason`)/`0=中间态`。错误码:1301 map_name非法、1302 内置zip不存在、1303 解压失败、1305 无权限、1306 选图案超时。

全部按 `request_id` 过滤。地图名 `boardNNN` 里的 NNN 即 DEVICE_ID(前端 `deviceId = name.replace('board','')`)。
**注意**:绑定会切换机器人 `/operation_map`,是有副作用的操作,别在别人跑任务时随便切板型。

命令:
```bash
python3 ehmi_client.py <ip> bindmap board188 THHB           # 已有素材直接成功
python3 ehmi_client.py <ip> bindmap board188 THHB auto LZY_TH  # 缺素材时带板型图案
```
真机实测(agent72):`bindmap board188 THHB` → 无 provision → `result=1` MAP BIND SUCCESS。

## 标定 / 标定质检 (calibration & quality check)

源:`views/calibration/{autoCalibratin,qualityCheck}.vue` + `autoCalibrationProgress.ts`。
都走 `robotService → /aw_task_manager_service`,`scenario=SINGLE_STEP(3)`,带 `arm_id`(field 17)。
**前置(人工)**:先把手臂/底盘/标定板移到位,标定板须在相机视野内(前端有确认弹窗)。
`arm_id`: 0=左 1=右 2=双。四类相机组:鱼眼双目 / 鱼眼手眼 / 内窥镜双目 / 鱼眼左目到内窥镜左目。

**自动化标定**(`AwRobotServiceRequest{mode, scenario=3, arm_id, serial_number}`),checkType→ROBOT_MODE:
| checkType | 含义 | ROBOT_MODE |
|---|---|---|
| 4 | 鱼眼双目 | 150 FISHEYE_STEREO_CALIBRATION |
| 7 | 鱼眼手眼 | 151 FISHEYE_HANDEYE_CALIBRATION |
| 10 | 内窥镜双目 | 152 PINHOLE_STEREO_CALIBRATION |
| 13 | 鱼眼左目到内窥镜左目 | 153 FISHEYE_PINHOLE_LEFT_CALIBRATION |
标定进度广播在 `/ts_awr/qualitycheck/calibration_status`(CalibrationBusinessStatus.state: 3=CALIBRATED 成功,5=FAILED)。

**标定质检**(`{task_id(field3), mode, scenario=3, arm_id, serial_number}`),mode 直接 154-157:
154 鱼眼双目 / 155 鱼眼手眼 / 156 内窥镜双目 / 157 鱼眼左目到内窥镜左目。
- `task_id` 由 HMI 生成(uint32),robot 透传给 qualitycheck。
- 结果订阅 `/ts_awr/qualitycheck/response`(QualityCheckResponse),按 `task_id`(field 21)过滤;
  中间帧 `qualitycheck_task_result`(field 20)为空,取带该字段的最终帧。
- 通过判定:嵌套 `qualitycheck_task_result` → 手眼(155)看 `handeye_validation_report.validate_success` +
  `overall_std_mm < 1.5`;双目/鱼眼左内窥左看对应 report 是否产出。
- **流程**(用户描述):人工摆位 → 质检;不过 → 自动化标定 → 标定成功 → 再质检。

命令:`calibrate <4|7|10|13> [arm]` / `quality-check <154|155|156|157> [arm]`。
> 标定/质检结果的完整 stddev 报告字段见 `AwQualityCheckTopic.proto`;客户端给出 pass/fail 判定 + 原始字段。

**⚠ 质检耗时差异(实测)**:
- 双目(154/156)= 单帧快照,秒回。154 报告字段:平面误差(4/5)、边长误差(6)、极线y(13/14 mm)、左右检测(10/11)、角点(12)、相机接反(15);top-level `stereo_validation_is_success`=field22。
- 手眼(155)/鱼眼左内窥左(157)= 两阶段 `HANDEYE_POSE_CALCULATION → HANDEYE_VALIDATION`,**实测 ~55s**。客户端默认等待已按 mode 放宽到 120s(双目 40s),否则 50s 会差几秒超时(结果其实已通过)。155 报告:`handeye_validation_report.validate_success`(1)+ `valid_pose_count`(2)+ `overall_std_mm`(3)。

**板载确认质检**(qualitycheck 组件日志,uuid 里带 task_id):
```bash
grep -rhiE "handeye_validate|qc_result|stereo.*valid|uuid=robot_qc_task<你的task_id>" /apollo/data/log/*qualitycheck*
```
关键行:`handeye_validate success=1, valid_pose_count=8`(手眼通过)、`handeye_collect success=1 corner_count=80`(charuco 板检测)。
uuid 格式 `robot_qc_task<task_id>_mode<155>_arm<0>_ct<1=VALIDATION>...`,ct1=HANDEYE_VALIDATION 是最终结果、ct2=POSE_CALCULATION 是中间态。

## ⚠ 执行 Job 是三步序列,不是单发 START_JOB(2026-07-14 实测踩坑)

前端 `jobPage.vue` `handleStartClick`→`handleAction(START_JOB)` 的**后端序列**,少一步 job 就建好行为树但机械臂不动:
1. `REQUEST_DATABASE`(ROBOT_MODE **154**, scenario=MAINTAIN, recipe_id)—— "保存端子后同步数据库",把 recipe 端子/布线下发到机器人运行时。
2. `START_JOB`(ACTION **22**, scenario=JOB, recipe_id, wire_id=起始线束, start_job_type)—— 建行为树(`load_and_con_repeat{load→connect_wire}`),`is_accepted=1`。**此时 `load` 节点等待,机械臂不动**。
3. `LOAD_VERIFY`(ACTION **26**, scenario=JOB, recipe_id, wire_id, start_job_type)—— "确认上料"。这一步让 `is_cruise_load_over` 节点 SUCCESS → 行为树推进 → `async_trajectory_executor` 提交 `init_to_load_start_pose_线束N` → **机械臂开动**。

`ehmi_client.py` 的 `start_job()` 已复刻这三步(`sync=True` + `load_verify=True` 默认全做)。中间前端还有 Recipe自检/端子校验/**二次确认弹框(物料/布线)**——那是人工安全门,脚本由调用方负责已确认。

**板载确认 job 真跑起来**(不是只 is_accepted):
```bash
grep -rhE "load verify|is_cruise_load_over.*SUCCESS|Trajectory replay submitted.*线束|async_trajectory_executor" /apollo/data/log/*wire_robot* /apollo/data/log/*x_wbc* | tail
```
看到 `Trajectory replay submitted successfully: init_to_load_start_pose_..._线束N` = 机械臂真正在执行。
> 注:`e2e_component` 报 `affordance_info ... has not received` 是空闲噪声(该 topic 插接时才有生产方),**不是** job 不动的原因;真正原因是缺 LOAD_VERIFY。

## 板载验证 & 真机经验(2026-07-14 实测)

### 登进机器人拿 shell(经跳板转发 22 口)
9094/1995 转发只够跑 eHMI;要看**服务端日志**得进机器人 shell。用已有 book 控制主控加一条 22 转发:
```bash
ssh -S ~/.ssh/book.ctl -O forward -L 127.0.0.1:2222:192.168.10.15:22 <跳板用户名>@<跳板IP>
# askpass 返回 'nvidia'(机器人密码):
SSH_ASKPASS=<返回nvidia的脚本> SSH_ASKPASS_REQUIRE=force DISPLAY=dummy:0 \
  setsid ssh -o StrictHostKeyChecking=no -p 2222 nvidia@127.0.0.1
```
日志目录:`/apollo/data/log/`。绑定/动作日志是 **glog WARNING 级**(`W2026...`),用 `grep -rhE`(别用 `-o`,会丢时间戳)。

### 板载确认每步操作(request_id / 参数对账,排除"客户端自嗨")
| 操作 | 板子上 grep | 证明什么 |
|------|-----------|---------|
| 绑定机器人 | `grep -rhE "ADD TO WORKSPACE\|robot_bind_service_callback" /apollo/data/log/` | `mode=1→ADD TO WORKSPACE, workspace_id:N` = 真绑定;`mode=2→EXIT` = 解绑 |
| 绑定地图 | `grep -rhE "OnBindRequest\|operation_map published\|ReloadMap" /apollo/data/log/ \| grep board188` | `OnBindRequest request_id=<客户端返回的同一个>` = 收到;`/operation_map published` = 生效;`ReloadMap` = 下游定位模块已重载 |
| 锁精定位 | `grep -rhE "mode = 15\|execute_task mode = 15" /apollo/data/log/` | `scenario=2, mode=15, recipe_id, wire_id` + `execute_task` = 真执行(对应"坐标固定不跳") |
把客户端返回的 `request_id` / `recipe_id` / `wire_id` 和板子日志里的值 + 时间戳对上,就是铁证。

### 地图绑定 provision 判定(为什么 board188 秒成、board142 要选板型)
`map_provision_component.cc:137`:**`/mnt/gaea/map/<board>` 目录非空 → 直接 forward 到 /operation_map**;
目录不存在/空 → 发 `provision_required`,需选板型图案(AIO/LZY_TH/OP)解压对应 `resource/maps/<PATTERN>.zip`(~155MB)重命名成该 board。
```bash
ls /mnt/gaea/map/     # 有 board188/ → 秒成; 没 board142/ → 要 provision
```
板型选择在真实前端也是弹窗人工选,无自动映射;THHB 线束 ≠ 自动对应某板型,别乱选(有覆盖地图副作用)。

### ⚠ DEVICE_ID / workspace_id ≠ agent serial(反复踩)
- agent(机器人)序列号 = **72**;操作地图 board188 → **DEVICE_ID = 188**(前端 `deviceId = mapName.replace('board','')`)。
- 绑定/锁精定位/建 recipe 的 `workspace_id` = **DEVICE_ID(188)**,不是 serial(72)。客户端 `HmiController.device_id` 要按当前地图设(如 `c.device_id="188"`)。
- board188 → op_map_id=**132**;board142 → op_map_id=**86**。`recipe_create` 已改为按 device 自动解析 op_map(`resolve_op_map`),别再硬编码。

### ⚠ wire_id 是线束的数据库 id,不是序号(1/2/3…)
维护页/job 页线束下拉 `:value="item.id"`,默认取 `items[0].id`。recipe 1820 的 线束1..14 → id **30003..30016**。
所以"从线束3开始" = `wire_id=30005`(线束3 的 id),**不是 3**。锁精定位/单条轨迹/执行 job 传 wire_id 都要用 DB id;
先 `GET /wireInfo/getList?recipe_id=<id>&page_size=0` 查出线束 id 列表再用。

### 锁精定位前置(实测通过)
需机器人已绑定(workspace=DEVICE_ID)+ 维护页选好 recipe(**已完成态**)+ wire。
`lock <recipe_id> <wire_id>` → 服务端 `scenario=2 mode=15` execute_task,is_accepted=1。空白新 recipe(status=0)不能直接锁,要先人工打点。

## 姿态 / 安全恢复(撞机后回安全位)

源:`maintainPage.vue` / `RobotControlPanel.vue` / `agentConfig.vue` / `SafePosConfig.vue handleMove`。

| 命令 | mode | scenario | 说明 |
|------|------|----------|------|
| `move-op [recipe_id]` | MOVE_ALL_FAR **156** | MAINTAIN | 移动到操作位/远离位。**最简单稳健的撞机安全恢复** |
| `arm-vertical [arm] [param]` | ARM_VERTICAL **141** | MAINTAIN | 一键垂直于地面,带 arm_id + param |
| `move-wait` | MOVE_TO_WAIT_AREA **118** | RECIPE | 移动到等候区 |
| `safe-pose <recipe_id> [index=0] [arm]` | JOINT_MOVE **110** | RECIPE | 移动到**准备姿态**;**index=0 即"初始准备姿态"** |

**`safe-pose` 是精确的"回到初始准备姿态"**:从 REST **`GET /recipeSafePosition/getRecipeSafePositionList?recipe_id=`**(前端 `apiGetRobotSafePos`,返回 `SafePos[]`,每项 `name`=标签如"初始准备姿态")拉列表,**按 name 匹配**(前端 `findIndex(label===name)`)取 `position` 构建 payload。
> ⚠ **不要用 `/safePosition/getList`** —— 那个返回通用"安全位置N"、坐标是别的东西,机器人不会动到正确准备姿态(2026-07-16 踩坑)。
> index→标签:0=初始 1=上料 2=理线 3=结束位插接 4=起始位插接 5=下料 6=归置 7=缠胶 …(`SAFE_POSE_LABELS`)。也可 `safe-pose <recipe> 上料准备姿态`。

payload(取匹配项的 `position`):
- `joint_values`(字段 **32**,repeated double 非 packed)= `joints_pos` 的值
- `joint_names`(字段 **33**,repeated string)= `joints_pos` 的键
- `points`(字段 **37**,repeated Pose)= [左, 右, base] 三个 `Pose{position:Point{x,y,z}, orientation:Quaternion{x,y,z,w}}`,全 double
- 标量:mode=JOINT_MOVE(110),scenario=RECIPE,recipe_id,arm_id,serial_number,workspace_id(=DEVICE_ID)

> 撞机后快速回安全位优先 `move-op`(无需 recipe 数据);要精确回到示教的初始准备姿态用 `safe-pose <recipe> 0`。

## Recipe 位姿调整移动 (poseAdjust.vue)

recipe 位姿调整页的所有移动操作,均走 `/aw_task_manager_service`:

| 操作 | 命令/方法 | mode | scenario | 参数 |
|------|-----------|------|----------|------|
| 调整到上料高度 | `pose-upload` | MOVE_TO_LOAD_POSE **123** | SINGLE_STEP | — |
| 调整到理线插接高度 | `pose-cutting` | MOVE_TO_WIRE_PLUGGING_POSE **124** | SINGLE_STEP | — |
| 精调插接移动 | `move-insert [arm]` | MOVE_INSERT **117** | RECIPE | arm_id |
| 移动到关键点位姿(已同步) | `move_to_pose(recipe,pose,arm,mode)` 方法 | getSportMode(JOINT_MOVE **110** / MOVE_ALL **115**) | RECIPE | joint_values(32)+joint_names(33)+points(37) |
| 按 ArUco 移动(关键点无 id) | `move_to_aruco(recipe,aruco_id,pose,arm)` 方法 | MOVE_TO_ARUCO_POSITION **121** | RECIPE | aruco_id(19)+points(37) |

- `getPoseData` 复刻(`_points_from_pose`):`MOVE_ALL`(115)下发 [左,右,base] 三 Pose;单臂只下发选中臂。
- `move_to_pose`/`move_to_aruco` 是**库方法**(需传入关键点的 pose dict:joints_pos + left/right/base position+quaternion),CLI 未直接暴露(位姿数据来自 recipe 关键点)。简单三个(pose-upload/pose-cutting/move-insert)有 CLI。
- `pose`/`points` 编码同 `safe-pose`(joint_values 32 / joint_names 33 / points 37,见上一节)。

## 打点日志上报 / 问题上报 (FeedbackDialog.vue onSubmit)

命令 `report-issue <描述> [operator] [tag_type] [recipe_id] [--no-mark]`。**两个 publish**(无返回):

| topic | 消息 | 用途 | 关键字段 |
|-------|------|------|---------|
| `/tars/quickdata/request` | TSQuickDataRequest | 日志/录制数据快传上报(转外部数据平台) | request_id(1) issue_url(2) request_timestamp(3) device_id(4=X1-serial) tag_type(6) issue_detail(7) operator_name(8) take_over_type(9) location(10) purpose(11) task_type(12) hardware(13) package_version(14) test_type(15) issue_title(17) handler_name(18) recipe_id(19) |
| `/issue_report` | IssueReport | 录制中"打点"标记(tag_type=2) | header(1) tag_type(2) issue_detail(3) operator(8) take_over_type(9) timestamp(10, uint64 ms) |

- `tag_type`: 0 LOG / 1 NORMAL / 2 WARNING / 3 ERROR;`take_over_type`: 0 NONE / 1 INVALID / 2 TAKEOVER。
- `issue_url` 硬编码 `https://open.tars-ai.com/api/v1/transform/record_upload`;location/purpose/task_type/test_type 有前端默认值。
- `--no-mark` 只发 quickdata 快传、不打 issue_report 标记(前端仅在数据录制中 state==2 才打点)。
- `IssueReport.header` 是 proto required 但前端不发,脚本也不发(服务端容忍)。

## eHMI 客户端完整命令表 (ehmi_client.py)

```
# 绑定 / 精定位 / 地图
status | agents | bind <name|serial|auto> | unbind | rebind
bindmap <map> [wire] [agent] [pattern]
lock <recipe_id> <wire_id> [serial] | unlock <recipe_id> <wire_id> | manual-refine <recipe_id> <wire_id>
# 机器人原子动作 —— ⚠ 全部走 /aw_task_manager_service (前端 robotService),/aw_robot_service 未使用
# ⚠ workspace_id = DEVICE_ID(板号 board142→142),≠ agent serial(72);客户端 device_id 默认 142
action <MODE|名> [scenario] | reset | clear-alarm | init-all | home-all | config-check
start-job <recipe_id> <起始wire_id> [job_type 0理线/1缠绞] | pause-job | continue-job | stop-job
gen-traj [recipe_id] | del-traj [recipe_id] | single-traj <wire_id> [recipe_id] [--delete]
record-start | record-stop | launcher-abort
# 姿态 / 安全恢复 (撞机后回安全位)
move-op [recipe_id] | arm-vertical [arm] [param] | move-wait | safe-pose <recipe_id> [index=0初始准备姿态] [arm]
# recipe 位姿调整 (poseAdjust.vue)
pose-upload | pose-cutting | move-insert [arm]   # 库方法另有 move_to_pose / move_to_aruco(需 pose 数据)
# 标定 / 质检 (scenario=SINGLE_STEP, 带 arm_id; 前置需人工摆好手臂+标定板)
calibrate <check_type 4|7|10|13> [arm 0左/1右/2双]   # 自动化标定 → ROBOT_MODE 150/151/152/153
quality-check <mode 154|155|156|157> [arm]           # 标定质检 (task_id 关联结果, std<1.5mm 判通过)
# 只读订阅 (校验用)
info | kit-result | kit-progress | issue-report | launcher-status
# 电源/故障 (8766 JSON)
clear-fault | read-fault-log | clear-fault-log
# 打点日志上报 / 问题上报 (publish, 无返回)
report-issue <描述> [operator] [tag_type 0LOG/1NORMAL/2WARN/3ERR] [recipe_id] [--no-mark]
# 云端 REST
recipe-list [dev] | recipe-create <name> [dev] | recipe-get <id> | recipe-status <id> <st>
recipe-copy <id> | recipe-delete <id> | opmap-list | navmap-list | deviceconf [dev] | safepos-list
```
所有 service 走 `call_service`(按 id 关联);所有 action 走通用 `robot_action(mode, scenario, **extra)`;
REST 走 `_rest(method, path, params, body)`。字段号出处见各 proto,已离线单测。

## AwRobotStatus 关键字段

| 字段 | # | 含义 |
|------|---|------|
| header | 1 | ROS Header (timestamp + frame_id) |
| robot_state | 2 | 机器人状态枚举 (4=?) |
| serial_number | 3 | 板号 (e.g., "142") |
| is_bound | 7 | 是否已绑定 (1=已绑定) |
| api_url | 9 | 后端 API URL |
| board_id | 13 | 板子 ID (142) |
| joint_state | 17 | 关节状态 (repeated, 左臂+右臂) |
| aruco_pose | 22 | ArUco 标记位姿 |
