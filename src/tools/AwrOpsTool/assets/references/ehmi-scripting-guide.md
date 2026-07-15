# eHMI 脚本化指导文档 — 把 HMI 前端操作写成 Python 脚本

> 目标:把 AWR HMI(Vue 前端)上人工点击的每一个操作,复刻成 `ehmi_client.py` 里可远程调用的 Python 函数,
> 从而不开浏览器就能跑完整的自动化测试(绑定→锁精定位→建 recipe→打点→黄金模板→点位验证→跑 Job)。
>
> **本文是给执行 agent 的施工规范**:先读"方法论"和"必踩的坑",再照"操作清单"逐个认领实现。
> 权威来源是前端源码,**不要凭记忆猜字段**:`deployment/modules/awr_hmi/hmi/src`。

---

## 实现进度(截至本次,`ehmi_client.py`)

**已落地(编码按 proto 字段表核对 + 离线单测通过;带 ⚠ 的因机器人占用尚未真机跑通)**:
- 通道A service:`bind/unbind/rebind`✅真机、`lock/unlock`✅、`manual-refine`⚠、通用 `robot_action` + `reset/clear-alarm/init-all/home-all/config-check`⚠、`start/pause/continue/stop-job`⚠、`gen-traj/del-traj/single-traj`⚠、`record-start/stop`(robot_sensor)⚠、`scheduler`⚠、`launcher-abort`⚠
- 通道A 绑地图:`bindmap`✅真机(pub/sub + provision)
- 通道A 订阅:`status`✅、`info/kit-result/kit-progress/issue-report/launcher-status`⚠
- 通道B REST:`recipe-list/create/get/status/copy/delete`✅、`opmap-list`✅、`navmap-list`、`deviceconf`、`safepos-list`、`agent_save/delete`、`camera_calib`(方法齐备)
- 通道C 电源:`clear-fault/read-fault-log/clear-fault-log`(8766 JSON)⚠

- 通道A 标定/质检:`calibrate <4|7|10|13>` (ROBOT_MODE 150-153) / `quality-check <154-157>`(带 task_id,订阅 `/ts_awr/qualitycheck/response` 判 std<1.5mm)⚠。**前置需人工摆手臂+标定板**。

**部分/待补**:
- `save_golden_model` / `template_service`:标量字段已编码,但 **2D 点位 / CompressedImage 需视觉侧真实数据**,脚本外部传入(P2,留接口)。
- 质检双目(154/156)/鱼眼左内窥左(157)的 pass 判定目前只看 report 是否产出;手眼(155)已按 validate_success+std<1.5mm 判定。完整 stddev 报告字段见 `AwQualityCheckTopic.proto`。
- `/operation_map` 订阅解析:字段未细化(P2)。

> ⚠ 项一旦机器人空闲,按 §8 联调环境逐个真机验证(优先 `reset`/`clear-alarm`/订阅类,副作用小)。

---

## 0. 三条通信通道(决定一个操作怎么写)

```
HMI 前端 (Vue, :1995)
 ├─ A. WS protobuf → ws://<robot>:9094   ROS Bridge:实时控制/状态(绝大多数操作在这)
 │     封装 apollo.ts_awr_bridge.Json(proto2),type=request/response/subscribe/publish/goal...
 ├─ B. REST → https://awr-backend-test.tars-ai.com/api   云端数据 CRUD(recipe/map/device/agent)
 └─ C. WS JSON → ws://<robot>:8766/power   电源与故障(clear_fault / read_fault_log,纯 JSON)
```

判断一个前端操作走哪条通道:看它调用的是
- `callService('/xxx', data)` / `sendGoal('xxx', goal)` → **通道 A**(protobuf,写进 `HmiController`)
- `api('/xxx','get'|'post'|...)`(`apis/models/*`)→ **通道 B**(`urllib`,直接 HTTP)
- `powerWs.ts` 里的 `action: 'clear_fault'` → **通道 C**(8766 JSON)

---

## 1. 通用方法论:5 步把一个前端操作变成脚本

以任意前端按钮为例,按这 5 步逆向:

**Step 1 — 定位前端调用点。**
在组件里搜按钮的 `@click` / `confirm` 处理函数,找到它最终调的 service/api/goal 名字。
例:`BindRobotDialog.vue` 的 `confirmBind()` → `robotBindService({mode, serial_number, workspace_id, agent_type, timestamp_ms})`。

**Step 2 — 找到 service wrapper,抄全字段和默认值。**
`composables/protobufService.ts` 里每个 `xxxService = (data) => callService('/name', {...data, 补充字段})`。
**注意 wrapper 常偷偷补字段**(如 `robotBindService` 自动补 `database_ip/database_port`)——必须一起抄。

**Step 3 — 拿到 protobuf 消息类型 + 字段编号(field number)。**
两个权威来源,二选一:
- `.proto` 文件:`modules/awr_common/msgs/awr_msgs/**/*.proto`(或 hmi 内镜像 `src/protobuf/msgs/...`)。
- 生成的 JS 编码器:`src/types/protobuf/awr_msgs.js` 里 `XxxRequest.encode()`,字段 tag 一目了然。
把每个字段的 **field number + wire type**(varint/string/double)记下来。

**Step 4 — 用底层原语编码,套 Json 外壳发出去。**
复用 `ehmi_client.py` 已有的 `varint()` / `encode_service_request()` 风格,
或按字段表写一个 `encode_xxx_request(**fields)`。外层统一用 `call_service('/name', req_bytes)`。

**Step 5 — 解析响应 + 真机校验。**
`parse_response()` 得到 `{field_num: value}`,按响应 `.proto` 映射字段。
**必须订阅相关状态 topic 验证副作用**(如绑定后 `/aw_robot_status` 的 `agent_status` 变 2),不能只看返回码。

---

## 2. 底层编码速查(protobuf wire format)

已在 `ehmi_client.py` 实现,直接复用:

| 需求 | 代码 |
|------|------|
| varint 字段 | `varint((fnum<<3)\|0) + varint(value)` |
| string/bytes 字段 | `varint((fnum<<3)\|2) + varint(len) + data` |
| double 字段(如 param) | `varint((fnum<<3)\|1) + struct.pack('<d', value)` |
| Json 外壳 | `encode_json_wrapper(type_=, service=/topic=, msg=<bytes>, id_=)` |
| 通用解码 | `decode_json_wrapper(raw)` → 外壳; `parse_response(msg)` → `{fnum:val}` |

proto2 optional 默认值(0/空串)可省略不编码——服务端按默认处理。

---

## 3. ⚠️ 必踩的坑(全局适用,写每个脚本都要遵守)

1. **响应必须按 `id` 关联,别裸 `recv()` 一次。**
   9094 把 topic publish 和 service response 混在同一 socket。裸收一帧极易把 `/aw_robot_status`
   当成你的响应(表现:返回码乱码/0,但服务端其实成功)。
   → 一律走 `HmiController.call_service()`(已循环 recv + 按 `id`/`type=="response"` 过滤)。

2. **返回 `is_accepted=0` 不一定是失败,可能是"状态不对/已处于目标态"。**
   典型:绑定服务**没有** `is_accepted=2`(已绑定)这条路径,已绑定再 bind 直接默认 0。
   → 操作前先查状态 topic;做幂等封装(如 `rebind` = 先 unbind 再 bind)。

3. **serial_number 是"机器人序列号",不是板号/device_id。**
   不要写死 142/72。用 `resolve_serial()` 从 `/aw_robot_status` field3 自动探测。
   `workspace_id` 才等于 DEVICE_ID(板号)。

4. **mode/action 枚举以前端 `enums/robot.ts` 为准**(见 §5),别用记忆里的数字。
   注意同名枚举在不同上下文取值不同(如 `BindAction.ADD_TO_WORKSPACE=1`,而 robot ACTION 里另有 130)。

5. **`timestamp_ms` 要带真实毫秒时间戳。** 绑定服务会用它校板子时钟(差 ≥24h 会 `sudo date -s`)。

6. **service wrapper 补的隐藏字段别漏**(database_ip、camera_id-1 偏移等),否则服务端行为不一致。

7. **副作用校验优先于返回码**:订阅对应 topic 确认状态真的变了(见 §6 校验矩阵)。

---

## 4. 操作清单(施工总表,按优先级认领)

状态:✅已实现 / 🔶部分 / ⬜待实现。优先级:P0=Gate-1闭环必需,P1=完整E2E必需,P2=增强。

### 4.1 通道 A — protobuf service(`HmiController` 方法)

| 操作 | service | 消息类型 | mode/字段 | 前端源 | 优先级 | 状态 |
|------|---------|---------|-----------|--------|:---:|:---:|
| 机器人绑定/解绑 | `/robot_bind_service` | RobotBindServiceRequest | mode 1/2 | BindRobotDialog.vue | P0 | ✅ |
| 锁/解锁精定位 | `/aw_task_manager_service` | AwRobotServiceRequest | mode 15/16 scenario 2 | maintain 页 | P0 | ✅/🔶 |
| 手动微调精定位 | `/aw_task_manager_service` | AwRobotServiceRequest | mode 155 | maintain 页 | P1 | 🔶 |
| 系统复位 RESET | `/aw_robot_service` | AwRobotServiceRequest | mode 20 | settingPage.vue | P1 | ⬜ |
| 清除报警 CLEAR_ALARM | `/aw_robot_service` | AwRobotServiceRequest | mode 27 | 告警栏 | P1 | ⬜ |
| 初始化全部 INIT_ALL | `/aw_robot_service` | AwRobotServiceRequest | mode 0 | settingPage.vue | P1 | ⬜ |
| 全部回零 HOME_ALL | `/aw_robot_service` | AwRobotServiceRequest | mode 1 | settingPage.vue | P1 | ⬜ |
| 启动/暂停/继续/停止作业 | `/aw_robot_service` | AwRobotServiceRequest | mode 22/23/24/25 | job 页 | P1 | ⬜ |
| 生成/删除 全部轨迹 | `/aw_robot_service` | AwRobotServiceRequest | mode 138/139 | recipe/stepView | P1 | ⬜ |
| 生成/删除 单条轨迹 | `/aw_robot_service` | AwRobotServiceRequest | mode 10/109 (+wire_id) | recipe/stepView | P1 | ⬜ |
| 连接/理线/缠胶/上料/下料 | `/aw_robot_service` | AwRobotServiceRequest | mode 3/8/4/2/5 | job/单步 | P2 | ⬜ |
| 配置检测 CONFIG_CHECK | `/aw_robot_service` | AwRobotServiceRequest | mode 143 | envcheck | P2 | ⬜ |
| 保存黄金模板点位 | `/aw_golden_model_service` | HmiGoldenModelSaveRequest | 见 proto | poseAdjust.vue | P1 | ⬜ |
| 模板投影(3D→2D) | `/tars_awr_perception/aw_template_project_service` | AwTemplateEditServiceRequest | 见 proto | label/ImageLabel | P2 | ⬜ |
| 模板精修(2D 粗点) | `/tars_awr_perception/aw_template_refine_service` | AwTemplateEditServiceRequest | 见 proto | label/ImageLabel | P2 | ⬜ |
| 质检 | `/ts_awr/qualitycheck/service` | (见 ts_hmi proto) | — | qualityCheckDialog.vue | P2 | ⬜ |
| 数据录制开/关 | `/robot_sensor_service` | (control_type) | control_type 2 | BindRobotDialog.vue | P1 | ⬜ |
| 调度取 aruco 位姿 | `/scheduler_service_<serial>` | TwoVarsMsgServiceRequest | — | 巡航 | P2 | ⬜ |
| 启动器命令 | `/aw_launcher/command` | AwrLauncher* | — | launcher | P2 | ⬜ |

> `/aw_robot_service` 与 `/aw_task_manager_service` 用**同一个** `AwRobotServiceRequest`(字段表见 `ehmi-protocol.md`);
> 区别只是 service 名。task_manager 走维护/原子指令语义,aw_robot_service 走机器人本体直连。
> **实现建议**:写一个通用 `robot_action(service, mode, scenario, **extra)`,所有 mode 操作共用它,
> 各具体操作只是不同参数的薄封装。ACTION 全枚举见 §5。

### 4.2 通道 A — 状态订阅(subscribe,只读,用于校验)

| topic | 用途 | 优先级 | 状态 |
|-------|------|:---:|:---:|
| `/aw_robot_status` | 机器人/agent 状态、is_bound、agent_status、板号 | P0 | ✅ |
| `/aw_info` | 全局告警/信息 | P1 | ⬜ |
| `/issue_report` | 问题上报 | P1 | ⬜ |
| `/kit_refine_progress` `/kit_refine_result` | 精定位进度/结果 | P1 | ⬜ |
| `/aw_launcher/status` | 启动器/节点状态 | P2 | ⬜ |
| `/operation_map` | 操作地图 | P2 | ⬜ |

### 4.3 通道 B — 云端 REST(`urllib`,直接 HTTP)

| 操作 | 端点 | 方法 | 优先级 | 状态 |
|------|------|------|:---:|:---:|
| Recipe 列表/详情 | `/recipe/getList` `/recipe/getOneById` | GET | P0 | ✅/⬜ |
| Recipe 创建 | `/recipe/create` | POST | P0 | ✅ |
| Recipe 更新/状态/复制/删除 | `/recipe/updateById` `/recipe/updateStatus` `/recipe/copyRecipe` `/recipe/deleteById` | PUT/PATCH/GET/DELETE | P1 | ⬜ |
| 操作地图 列表/上传/存 | `/opMap/getList` `/opMap/uploadOpMapFile` `/opMap/saveOrUpdateById` | GET/POST/PUT | P1 | 🔶 (getList✅) |
| 导航地图 列表/存/删 | `/navMap/getList` `/navMap/saveOrUpdateById` `/navMap/deleteById` | GET/PUT/DELETE | P2 | ⬜ |
| 设备配置 读/写 | `/deviceConf/getDeviceConf` `/deviceConf/setDeviceConf` | GET/PUT | P1 | ⬜ |
| Agent 列表/存/删 | `/agent/getList` `/agent/saveOrUpdateById` `/agent/deleteById` | GET/PUT/DELETE | P1 | 🔶 |
| 相机标定/更新 | `/camera/calibById` `/camera/updateById` | PUT | P2 | ⬜ |
| 安全位 列表/存 | `/safePosition/getList` `/safePosition/saveSafePosition` | GET/POST | P2 | ⬜ |
| 线/盖/仓 信息更新 | `/wireInfo/updateById` `/coverInfo/updateById` `/pod/updateById` | PUT | P2 | ⬜ |

### 4.4 通道 C — 电源/故障(ws://<robot>:8766/power,JSON)

| 操作 | 请求 | 优先级 | 状态 |
|------|------|:---:|:---:|
| 清除故障 | `{"action":"clear_fault"}` | P2 | ⬜ |
| 读故障日志 | `{"action":"read_fault_log"}` | P2 | ⬜ |
| 清故障日志 | `{"action":"clear_fault_log"}` | P2 | ⬜ |

源:`composables/powerWs.ts`。响应异步、多帧(started/result),需按 `type` 收集。

---

## 5. AwRobotService ACTION 枚举(mode 值,来自 `enums/robot.ts`)

```
0 INIT_ALL        1 HOME_ALL       2 LOAD           3 CONNECTION      4 WRAP_TAPE
5 UNLOAD          6 CAL_OFFSET     7 CONNECTION_START 8 ORGANIZE_WIRE  9 CONNECTION_END
10 SINGLE_TRAJECTORY_GENERATION   15 LOCK_PRECISION_POSITIONING   16 UNLOCK_PRECISION_POSITIONING
20 RESET          21 ALARM         22 START_JOB      23 PAUSE_JOB      24 CONTINUE_JOB
25 STOP_JOB       26 LOAD_VERIFY   27 CLEAR_ALARM    28 TO_LOAD_POST   29 TO_WAIT_POST
30 FISHFIN_GRASP  31 PANEL         109 DELETE_SINGLE_TRAJECTORY   138 GENERATE_ALL_TRAJECTORIES
139 DELETE_ALL_TRAJECTORIES   143 CONFIG_CHECK   155 MANUAL_MAKER_LOCAL
```
scenario(ROBOT_SCENARIO):`0 JOB / 1 RECIPE / 2 MAINTAIN / 3 SINGLE_STEP`。
> 绑定专用 `BindAction`(仅 `/robot_bind_service`):`1 ADD_TO_WORKSPACE / 2 EXIT_FROM_WORKSPACE`,与上表无关。

---

## 6. 副作用校验矩阵(操作 → 订阅哪个 topic 看什么变了)

| 操作 | 校验 topic | 期望 |
|------|-----------|------|
| bind | `/aw_robot_status` | `agent_status` 1→2, `is_bound=1` |
| unbind | `/aw_robot_status` | `agent_status` 2→1 |
| lock 精定位 | 返回 is_accepted=1 + `/kit_refine_result` | 结果成功 |
| RESET/CLEAR_ALARM | `/aw_info` | 告警清除 |
| START_JOB | `/aw_robot_status` `robot_state` | 进入运行态 |
| 生成轨迹 | recipe 状态 / 返回码 | 成功 |

---

## 7. 代码骨架(照抄)

### 通道 A —— 通用 robot action
```python
async def robot_action(self, service, mode, scenario=2, serial=None, **extra):
    serial = serial or await self.resolve_serial()
    req = encode_service_request(mode=mode, scenario=scenario, node_id=1,
                                 serial_number=serial,
                                 workspace_id=int(serial) if serial.isdigit() else 0,
                                 agent_type=0, **extra)
    resp, code = await self.call_service(service, req)
    return {"is_accepted": resp.get(1), "response": resp, "code": code}

# 具体操作只是薄封装：
async def reset(self, serial=None):
    return await self.robot_action("/aw_robot_service", ACTION["RESET"], serial=serial)
async def start_job(self, serial=None, **kw):
    return await self.robot_action("/aw_robot_service", 22, scenario=0, serial=serial, **kw)
```

### 通道 B —— REST
```python
def recipe_update_status(self, recipe_id, status):
    payload = json.dumps({"id": recipe_id, "status": status}).encode()
    req = urllib.request.Request(f"{self.api_base}/recipe/updateStatus",
                                 data=payload, method="PATCH",
                                 headers={"Content-Type":"application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())
```

### 新增字段编码时的字段表提取法
```bash
# 从 proto 拿字段号
sed -n '/message XxxRequest/,/}/p' modules/awr_common/msgs/awr_msgs/**/Xxx.proto
# 或从生成 JS 编码器拿 tag
grep -A40 "XxxRequest.encode" src/types/protobuf/awr_msgs.js
```

---

## 8. 联调环境(每个脚本都这样验)

```bash
# 1) 经测试机踏板做端口转发(book: <跳板用户名>@<跳板IP> / 111111),robot=192.168.10.15
ssh -f -N -M -S ~/.ssh/book.ctl -o ControlPersist=1200 \
  -L 127.0.0.1:9094:192.168.10.15:9094 -L 127.0.0.1:1995:192.168.10.15:1995 \
  <跳板用户名>@<跳板IP>
# 2) 本地直接跑(9094 无鉴权,不用登录板子)
python3 ehmi_client.py 127.0.0.1 status
python3 ehmi_client.py 127.0.0.1 <新命令>
```
若 PC 不能直连,可 base64 上传脚本到板子本地 `127.0.0.1` 跑(见 `ehmi-protocol.md` 末尾)。

---

## 9. 给执行 agent 的认领建议(切片)

- **切片 1(P0 闭环)**:`/aw_robot_service` 通用 `robot_action` + RESET/CLEAR_ALARM/INIT_ALL/HOME_ALL;`/aw_robot_status`/`/aw_info` 订阅封装。
- **切片 2(Job/轨迹)**:START/PAUSE/CONTINUE/STOP_JOB、生成/删除轨迹(单条带 wire_id、全部)。
- **切片 3(Recipe 全 CRUD)**:REST 的 update/updateStatus/copy/delete/getOneById + opMap/deviceConf。
- **切片 4(视觉/模板/黄金模板)**:golden_model、template project/refine、qualitycheck、robot_sensor 录制。
- **切片 5(电源/故障)**:8766 JSON 三件套。

**每个切片交付**:①`HmiController` 新方法 ②CLI 子命令 ③真机验证输出贴回 ④`ehmi-protocol.md` 补该服务的字段表与语义。
**统一约束**:走 `call_service`/`subscribe`(已做 id 关联),serial 用 `resolve_serial()`,字段号引用 proto/awr_msgs.js 出处,禁止硬编码板号与凭据。
