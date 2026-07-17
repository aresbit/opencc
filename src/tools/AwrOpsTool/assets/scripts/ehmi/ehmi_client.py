#!/usr/bin/env python3
"""
ehmi_hmi_client.py — AWR HMI 远程控制客户端

通过 WebSocket protobuf 协议连接机器人 ROS Bridge (ws://<robot_ip>:9094)，
实现远程 HMI 控制：订阅 topic、调用 service、发送 action goal。

协议: apollo.ts_awr_bridge.Json (proto2) over binary WebSocket
  type:    subscribe|unsubscribe|publish|request|response|goal|goalResponse
  topic:   topic name (e.g. /aw_robot_status)
  service: service name (e.g. /aw_task_manager_service)
  action:  action name
  id:      request correlation UUID
  msg:     nested protobuf bytes
  code:    response/error code

用法:
  python3 ehmi_client.py <robot_ip> [command]

常用命令 (完整列表见未知命令时的提示):
  status                      查看机器人状态 (订阅 /aw_robot_status)
  agents | bind <name> | rebind | bindmap <map> [wire]   绑定机器人/地图
  lock <recipe_id> <wire_id>  锁精定位 (维护页选好 recipe+wire)
  start-job <recipe_id> <wire> [job_type]   执行作业 (从某线束开始)
  gen-traj [recipe] | single-traj <wire> [recipe]        轨迹生成
  calibrate <4|7|10|13> [arm] 自动化标定 (鱼眼双目/手眼/内窥镜双目/鱼眼左内窥左)
  quality-check <154|155|156|157> [arm]     标定质检 (结果按 std<1.5mm 判定)
  recipe-list | recipe-create <name>        云端 recipe
  ⚠ 全原子指令走 /aw_task_manager_service; workspace_id=DEVICE_ID(142)≠serial(72)

依赖: pip3 install websockets
"""

import asyncio
import websockets
import sys
import json
import time
import struct
import uuid
import urllib.request
import urllib.parse


# ============================================================
# Protobuf wire format encoder/decoder (Json.proto)
# ============================================================

def varint(value):
    """Encode integer as protobuf varint."""
    r = bytearray()
    while value > 0x7f:
        r.append((value & 0x7f) | 0x80)
        value >>= 7
    r.append(value & 0x7f)
    return bytes(r)


def read_varint(data, pos):
    """Read protobuf varint from data at pos. Returns (value, new_pos)."""
    result = 0
    shift = 0
    while pos < len(data):
        byte = data[pos]
        pos += 1
        result |= (byte & 0x7f) << shift
        if not (byte & 0x80):
            break
        shift += 7
    return result, pos


def encode_json_wrapper(**kwargs):
    """Encode apollo.ts_awr_bridge.Json proto2 message.

    Fields:
      1 (string): type    - subscribe|unsubscribe|publish|request|response|goal
      2 (string): topic   - topic name
      3 (bytes):  msg     - nested protobuf payload
      4 (string): service - service name (for RPC)
      5 (string): id      - correlation UUID
      6 (string): action  - action name
      7 (uint32): code    - response code
    """
    r = bytearray()
    fmap = {"type_": 1, "topic": 2, "msg": 3, "service": 4,
            "id_": 5, "action": 6, "code": 7}
    for key, fnum in fmap.items():
        val = kwargs.get(key)
        if val is None:
            continue
        if key == "code":
            r.extend(varint((fnum << 3) | 0))
            r.extend(varint(val))
        elif key == "msg":
            r.extend(varint((fnum << 3) | 2))
            r.extend(varint(len(val)))
            r.extend(val)
        else:
            encoded = str(val).encode("utf-8")
            r.extend(varint((fnum << 3) | 2))
            r.extend(varint(len(encoded)))
            r.extend(encoded)
    return bytes(r)


def decode_json_wrapper(data):
    """Decode apollo.ts_awr_bridge.Json proto2 message."""
    res = {}
    p = 0
    fd = {1: "type", 2: "topic", 3: "msg", 4: "service",
          5: "id", 6: "action", 7: "code"}
    while p < len(data):
        t = data[p]
        p += 1
        fn, wt = t >> 3, t & 7
        if wt == 0:
            v = 0
            s = 0
            while p < len(data):
                b = data[p]
                p += 1
                v |= (b & 0x7f) << s
                if not (b & 0x80):
                    break
                s += 7
        elif wt == 2:
            l = 0
            s = 0
            while p < len(data):
                b = data[p]
                p += 1
                l |= (b & 0x7f) << s
                if not (b & 0x80):
                    break
                s += 7
            v = data[p:p + l]
            p += l
        else:
            break
        res[fd.get(fn, "f" + str(fn))] = v
    return res


# ============================================================
# AwRobotServiceRequest encoder
# Field numbers from awr_msgs.js AwRobotServiceRequest.encode()
# ============================================================

SVC_FIELDS = [
    ("node_id", 1, 0), ("recipe_id", 2, 0), ("task_id", 3, 0),
    ("scenario", 4, 0), ("mode", 5, 0),
    ("param", 6, 1),  # double!
    ("axis_id", 7, 0), ("gripper_id", 8, 0), ("wire_id", 9, 0),
    ("wire_type", 10, 0), ("terminal_type", 11, 0), ("camera_id", 12, 0),
    ("camera_type", 13, 0), ("row", 14, 0), ("col", 15, 0),
    ("gripper_action", 16, 0), ("arm_id", 17, 0), ("arm_motion_type", 18, 0),
    ("aruco_id", 19, 0),
    ("serial_number", 20, 2), ("database_ip", 21, 2),
    ("workspace_id", 22, 0), ("agent_type", 23, 0),
    ("index", 24, 0), ("start_job_type", 25, 0),
    ("kit_id", 26, 0), ("kit_action", 27, 0), ("kit_type", 28, 0),
    ("board_gripper_id", 29, 0), ("board_gripper_status", 30, 0),
]

# Action enum values — EXACT, from HMI enums/robot.ts ACTION enum.
ACTION = {
    "INIT_ALL": 0, "HOME_ALL": 1, "LOAD": 2, "CONNECTION": 3, "WRAP_TAPE": 4,
    "UNLOAD": 5, "CAL_OFFSET": 6, "CONNECTION_START": 7, "ORGANIZE_WIRE": 8,
    "CONNECTION_END": 9, "SINGLE_TRAJECTORY_GENERATION": 10,
    "LOCK_PRECISION_POSITIONING": 15, "UNLOCK_PRECISION_POSITIONING": 16,
    "RESET": 20, "ALARM": 21, "START_JOB": 22, "PAUSE_JOB": 23,
    "CONTINUE_JOB": 24, "STOP_JOB": 25, "LOAD_VERIFY": 26, "CLEAR_ALARM": 27,
    "TO_LOAD_POST": 28, "TO_WAIT_POST": 29, "FISHFIN_GRASP": 30, "PANEL": 31,
    "DELETE_SINGLE_TRAJECTORY": 109, "GENERATE_ALL_TRAJECTORIES": 138,
    "DELETE_ALL_TRAJECTORIES": 139, "CONFIG_CHECK": 143, "MANUAL_MAKER_LOCAL": 155,
}

SCENARIO = {
    "JOB": 0,
    "RECIPE": 1,
    "MAINTAIN": 2,
    "SINGLE_STEP": 3,
}

ARM_ID = {"LEFT": 0, "RIGHT": 1, "DUAL": 2}

# 准备姿态列表顺序 + label(SafePosConfig.vue safePosList)。
# 后端 name 字段就是这些 label;前端按 name===label 匹配(不是纯 index)。
SAFE_POSE_LABELS = [
    "初始准备姿态", "上料准备姿态", "理线准备姿态", "结束位插接准备姿态",
    "起始位插接准备姿态", "下料准备姿态", "归置准备姿态", "缠胶准备姿态",
    "连接器上料准备姿态", "扎带准备姿态", "扎带机安装准备姿态", "扎带机卸载准备姿态",
    "左侧结构光扫描准备姿态", "右侧结构光扫描准备姿态",
]

# 打点日志上报: quickdata 快传的外部数据平台上传接口(FeedbackDialog.vue 硬编码)
QUICKDATA_ISSUE_URL = "https://open.tars-ai.com/api/v1/transform/record_upload"

# ⚠ 轨迹生成/删除:维护页用 ROBOT_MODE 枚举(不是 ACTION!)。
#   ROBOT_MODE.SINGLE_TRAJECTORY_GENERATION=10, DELETE_SINGLE=11, ALL_GEN=12, ALL_DEL=13
#   (ACTION 枚举里同名项是 10/109/138/139,维护页不用)。scenario=MAINTAIN。
TRAJ_MODE = {"SINGLE_GEN": 10, "SINGLE_DEL": 11, "ALL_GEN": 12, "ALL_DEL": 13}

# ROBOT_MODE enum (enums/robot.ts) — 维护/单步类操作用它(与 ACTION 是两套 mode 空间)。
# 目前脚本用到的:REQUEST_DATABASE(同步数据库,START_JOB 前置)。标定同样在 ROBOT_MODE(150-153)。
ROBOT_MODE = {
    "REQUEST_DATABASE": 154,        # 同步数据库到机器人(START_JOB 前置)
    "SINGLE_TRAJECTORY_GENERATION": 10, "DELETE_SINGLE_TRAJECTORY": 11,
    "GENERATE_ALL_TRAJECTORIES": 12, "DELETE_ALL_TRAJECTORIES": 13,
    "FISHEYE_STEREO_CALIBRATION": 150, "FISHEYE_HANDEYE_CALIBRATION": 151,
    "PINHOLE_STEREO_CALIBRATION": 152, "FISHEYE_PINHOLE_LEFT_CALIBRATION": 153,
    # 姿态 / 安全恢复(撞机后回安全位常用)
    "JOINT_MOVE": 110,              # 关节空间运动(移动到准备姿态/关键点用它)
    "MOVE_ALL": 115,                # 全轴/整体运动(getSportMode 的另一取值)
    "MOVE_TO_WAIT_AREA": 118,       # 移动到等候区(scenario=RECIPE)
    "ARM_VERTICAL": 141,            # 一键垂直于地面(scenario=MAINTAIN, 带 arm_id/param)
    "MOVE_ALL_FAR": 156,            # 移动到操作位/远离位(scenario=MAINTAIN)
    # recipe 位姿调整 (poseAdjust.vue)
    "MOVE_INSERT": 117,             # 精调插接移动(fineTuning MOVE-INSERT, RECIPE, arm)
    "MOVE_TO_ARUCO_POSITION": 121,  # 移动到 ArUco 位姿(关键点无 id 时, RECIPE, aruco_id+points)
    "MOVE_TO_LOAD_POSE": 123,       # 调整到上料高度(SINGLE_STEP)
    "MOVE_TO_WIRE_PLUGGING_POSE": 124,  # 调整到理线插接高度(SINGLE_STEP)
}

# 标定: checkType → ROBOT_MODE (autoCalibrationProgress.ts ROBOT_MODE_BY_CHECK_TYPE)
CALIB_MODE_BY_CHECKTYPE = {
    4: 150,   # 鱼眼双目  FISHEYE_STEREO_CALIBRATION
    7: 151,   # 鱼眼手眼  FISHEYE_HANDEYE_CALIBRATION
    10: 152,  # 内窥镜双目 PINHOLE_STEREO_CALIBRATION
    13: 153,  # 鱼眼左目到内窥镜左目 FISHEYE_PINHOLE_LEFT_CALIBRATION
}
CALIB_LABEL = {4: "鱼眼双目", 7: "鱼眼手眼", 10: "内窥镜双目", 13: "鱼眼左目到内窥镜左目"}

# 质检 mode (qualityCheck.vue): 直接用 154-157
QUALITY_CHECK_MODE = {154: "鱼眼双目", 155: "鱼眼手眼",
                      156: "内窥镜双目", 157: "鱼眼左目到内窥镜左目"}
QC_STD_THRESHOLD_MM = 1.5  # 手眼标定总体标准差通过标准 (<1.5mm)


def _as_bytes(v):
    """Coerce a parse_response length-delimited value back to bytes.

    parse_response eagerly UTF-8-decodes length-delimited fields when they are
    valid UTF-8 — which turns all-ASCII nested-message bytes into a str. For
    nested protobuf we need the raw bytes back; utf-8 round-trips losslessly for
    those that decoded, so re-encode.
    """
    if isinstance(v, str):
        return v.encode("utf-8")
    if isinstance(v, (bytes, bytearray)):
        return bytes(v)
    return None


def _f64(b):
    """Decode 8-byte little-endian double from a wiretype-1 field."""
    b = _as_bytes(b)
    if b is not None and len(b) == 8:
        return struct.unpack("<d", b)[0]
    return None


def _qc_passed(task_result_bytes, mode):
    """从 QualitycheckTaskResult(嵌套)判定质检是否通过.

    QualitycheckTaskResult: task=1, stereo_validation_report=2,
        handeye_validation_report=3, fisheye_pinhole_left_...=4.
    HandeyeValidationReport: validate_success=1, overall_std_mm=3(double).
    手眼(155)看 validate_success + overall_std_mm<1.5; 其余看对应 report 是否存在+成功。
    返回 True/False/None(无法判定)。
    """
    t = parse_response(_as_bytes(task_result_bytes))
    if mode == 155:  # 鱼眼手眼 → handeye_validation_report (field 3)
        hv = _as_bytes(t.get(3))
        if hv is None:
            return None
        h = parse_response(hv)
        ok = bool(h.get(1))
        std = _f64(h.get(3))
        if std is not None:
            return ok and std < QC_STD_THRESHOLD_MM
        return ok
    # 鱼眼/内窥镜双目(154/156) → stereo_validation_report(field 2);
    # 鱼眼左目到内窥镜左目(157) → fisheye_pinhole_left(field 4)
    rep = t.get(2) if mode in (154, 156) else t.get(4)
    return rep is not None or None

AGENT_TYPE = {
    "PLUGGING_ROBOT": 0,
}


def encode_service_request(**fields):
    """Encode AwRobotServiceRequest protobuf message."""
    r = bytearray()
    for fname, fnum, wtype in SVC_FIELDS:
        val = fields.get(fname)
        if val is None:
            continue
        if wtype == 2:  # string
            e = str(val).encode("utf-8")
            r.extend(varint((fnum << 3) | 2))
            r.extend(varint(len(e)))
            r.extend(e)
        elif wtype == 1:  # double
            r.extend(varint((fnum << 3) | 1))
            r.extend(struct.pack("<d", float(val)))
        else:  # varint
            r.extend(varint((fnum << 3) | 0))
            r.extend(varint(int(val)))
    return bytes(r)


def _nz(**kwargs):
    """Return only the non-None kwargs (for optional protobuf fields)."""
    return {k: v for k, v in kwargs.items() if v is not None}


def parse_response(data):
    """Parse a generic protobuf message into a dict of {field_num: value}.

    Reads the field tag as a full varint (field numbers >= 16 use multi-byte
    tags), and handles wiretypes 0 (varint), 2 (length-delimited), 1 (64-bit),
    5 (32-bit). Later occurrences of a repeated field overwrite earlier ones.
    """
    result = {}
    p = 0
    while p < len(data):
        tag, p = read_varint(data, p)
        fn, wt = tag >> 3, tag & 7
        if wt == 0:  # varint
            v, p = read_varint(data, p)
        elif wt == 2:  # length-delimited (string/bytes/nested)
            length, p = read_varint(data, p)
            v = data[p:p + length]
            p += length
            try:
                v = v.decode("utf-8")
            except Exception:
                pass
        elif wt == 1:  # 64-bit
            v = data[p:p + 8]
            p += 8
        elif wt == 5:  # 32-bit
            v = data[p:p + 4]
            p += 4
        else:
            break
        result[fn] = v
    return result


# ============================================================
# RobotBindServiceRequest encoder
# Field numbers from awr_msgs/srv/RobotBindService.proto
# ============================================================

BIND_MODE = {
    "BIND": 1,
    "UNBIND": 2,
}


def encode_bind_request(mode, serial_number, database_ip="",
                        database_port=0, agent_type=0,
                        workspace_id=0, timestamp_ms=None):
    """Encode RobotBindServiceRequest protobuf message.

    Fields:
      1 (uint32): mode       — 1=Bind, 2=Unbind
      2 (string): serial_number
      3 (string): database_ip
      4 (uint32): database_port
      5 (uint32): agent_type
      6 (uint32): workspace_id
      7 (uint64): timestamp_ms — unix timestamp in milliseconds
    """
    if timestamp_ms is None:
        timestamp_ms = int(time.time() * 1000)

    r = bytearray()

    def add_varint(fn, val):
        if val:
            r.extend(varint((fn << 3) | 0))
            r.extend(varint(val))

    def add_string(fn, val):
        if val:
            e = val.encode("utf-8")
            r.extend(varint((fn << 3) | 2))
            r.extend(varint(len(e)))
            r.extend(e)

    add_varint(1, mode)
    add_string(2, serial_number)
    add_string(3, database_ip)
    add_varint(4, database_port)
    add_varint(5, agent_type)
    add_varint(6, workspace_id)
    add_varint(7, timestamp_ms)
    return bytes(r)


# ============================================================
# Map bind (envcheck) — pub/sub flow, NOT a service.
# Source: settingPage.vue toPublishMap + modules/awr_envcheck/proto/map_bind.proto
# ============================================================

WIRE_TYPE = {
    "UNKNOWN": 0, "C134": 1, "THHB": 2, "THD30": 3, "AIO": 4,
}

MAP_PATTERN = {
    "UNKNOWN": 0, "AIO": 1, "LZY_TH": 2, "OP": 3,
}

MAP_BIND_RESULT = {0: "UNKNOWN(中间态)", 1: "SUCCESS", 2: "FAILED"}

MAP_BIND_ERROR = {
    0: "NONE", 1301: "INVALID_REQUEST(map_name空/非法)",
    1302: "RESOURCE_MISSING(内置zip不存在)", 1303: "UNZIP_FAILED",
    1304: "RENAME_FAILED", 1305: "NO_PERMISSION", 1306: "USER_TIMEOUT",
    1399: "INTERNAL",
}


def _encode_header(sec=None, nsec=0, seq=0, frame_id=""):
    """Encode tars.std_msgs.Header{seq=1, stamp=2 time{sec=1,nsec=2}, frame_id=3}."""
    if sec is None:
        sec = int(time.time())
    inner_time = bytearray()
    inner_time.extend(varint((1 << 3) | 0)); inner_time.extend(varint(int(sec)))
    inner_time.extend(varint((2 << 3) | 0)); inner_time.extend(varint(int(nsec)))
    h = bytearray()
    h.extend(varint((1 << 3) | 0)); h.extend(varint(int(seq)))           # seq
    h.extend(varint((2 << 3) | 2)); h.extend(varint(len(inner_time))); h.extend(inner_time)  # stamp
    fid = frame_id.encode("utf-8")
    h.extend(varint((3 << 3) | 2)); h.extend(varint(len(fid))); h.extend(fid)  # frame_id
    return bytes(h)


def encode_map_bind_request(request_id, serial_number, map_name,
                            wire_harness, with_header=True):
    """Encode AwrMapBindRequest.

    Fields: 1 header(msg,opt), 2 request_id(str), 3 serial_number(str),
            4 map_name(str), 5 wire_harness(enum WireType).
    """
    r = bytearray()
    if with_header:
        hdr = _encode_header()
        r.extend(varint((1 << 3) | 2)); r.extend(varint(len(hdr))); r.extend(hdr)

    def add_string(fn, val):
        e = str(val).encode("utf-8")
        r.extend(varint((fn << 3) | 2)); r.extend(varint(len(e))); r.extend(e)

    add_string(2, request_id)
    add_string(3, serial_number)
    add_string(4, map_name)
    r.extend(varint((5 << 3) | 0)); r.extend(varint(int(wire_harness)))  # wire_harness enum
    return bytes(r)


def encode_map_provision_select(request_id, pattern, with_header=True):
    """Encode AwrMapProvisionSelect{1 header, 2 request_id, 3 pattern(enum)}."""
    r = bytearray()
    if with_header:
        hdr = _encode_header()
        r.extend(varint((1 << 3) | 2)); r.extend(varint(len(hdr))); r.extend(hdr)
    e = str(request_id).encode("utf-8")
    r.extend(varint((2 << 3) | 2)); r.extend(varint(len(e))); r.extend(e)
    r.extend(varint((3 << 3) | 0)); r.extend(varint(int(pattern)))
    return bytes(r)


# ============================================================
# 移动到准备姿态 / 安全姿态 (SafePosConfig.vue buildSafePosMovePayload)
# AwRobotServiceRequest 扩展字段: joint_values=32(rep double,不packed),
#   joint_names=33(rep string), points=37(rep Pose)。
# Pose{position:Point{x1,y1,z1}, orientation:Quaternion{x1,y2,z3,w4}} 全 double。
# ============================================================

def _dfield(fnum, val):
    """一个 double 字段 (wiretype 1)。"""
    return varint((fnum << 3) | 1) + struct.pack("<d", float(val or 0.0))


def _q(quat):
    """Quaternion dict/list → (x,y,z,w)。"""
    if isinstance(quat, dict):
        return (quat.get("x", 0), quat.get("y", 0), quat.get("z", 0), quat.get("w", 0))
    quat = list(quat or [])
    return tuple((quat + [0, 0, 0, 0])[:4])


def _encode_pose(pos_xyz, quat_xyzw):
    """geometry Pose bytes: position(Point) + orientation(Quaternion)。"""
    pos_xyz = list(pos_xyz or [0, 0, 0])
    pt = _dfield(1, pos_xyz[0]) + _dfield(2, pos_xyz[1] if len(pos_xyz) > 1 else 0) \
        + _dfield(3, pos_xyz[2] if len(pos_xyz) > 2 else 0)
    qx, qy, qz, qw = _q(quat_xyzw)
    qt = _dfield(1, qx) + _dfield(2, qy) + _dfield(3, qz) + _dfield(4, qw)
    r = bytearray()
    r.extend(varint((1 << 3) | 2)); r.extend(varint(len(pt))); r.extend(pt)   # position
    r.extend(varint((2 << 3) | 2)); r.extend(varint(len(qt))); r.extend(qt)   # orientation
    return bytes(r)


def encode_safe_pos_move(mode, scenario, recipe_id, arm_id, serial_number,
                         workspace_id, joints_pos, points, aruco_id=None):
    """AwRobotServiceRequest for 移动到准备姿态/关键点 (buildSafePosMovePayload / poseAdjust moveTo 复刻)。

    joints_pos: {joint_name: value} dict → joint_values(32)+joint_names(33)(空则不带,用于 ArUco 移动)
    points: [(pos3, quat), ...] → 每个 Pose 走 points(37)。前端顺序 = 左/右/base(或单臂)。
    aruco_id: MOVE_TO_ARUCO_POSITION 时带(字段 19)。
    """
    # 标量字段复用 encode_service_request(字段顺序不影响解析)
    req = bytearray(encode_service_request(
        mode=mode, scenario=scenario, node_id=1, recipe_id=recipe_id,
        arm_id=arm_id, serial_number=serial_number, workspace_id=workspace_id,
        agent_type=0, **({"aruco_id": aruco_id} if aruco_id is not None else {})))
    # joint_values (32, rep double, 非 packed)
    for v in (joints_pos.values() if isinstance(joints_pos, dict) else (joints_pos or [])):
        req.extend(_dfield(32, v))
    # joint_names (33, rep string)
    for n in (joints_pos.keys() if isinstance(joints_pos, dict) else []):
        e = str(n).encode("utf-8")
        req.extend(varint((33 << 3) | 2)); req.extend(varint(len(e))); req.extend(e)
    # points (37, rep Pose)
    for pos, quat in (points or []):
        pb = _encode_pose(pos, quat)
        req.extend(varint((37 << 3) | 2)); req.extend(varint(len(pb))); req.extend(pb)
    return bytes(req)


# ============================================================
# 打点日志上报 / 问题上报 (FeedbackDialog.vue onSubmit)
#   publish /tars/quickdata/request (TSQuickDataRequest, 日志/录制数据快传上报)
#   + publish /issue_report (IssueReport, 录制中打标记点)
# ============================================================

def _pf_str(fnum, val):
    if val is None or val == "":
        return b""
    e = str(val).encode("utf-8")
    return varint((fnum << 3) | 2) + varint(len(e)) + e


def _pf_var(fnum, val):
    if not val:
        return b""
    return varint((fnum << 3) | 0) + varint(int(val))


def encode_issue_report(issue_detail=None, operator=None, take_over_type=0,
                        tag_type=1, timestamp_ms=None, header="", feature=None,
                        module=None, version=None, assignee=None):
    """IssueReport(/issue_report): header1,tag_type2,issue_detail3,feature4,
    module5,version6,assignee7,operator8,take_over_type9,timestamp10。
    tag_type: LOG0/NORMAL1/WARNING2/ERROR3; take_over_type: NONE0/INVALID1/TAKEOVER2。"""
    if timestamp_ms is None:
        timestamp_ms = int(time.time() * 1000)
    r = bytearray()
    r.extend(_pf_str(1, header or ""))          # required string(空也发)
    r.extend(_pf_var(2, tag_type))
    r.extend(_pf_str(3, issue_detail))
    r.extend(_pf_str(4, feature)); r.extend(_pf_str(5, module))
    r.extend(_pf_str(6, version)); r.extend(_pf_str(7, assignee))
    r.extend(_pf_str(8, operator))
    r.extend(_pf_var(9, take_over_type))
    r.extend(_pf_var(10, timestamp_ms))
    return bytes(r)


def encode_quickdata_request(request_id, issue_url, request_timestamp, device_id,
                             tag_type=1, issue_detail=None, operator_name=None,
                             take_over_type=0, location="ShangHai", purpose="AWR",
                             task_type="AWR", hardware=None, package_version="0.0.0",
                             test_type="研发自测", issue_title=None, handler_name=None,
                             recipe_id=None, device_sn=None, logsegment_name=None):
    """TSQuickDataRequest(/tars/quickdata/request): 字段号见 QuickData.proto(1-19)。"""
    r = bytearray()
    r.extend(_pf_str(1, request_id)); r.extend(_pf_str(2, issue_url))
    r.extend(_pf_var(3, request_timestamp)); r.extend(_pf_str(4, device_id))
    r.extend(_pf_str(5, device_sn)); r.extend(_pf_var(6, tag_type))
    r.extend(_pf_str(7, issue_detail)); r.extend(_pf_str(8, operator_name))
    r.extend(_pf_var(9, take_over_type)); r.extend(_pf_str(10, location))
    r.extend(_pf_str(11, purpose)); r.extend(_pf_str(12, task_type))
    r.extend(_pf_str(13, hardware)); r.extend(_pf_str(14, package_version))
    r.extend(_pf_str(15, test_type)); r.extend(_pf_str(16, logsegment_name))
    r.extend(_pf_str(17, issue_title)); r.extend(_pf_str(18, handler_name))
    r.extend(_pf_var(19, recipe_id))
    return bytes(r)


# ============================================================
# High-level HMI operations
# ============================================================

class HmiController:
    """Remote HMI control via WebSocket protobuf protocol."""

    def __init__(self, robot_ip="192.168.10.15", ros_bridge_port=9094):
        self.url = f"ws://{robot_ip}:{ros_bridge_port}"
        self.ws = None
        self.device_id = "142"
        self.api_base = "https://awr-backend-test.tars-ai.com/api"

    async def connect(self):
        """Connect to the HMI ROS bridge."""
        self.ws = await websockets.connect(self.url)
        print(f"Connected to {self.url}")

    async def close(self):
        if self.ws:
            await self.ws.close()

    @staticmethod
    def _s(val):
        """Decode a wrapper field that may be bytes into str."""
        if isinstance(val, (bytes, bytearray)):
            return val.decode("utf-8", "ignore")
        return val

    async def call_service(self, service_name, request_bytes, timeout=15.0):
        """Call a service via WebSocket RPC. Returns (response_dict, code).

        The ROS bridge multiplexes topic publishes and service responses over
        the same socket, so a single blind recv() can grab an unrelated
        `/aw_robot_status` publish instead of our response — which is exactly
        why bind/unbind appeared to "fail" (returned is_accepted=0) while the
        server actually accepted it. We must loop and correlate on the request
        `id`, skipping every frame that is not our matching `response`.
        """
        rid = "svc_" + uuid.uuid4().hex[:12]
        wrapper = encode_json_wrapper(
            type_="request", service=service_name,
            msg=request_bytes, id_=rid
        )
        await self.ws.send(wrapper)
        deadline = time.time() + timeout
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                return {"error": "timeout"}, None
            try:
                raw = await asyncio.wait_for(self.ws.recv(), timeout=remaining)
            except asyncio.TimeoutError:
                return {"error": "timeout"}, None
            msg = decode_json_wrapper(raw)
            mtype = self._s(msg.get("type"))
            mid = self._s(msg.get("id"))
            # Ignore topic publishes and anything not carrying our id.
            if mtype == "publish":
                continue
            if mid is not None and mid != rid:
                continue
            if mtype not in (None, "response"):
                continue
            resp = msg.get("msg", b"")
            code = msg.get("code", None)
            return (parse_response(resp) if resp else {}), code

    async def subscribe(self, topic, timeout=8.0):
        """Subscribe to a topic and return the first matching publish payload.

        Filters out stale service responses so callers only get topic data.
        """
        sub = encode_json_wrapper(type_="subscribe", topic=topic)
        await self.ws.send(sub)
        deadline = time.time() + timeout
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                return None
            try:
                raw = await asyncio.wait_for(self.ws.recv(), timeout=remaining)
            except asyncio.TimeoutError:
                return None
            msg = decode_json_wrapper(raw)
            mtype = self._s(msg.get("type"))
            mtopic = self._s(msg.get("topic"))
            if mtype == "response":
                continue
            if mtopic is not None and mtopic != topic:
                continue
            payload = msg.get("msg", b"")
            if payload:
                return payload

    async def resolve_serial(self, timeout=6.0):
        """Auto-detect this cell's plugging-robot serial from /aw_robot_status.

        Avoids hardcoding a board number (e.g. 142 vs 72). Returns the serial
        string of the first plugging agent (agent_type==0) seen, else None.
        """
        online = await self.collect_online_agents(duration=min(timeout, 4.0))
        for serial, info in online.items():
            if info.get("agent_type") in (0, None):
                return serial
        # fallback: any online serial
        return next(iter(online), None)

    async def collect_online_agents(self, duration=6.0):
        """Collect all agents currently publishing on /aw_robot_status.

        /aw_robot_status is a MULTI-agent topic keyed by serial_number; each
        online agent publishes its own status. The HMI's bind dropdown treats
        "publishing at all" as online (agent_status != OFFLINE). Returns
        {serial: {agent_status, agent_type, is_bound}}.
        """
        sub = encode_json_wrapper(type_="subscribe", topic="/aw_robot_status")
        await self.ws.send(sub)
        seen = {}
        deadline = time.time() + duration
        while time.time() < deadline:
            try:
                raw = await asyncio.wait_for(self.ws.recv(),
                                             timeout=max(0.1, deadline - time.time()))
            except asyncio.TimeoutError:
                break
            msg = decode_json_wrapper(raw)
            if self._s(msg.get("type")) == "response":
                continue
            payload = msg.get("msg", b"")
            if not payload:
                continue
            r = parse_response(payload)
            serial = self._s(r.get(3))
            if serial is None:
                continue
            seen[serial] = {
                "agent_status": r.get(11),   # 1=online-idle, 2=online-in-workspace
                "agent_type": r.get(12),     # 0=plugging/理线, 1=cruising
                "is_bound": r.get(7, 0) == 1,
            }
        return seen

    def agent_list_rest(self):
        """GET /agent/getList — the DB agent records (name + serial_number)."""
        url = f"{self.api_base}/agent/getList"
        try:
            with urllib.request.urlopen(url, timeout=8) as resp:
                data = json.loads(resp.read())
                return data if isinstance(data, list) else []
        except Exception as e:
            return [{"error": str(e)}]

    async def list_bindable_agents(self, agent_type=0, duration=6.0):
        """Reproduce the HMI bind dropdown (BindRobotDialog.vue agentList).

        = DB agents whose serial_number is currently online on /aw_robot_status
          AND whose agent_type matches (topic value preferred, DB as fallback).
        Returns [{name, serial_number, agent_type, agent_status, is_bound}].
        """
        online = await self.collect_online_agents(duration=duration)
        db = {str(a.get("serial_number")): a for a in self.agent_list_rest()
              if isinstance(a, dict) and a.get("serial_number") is not None}
        result = []
        for serial, info in online.items():
            # topic agent_type preferred; DB agent_type as fallback
            atype = info.get("agent_type")
            if atype is None:
                atype = db.get(serial, {}).get("agent_type")
            if atype != agent_type:
                continue
            result.append({
                "name": db.get(serial, {}).get("name", f"agent{serial}"),
                "serial_number": serial,
                "agent_type": atype,
                "agent_status": info.get("agent_status"),
                "is_bound": info.get("is_bound"),
            })
        return result

    async def resolve_agent(self, identifier, agent_type=0):
        """Resolve a dropdown selection (name like 'agent72' OR serial '72') to
        the serial_number that bind actually sends. Mirrors picking an option
        whose :value is item.serial_number and :label is item.name.
        """
        agents = await self.list_bindable_agents(agent_type=agent_type)
        ident = str(identifier)
        for a in agents:
            if ident in (a["serial_number"], a["name"]):
                return a["serial_number"]
        # not in the online/bindable set — fall back to DB name lookup
        for a in self.agent_list_rest():
            if isinstance(a, dict) and ident == a.get("name"):
                return str(a.get("serial_number"))
        # last resort: assume the identifier already is a serial
        return ident if ident and ident != "auto" else None

    # ---- Task Manager operations ----
    # 维护页原子指令走 robotService → /aw_task_manager_service,并带 recipe_id/wire_id。
    # 锁精定位前需在维护页选好 Recipe + Wire(前端 recipeVal/wireVal)。

    async def lock_refinement(self, serial=None, recipe_id=None, wire_id=None,
                              workspace_id=None):
        """锁精定位 (TC-04). 需 recipe_id + wire_id(维护页已选)。"""
        return await self.robot_action(
            ACTION["LOCK_PRECISION_POSITIONING"], scenario=SCENARIO["MAINTAIN"],
            serial=serial, workspace_id=workspace_id,
            **_nz(recipe_id=recipe_id, wire_id=wire_id))

    async def manual_refinement(self, serial=None, recipe_id=None, wire_id=None,
                                workspace_id=None):
        """手动微调精定位 (mode 155)。"""
        return await self.robot_action(
            ACTION["MANUAL_MAKER_LOCAL"], scenario=SCENARIO["MAINTAIN"],
            serial=serial, workspace_id=workspace_id,
            **_nz(recipe_id=recipe_id, wire_id=wire_id))

    async def unlock_refinement(self, serial=None, recipe_id=None, wire_id=None,
                                workspace_id=None):
        """解锁精定位 (mode 16)。"""
        return await self.robot_action(
            ACTION["UNLOCK_PRECISION_POSITIONING"], scenario=SCENARIO["MAINTAIN"],
            serial=serial, workspace_id=workspace_id,
            **_nz(recipe_id=recipe_id, wire_id=wire_id))

    # ---- Robot Bind operations ----

    async def bind_robot(self, serial="142", workspace_id=142,
                         database_ip="", database_port=0,
                         agent_type=0):
        """Bind robot to device (绑定机器人).

        Calls /robot_bind_service with mode=1 (Bind).
        Response is_accepted: 0=failed, 1=success, 2=already bound.
        """
        req = encode_bind_request(
            mode=BIND_MODE["BIND"],
            serial_number=serial,
            database_ip=database_ip,
            database_port=database_port,
            agent_type=agent_type,
            workspace_id=workspace_id,
        )
        resp, code = await self.call_service("/robot_bind_service", req)
        is_accepted = resp.get(1, 0)
        return {
            "success": is_accepted == 1,
            "already_bound": is_accepted == 2,
            "is_accepted": is_accepted,
            "response": resp,
            "code": code,
        }

    async def unbind_robot(self, serial="142", workspace_id=142,
                           database_ip="", database_port=0,
                           agent_type=0):
        """Unbind robot from device (解绑机器人).

        Calls /robot_bind_service with mode=2 (Unbind).
        """
        req = encode_bind_request(
            mode=BIND_MODE["UNBIND"],
            serial_number=serial,
            database_ip=database_ip,
            database_port=database_port,
            agent_type=agent_type,
            workspace_id=workspace_id,
        )
        resp, code = await self.call_service("/robot_bind_service", req)
        is_accepted = resp.get(1, 0)
        return {
            "success": is_accepted == 1,
            "is_accepted": is_accepted,
            "response": resp,
            "code": code,
        }

    async def bind_map(self, serial, map_name, wire_harness=2,
                       pattern=None, timeout=60.0):
        """绑定操作地图 (settingPage.vue 保存地图 / toPublishMap).

        pub/sub 流程,按 request_id 关联:
          1. publish /tars/envcheck/map_bind_request
          2. 若收到 /tars/envcheck/map_provision_required → publish
             /tars/envcheck/map_provision_select(pattern) (需 pattern,否则报缺素材需人工选)
          3. 收 /tars/envcheck/map_bind_status: result 1=成功, 2=失败

        前置: 机器人须已绑定 (serial 为已绑定 agent)。
        """
        rid = uuid.uuid4().hex
        # 先订阅两个响应 topic,再 publish,避免漏掉快响应
        for t in ("/tars/envcheck/map_bind_status",
                  "/tars/envcheck/map_provision_required"):
            await self.ws.send(encode_json_wrapper(type_="subscribe", topic=t))
        await asyncio.sleep(0.3)

        req = encode_map_bind_request(rid, str(serial), map_name, int(wire_harness))
        await self.ws.send(encode_json_wrapper(
            type_="publish", topic="/tars/envcheck/map_bind_request", msg=req))

        events = []
        deadline = time.time() + timeout
        provision_sent = False
        while time.time() < deadline:
            try:
                raw = await asyncio.wait_for(self.ws.recv(),
                                             timeout=max(0.1, deadline - time.time()))
            except asyncio.TimeoutError:
                break
            msg = decode_json_wrapper(raw)
            topic = self._s(msg.get("topic"))
            if self._s(msg.get("type")) == "response":
                continue
            payload = msg.get("msg", b"")
            if not payload or topic not in (
                    "/tars/envcheck/map_bind_status",
                    "/tars/envcheck/map_provision_required"):
                continue
            r = parse_response(payload)
            req_id = self._s(r.get(2))
            if req_id != rid:
                continue  # 别的请求
            if topic == "/tars/envcheck/map_provision_required":
                events.append(("provision_required", self._s(r.get(3))))
                if pattern is not None and not provision_sent:
                    sel = encode_map_provision_select(rid, int(pattern))
                    await self.ws.send(encode_json_wrapper(
                        type_="publish",
                        topic="/tars/envcheck/map_provision_select", msg=sel))
                    provision_sent = True
                    deadline = time.time() + timeout  # 选完重置超时
                else:
                    return {"success": False, "need_pattern": True,
                            "request_id": rid, "events": events,
                            "map_name": self._s(r.get(3))}
                continue
            # map_bind_status
            result = r.get(4, 0)
            if result == 1:
                return {"success": True, "result": result,
                        "request_id": rid, "events": events}
            elif result == 2:
                return {"success": False, "result": result,
                        "error_code": r.get(5), "error": MAP_BIND_ERROR.get(r.get(5), r.get(5)),
                        "failure_reason": self._s(r.get(6)),
                        "request_id": rid, "events": events}
            # result 0 = 中间态,继续等
            events.append(("status", MAP_BIND_RESULT.get(result, result)))
        return {"success": False, "error": "timeout", "request_id": rid, "events": events}

    async def get_robot_status(self):
        """Subscribe to /aw_robot_status and parse key fields.

        agent_status (field 11): 1=ONLINE_WITHOUT_WORKSPACE (unbound),
                                  2=ONLINE_WITH_WORKSPACE (bound).
        """
        data = await self.subscribe("/aw_robot_status")
        if not data:
            return {"error": "no data"}
        resp = parse_response(data)
        return {
            "serial": self._s(resp.get(3, "?")),
            "state": resp.get(2, "?"),
            "agent_status": resp.get(11),
            "in_workspace": resp.get(11) == 2,
            "is_bound": resp.get(7, 0) == 1,
        }

    async def rebind_robot(self, serial="72", workspace_id=72,
                           database_ip="", database_port=0, agent_type=0):
        """Idempotent bind for automation: unbind-if-needed, then bind, verify.

        The server handler (task_manager.cpp robot_bind_service_callback) only
        accepts ADD_TO_WORKSPACE when the agent is ONLINE_WITHOUT_WORKSPACE and
        has NO already-bound (is_accepted=2) path — an already-bound agent just
        gets the default is_accepted=0. So to guarantee a fresh bind we drop it
        out of the workspace first.
        """
        status = await self.get_robot_status()
        steps = []
        if status.get("in_workspace"):
            u = await self.unbind_robot(serial=serial, workspace_id=workspace_id,
                                        database_ip=database_ip,
                                        database_port=database_port,
                                        agent_type=agent_type)
            steps.append(("unbind", u.get("is_accepted")))
            await asyncio.sleep(1.5)
        b = await self.bind_robot(serial=serial, workspace_id=workspace_id,
                                  database_ip=database_ip,
                                  database_port=database_port,
                                  agent_type=agent_type)
        steps.append(("bind", b.get("is_accepted")))
        await asyncio.sleep(1.5)
        final = await self.get_robot_status()
        return {
            "success": b.get("success") and final.get("in_workspace"),
            "steps": steps,
            "final_status": final,
        }

    # ---- Generic robot action (aw_robot_service / aw_task_manager_service) ----

    async def robot_action(self, mode, scenario=2, serial=None, workspace_id=None,
                           service="/aw_task_manager_service", timeout=15.0, **extra):
        """Send one AwRobotServiceRequest (the ACTION enum). Returns is_accepted.

        ⚠ 全 HMI 原子指令都走 /aw_task_manager_service(前端 robotService),
        `/aw_robot_service` 实际未使用。robotService 会补 workspace_id=DEVICE_ID +
        node_id=HMI + agent_type,这里对齐。

        ⚠ workspace_id = DEVICE_ID(板号,如 board142→142),**不等于** agent serial(如72)。
        默认回退到 int(serial),但涉及 recipe 的操作(lock/job/traj)应显式传 workspace_id。

        extra: 任意 AwRobotServiceRequest 字段 (recipe_id, wire_id, arm_id,
               gripper_id, index, start_job_type, param, ...).
        """
        if serial is None:
            serial = await self.resolve_serial() or "0"
        if workspace_id is None:
            workspace_id = self.device_id if str(self.device_id).isdigit() else (
                int(serial) if str(serial).isdigit() else 0)
        req = encode_service_request(
            mode=mode, scenario=scenario, node_id=1, serial_number=serial,
            workspace_id=int(workspace_id),
            agent_type=AGENT_TYPE["PLUGGING_ROBOT"], **extra)
        resp, code = await self.call_service(service, req, timeout=timeout)
        return {"success": resp.get(1, 0) == 1, "is_accepted": resp.get(1),
                "response": resp, "code": code}

    # Thin wrappers over robot_action (names mirror ACTION enum / HMI buttons)
    async def reset(self, serial=None):
        return await self.robot_action(ACTION["RESET"], serial=serial)

    async def clear_alarm(self, serial=None):
        return await self.robot_action(ACTION["CLEAR_ALARM"], serial=serial)

    async def init_all(self, serial=None):
        return await self.robot_action(ACTION["INIT_ALL"], serial=serial)

    async def home_all(self, serial=None):
        return await self.robot_action(ACTION["HOME_ALL"], serial=serial)

    async def config_check(self, serial=None):
        return await self.robot_action(ACTION["CONFIG_CHECK"], serial=serial)

    async def sync_database(self, recipe_id, serial=None, workspace_id=None):
        """同步数据库到机器人 (ROBOT_MODE.REQUEST_DATABASE=154, scenario=MAINTAIN).

        前端 handleStartClick 在 START_JOB 之前必做这一步(“保存端子后同步数据库”),
        把 recipe 的端子/布线数据下发到机器人运行时。跳过它 job 会建好行为树但无数据可执行、卡住。
        """
        return await self.robot_action(
            ROBOT_MODE["REQUEST_DATABASE"], scenario=SCENARIO["MAINTAIN"],
            serial=serial, workspace_id=workspace_id, **_nz(recipe_id=recipe_id))

    async def start_job(self, serial=None, recipe_id=None, wire_id=None,
                        start_job_type=0, workspace_id=None, sync=True,
                        load_verify=True):
        """启动作业, 复刻前端 handleStartClick + handleAction(START_JOB) 的完整后端序列:
          1. (sync=True) REQUEST_DATABASE(154/MAINTAIN) 同步数据库到机器人
          2. START_JOB(22/JOB)  — 建行为树, is_accepted
          3. (load_verify=True) LOAD_VERIFY(26/JOB) 确认上料  ← 让 load 节点往下、机械臂开动!

        缺 3 则行为树建好但 load 节点一直等、机械臂不动(实测)。
        wire_id=起始线束的 DB id; start_job_type: 0=CONNECTION(理线插接)/1=WRAP_TAPE(缠绞)。
        前端二次确认框(物料/端子/布线校验)是人工安全门, 脚本里由调用方负责已确认。
        """
        steps = {}
        if sync and recipe_id is not None:
            db = await self.sync_database(recipe_id, serial=serial, workspace_id=workspace_id)
            steps["sync_database"] = db.get("is_accepted")
            await asyncio.sleep(1.5)   # 给同步留时间
        res = await self.robot_action(
            ACTION["START_JOB"], scenario=SCENARIO["JOB"], serial=serial,
            workspace_id=workspace_id, start_job_type=start_job_type,
            **_nz(recipe_id=recipe_id, wire_id=wire_id))
        steps["start_job"] = res.get("is_accepted")
        if load_verify:
            await asyncio.sleep(1.0)
            lv = await self.robot_action(
                ACTION["LOAD_VERIFY"], scenario=SCENARIO["JOB"], serial=serial,
                workspace_id=workspace_id, start_job_type=start_job_type,
                **_nz(recipe_id=recipe_id, wire_id=wire_id))
            steps["load_verify"] = lv.get("is_accepted")
        res["steps"] = steps
        return res

    async def pause_job(self, serial=None):
        return await self.robot_action(ACTION["PAUSE_JOB"], scenario=SCENARIO["JOB"], serial=serial)

    async def continue_job(self, serial=None):
        return await self.robot_action(ACTION["CONTINUE_JOB"], scenario=SCENARIO["JOB"], serial=serial)

    async def stop_job(self, serial=None):
        return await self.robot_action(ACTION["STOP_JOB"], scenario=SCENARIO["JOB"], serial=serial)

    # ⚠ 轨迹生成走维护页(maintainPage.vue),用 ROBOT_MODE 枚举(10/11/12/13),
    #   scenario=MAINTAIN,带 recipe_id + wire_id。不是 ACTION 枚举的 138/139/109!
    async def generate_all_trajectories(self, serial=None, recipe_id=None, workspace_id=None):
        return await self.robot_action(TRAJ_MODE["ALL_GEN"], scenario=SCENARIO["MAINTAIN"],
                                       serial=serial, workspace_id=workspace_id,
                                       **_nz(recipe_id=recipe_id))

    async def delete_all_trajectories(self, serial=None, recipe_id=None, workspace_id=None):
        return await self.robot_action(TRAJ_MODE["ALL_DEL"], scenario=SCENARIO["MAINTAIN"],
                                       serial=serial, workspace_id=workspace_id,
                                       **_nz(recipe_id=recipe_id))

    async def single_trajectory(self, wire_id, serial=None, recipe_id=None,
                                delete=False, workspace_id=None):
        """单条轨迹生成/删除. wire_id = 线束的数据库 id(不是序号!)。"""
        mode = TRAJ_MODE["SINGLE_DEL"] if delete else TRAJ_MODE["SINGLE_GEN"]
        return await self.robot_action(mode, scenario=SCENARIO["MAINTAIN"], serial=serial,
                                       workspace_id=workspace_id, wire_id=wire_id,
                                       **_nz(recipe_id=recipe_id))

    # ---- 姿态 / 安全恢复 (撞机后回安全位) ----
    # 源: maintainPage.vue(移动到操作位) / RobotControlPanel.vue(一键垂直) /
    #     agentConfig.vue(等候区) / SafePosConfig.vue handleMove(移动到准备姿态)

    async def move_operation_pose(self, serial=None, recipe_id=None, workspace_id=None):
        """移动到操作位/远离位 (MOVE_ALL_FAR=156, MAINTAIN)。撞机后最简单稳健的安全恢复。"""
        return await self.robot_action(ROBOT_MODE["MOVE_ALL_FAR"], scenario=SCENARIO["MAINTAIN"],
                                       serial=serial, workspace_id=workspace_id,
                                       **_nz(recipe_id=recipe_id))

    async def arm_vertical(self, arm_id=0, param=1.0, serial=None, workspace_id=None):
        """一键垂直于地面 (ARM_VERTICAL=141, MAINTAIN, 带 arm_id/param)。"""
        return await self.robot_action(ROBOT_MODE["ARM_VERTICAL"], scenario=SCENARIO["MAINTAIN"],
                                       serial=serial, workspace_id=workspace_id,
                                       arm_id=arm_id, param=param)

    async def move_wait_area(self, serial=None, workspace_id=None):
        """移动到等候区 (MOVE_TO_WAIT_AREA=118, RECIPE)。"""
        return await self.robot_action(ROBOT_MODE["MOVE_TO_WAIT_AREA"], scenario=SCENARIO["RECIPE"],
                                       serial=serial, workspace_id=workspace_id)

    def safe_pos_list(self, recipe_id):
        """该 recipe 的准备姿态列表。

        ⚠ 前端 SafePosConfig.getSafePos 用 `apiGetRobotSafePos` =
        GET /recipeSafePosition/getRecipeSafePositionList?recipe_id=(返回 SafePos[]),
        每项 name 是标签(如"初始准备姿态")。**不是** /safePosition/getList(那个返回通用
        "安全位置N"、坐标是别的东西)——用错端点机器人不动。
        """
        r = self._rest("GET", "/recipeSafePosition/getRecipeSafePositionList",
                       params={"recipe_id": recipe_id})
        if isinstance(r, list):
            return r
        if isinstance(r, dict):
            data = r.get("data", r)
            items = data.get("items") if isinstance(data, dict) else None
            if items is None:
                items = r.get("items")
            if items is None and isinstance(r.get("data"), list):
                items = r["data"]
            return items if isinstance(items, list) else []
        return []

    async def move_safe_pose(self, recipe_id, index=0, name=None, arm_id=0,
                             serial=None, workspace_id=None):
        """移动到准备姿态 (SafePosConfig.vue handleMove 复刻)。

        index=0 即"初始准备姿态";也可直接传 name="上料准备姿态"。
        按 name(label)匹配后端记录(前端同款 findIndex(label===name)),匹配不到再退回按序。
        JOINT_MOVE(110)/RECIPE, 带 joint_values+joint_names+points(左/右/base Pose)。
        """
        items = self.safe_pos_list(recipe_id)
        if not items:
            return {"error": "no safe positions for recipe %s (endpoint 或网络)" % recipe_id}
        # 目标标签: 显式 name 优先, 否则用 SAFE_POSE_LABELS[index]
        target = name or (SAFE_POSE_LABELS[index] if 0 <= index < len(SAFE_POSE_LABELS) else None)
        item = None
        if target:
            item = next((it for it in items if it.get("name") == target), None)
        if item is None:  # 名字匹配不到, 退回按序 index
            if index < 0 or index >= len(items):
                return {"error": "pose '%s' 未匹配且 index %d 越界(0..%d)"
                        % (target, index, len(items) - 1)}
            item = items[index]
        pos = item.get("position", {}) or {}
        joints_pos = pos.get("joints_pos", {}) or {}
        base = pos.get("base_link_pose", {}) or {}
        points = [
            (pos.get("left_position"), pos.get("left_quaternion")),
            (pos.get("right_position"), pos.get("right_quaternion")),
            (base.get("position"), base.get("quaternion")),
        ]
        if serial is None:
            serial = await self.resolve_serial() or "0"
        if workspace_id is None:
            workspace_id = int(self.device_id) if str(self.device_id).isdigit() else 0
        req = encode_safe_pos_move(
            ROBOT_MODE["JOINT_MOVE"], SCENARIO["RECIPE"], recipe_id, arm_id,
            serial, workspace_id, joints_pos, points)
        resp, code = await self.call_service("/aw_task_manager_service", req)
        return {"success": resp.get(1, 0) == 1, "is_accepted": resp.get(1),
                "pose_name": item.get("name"), "joints": len(joints_pos),
                "response": resp, "code": code}

    # ---- Recipe 位姿调整 (poseAdjust.vue) ----

    async def adjust_upload_position(self, serial=None, workspace_id=None):
        """调整到上料高度 (MOVE_TO_LOAD_POSE=123, SINGLE_STEP)。"""
        return await self.robot_action(ROBOT_MODE["MOVE_TO_LOAD_POSE"],
                                       scenario=SCENARIO["SINGLE_STEP"],
                                       serial=serial, workspace_id=workspace_id)

    async def adjust_cutting_position(self, serial=None, workspace_id=None):
        """调整到理线插接高度 (MOVE_TO_WIRE_PLUGGING_POSE=124, SINGLE_STEP)。"""
        return await self.robot_action(ROBOT_MODE["MOVE_TO_WIRE_PLUGGING_POSE"],
                                       scenario=SCENARIO["SINGLE_STEP"],
                                       serial=serial, workspace_id=workspace_id)

    async def move_insert(self, arm_id=0, serial=None, workspace_id=None):
        """精调插接移动 (fineTuning MOVE-INSERT → MOVE_INSERT=117, RECIPE, 带 arm_id)。"""
        return await self.robot_action(ROBOT_MODE["MOVE_INSERT"], scenario=SCENARIO["RECIPE"],
                                       serial=serial, workspace_id=workspace_id, arm_id=arm_id)

    @staticmethod
    def _points_from_pose(pose, arm_id, move_all):
        """poseAdjust getPoseData 复刻: MOVE_ALL→[左,右,base]; 单臂→[选中臂]。"""
        left = (pose.get("left_position"), pose.get("left_quaternion"))
        right = (pose.get("right_position"), pose.get("right_quaternion"))
        base = pose.get("base_link_pose", {}) or {}
        if move_all:
            return [left, right, (base.get("position"), base.get("quaternion"))]
        return [left if arm_id == ARM_ID["LEFT"] else right]

    async def move_to_pose(self, recipe_id, pose, arm_id=0, mode=None,
                           serial=None, workspace_id=None):
        """移动到关键点/目标位姿 (poseAdjust moveTo/moveToUpload, 已同步有 joints 的情形)。

        pose: 关键点的 pose dict(含 joints_pos + left/right/base position+quaternion)。
        mode: getSportMode,默认 JOINT_MOVE(110);MOVE_ALL(115) 则下发三臂。
        """
        if mode is None:
            mode = ROBOT_MODE["JOINT_MOVE"]
        joints_pos = pose.get("joints_pos", {}) or {}
        points = self._points_from_pose(pose, arm_id, mode == ROBOT_MODE["MOVE_ALL"])
        if serial is None:
            serial = await self.resolve_serial() or "0"
        if workspace_id is None:
            workspace_id = int(self.device_id) if str(self.device_id).isdigit() else 0
        req = encode_safe_pos_move(mode, SCENARIO["RECIPE"], recipe_id, arm_id,
                                   serial, workspace_id, joints_pos, points)
        resp, code = await self.call_service("/aw_task_manager_service", req)
        return {"success": resp.get(1, 0) == 1, "is_accepted": resp.get(1),
                "joints": len(joints_pos), "response": resp, "code": code}

    async def move_to_aruco(self, recipe_id, aruco_id, pose, arm_id=0, mode=None,
                            serial=None, workspace_id=None):
        """按 ArUco 移动到目标(poseAdjust moveTo 中关键点未同步/无 id 的分支)。

        MOVE_TO_ARUCO_POSITION=121,带 aruco_id + points(不带 joints,机器人自行寻找)。
        """
        if mode is None:
            mode = ROBOT_MODE["MOVE_TO_ARUCO_POSITION"]
        points = self._points_from_pose(pose, arm_id, False)
        if serial is None:
            serial = await self.resolve_serial() or "0"
        if workspace_id is None:
            workspace_id = int(self.device_id) if str(self.device_id).isdigit() else 0
        req = encode_safe_pos_move(mode, SCENARIO["RECIPE"], recipe_id, arm_id,
                                   serial, workspace_id, {}, points, aruco_id=int(aruco_id))
        resp, code = await self.call_service("/aw_task_manager_service", req)
        return {"success": resp.get(1, 0) == 1, "is_accepted": resp.get(1),
                "aruco_id": aruco_id, "response": resp, "code": code}

    # ---- Misc protobuf services ----

    async def sensor_control(self, control_type, timeout=15.0):
        """RobotSensorService: 0=START_ALL,1=STOP_ALL,2=START_REC,3=STOP_REC."""
        req = bytearray()
        if control_type:
            req.extend(varint((1 << 3) | 0)); req.extend(varint(int(control_type)))
        resp, code = await self.call_service("/robot_sensor_service", bytes(req), timeout=timeout)
        return {"success": resp.get(1, 0) in (1, True), "response": resp, "code": code}

    async def start_recording(self):
        return await self.sensor_control(2)

    async def stop_recording(self):
        return await self.sensor_control(3)

    async def scheduler_service(self, serial, wait_or_load=0, mode=0, timeout=15.0):
        """TwoVarsMsgService on /scheduler_service_<serial> (巡航调度/取 aruco)."""
        req = bytearray()
        e = str(serial).encode(); req.extend(varint((1 << 3) | 2)); req.extend(varint(len(e))); req.extend(e)
        if wait_or_load:
            req.extend(varint((2 << 3) | 0)); req.extend(varint(int(wait_or_load)))
        if mode:
            req.extend(varint((3 << 3) | 0)); req.extend(varint(int(mode)))
        resp, code = await self.call_service(f"/scheduler_service_{serial}", bytes(req), timeout=timeout)
        return {"response": resp, "code": code}

    async def save_golden_model(self, connector_id, body_part=2, recipe_id=None,
                                kit_type=None, left_points=None, right_points=None,
                                timeout=20.0):
        """AwGoldenModelService HmiGoldenModelSaveRequest.

        left_points/right_points: pre-encoded DrawingPoints2D bytes (来自视觉,
        脚本外部提供)。标量字段(connector_id/body_part/recipe_id/kit_type)已实现。
        """
        r = bytearray()
        r.extend(varint((1 << 3) | 0)); r.extend(varint(int(connector_id)))
        if recipe_id is not None:
            r.extend(varint((2 << 3) | 0)); r.extend(varint(int(recipe_id)))
        if left_points:
            r.extend(varint((3 << 3) | 2)); r.extend(varint(len(left_points))); r.extend(left_points)
        if right_points:
            r.extend(varint((4 << 3) | 2)); r.extend(varint(len(right_points))); r.extend(right_points)
        r.extend(varint((5 << 3) | 0)); r.extend(varint(int(body_part)))
        if kit_type:
            e = str(kit_type).encode(); r.extend(varint((6 << 3) | 2)); r.extend(varint(len(e))); r.extend(e)
        resp, code = await self.call_service("/aw_golden_model_service", bytes(r), timeout=timeout)
        return {"response": resp, "code": code}

    async def template_service(self, kit_type_id, body_part=2, refine=False,
                               left_image=None, right_image=None, timeout=30.0):
        """AwTemplateEditService project(投影)/refine(精修).

        left_image/right_image: 需 CompressedImage 字节(来自去畸变图像发布),脚本外部提供;
        标量字段(kit_type_id/body_part)已实现。service 由 refine 选择。
        """
        r = bytearray()
        if kit_type_id:
            r.extend(varint((1 << 3) | 0)); r.extend(varint(int(kit_type_id)))
        r.extend(varint((2 << 3) | 0)); r.extend(varint(int(body_part)))
        if left_image:
            r.extend(varint((3 << 3) | 2)); r.extend(varint(len(left_image))); r.extend(left_image)
        if right_image:
            r.extend(varint((4 << 3) | 2)); r.extend(varint(len(right_image))); r.extend(right_image)
        svc = ("/tars_awr_perception/aw_template_refine_service" if refine
               else "/tars_awr_perception/aw_template_project_service")
        resp, code = await self.call_service(svc, bytes(r), timeout=timeout)
        return {"success": resp.get(1) in (1, True), "response": resp, "code": code}

    async def launcher_command(self, command_type, command_id=None, run_config_json=None):
        """Publish AwrLauncherCommand to /aw_launcher/command.

        command_type: 1=START_PIPELINE(需 run_config_json), 2=ABORT, 3=ACK_POST_REBOOT_READY.
        """
        cid = command_id or uuid.uuid4().hex
        r = bytearray()
        r.extend(varint((2 << 3) | 0)); r.extend(varint(int(command_type)))       # command_type
        e = cid.encode(); r.extend(varint((3 << 3) | 2)); r.extend(varint(len(e))); r.extend(e)  # command_id
        if run_config_json:
            e = run_config_json.encode(); r.extend(varint((4 << 3) | 2)); r.extend(varint(len(e))); r.extend(e)
        await self.ws.send(encode_json_wrapper(type_="publish",
                                               topic="/aw_launcher/command", msg=bytes(r)))
        return {"published": True, "command_id": cid}

    # ---- 打点日志上报 / 问题上报 (FeedbackDialog.vue onSubmit) ----

    async def report_issue(self, issue_detail, operator=None, handler=None,
                           take_over_type=0, tag_type=1, recipe_id=None,
                           issue_title=None, serial=None, mark=True,
                           package_version="0.0.0"):
        """打点日志上报(问题上报). 复刻 onSubmit:
          1. publish /tars/quickdata/request(TSQuickDataRequest)—— 日志/录制数据快传上报
          2. mark=True 时 publish /issue_report(IssueReport)—— 在录制里打标记点(tag_type=2)

        tag_type: 0 LOG/1 NORMAL/2 WARNING/3 ERROR; take_over_type: 0 NONE/1 INVALID/2 TAKEOVER。
        """
        if serial is None:
            serial = await self.resolve_serial() or "0"
        request_id = uuid.uuid4().hex
        ts_ms = int(time.time() * 1000)
        dev = f"X1-{serial}"
        # 1) 数据快传 / 日志上报
        qd = encode_quickdata_request(
            request_id=request_id, issue_url=QUICKDATA_ISSUE_URL,
            request_timestamp=ts_ms, device_id=dev, tag_type=tag_type,
            issue_detail=issue_detail, operator_name=operator,
            take_over_type=take_over_type, hardware=dev,
            package_version=package_version, issue_title=issue_title,
            handler_name=handler, recipe_id=recipe_id)
        await self.ws.send(encode_json_wrapper(
            type_="publish", topic="/tars/quickdata/request", msg=qd))
        result = {"published": True, "request_id": request_id, "quickdata": True}
        # 2) 打点标记(录制中)
        if mark:
            ir = encode_issue_report(
                issue_detail=issue_detail, operator=operator,
                take_over_type=take_over_type, tag_type=2, timestamp_ms=ts_ms)
            await self.ws.send(encode_json_wrapper(
                type_="publish", topic="/issue_report", msg=ir))
            result["issue_report"] = True
        return result

    # ---- 标定 / 质检 (calibration & quality check) ----
    # 源: views/calibration/{autoCalibratin,qualityCheck}.vue + autoCalibrationProgress.ts
    # 都走 robotService → /aw_task_manager_service, scenario=SINGLE_STEP(3), 带 arm_id。
    # 前置(人工): 先把手臂/底盘/标定板移到位,标定板须在相机视野内。

    def _gen_task_id(self):
        """Runtime uint32 task_id generator (mirrors qualityCheck.vue genTaskId)."""
        self._task_seq = ((getattr(self, "_task_seq", int(time.time())) + 1) & 0xFFFFFFFF) or 1
        return self._task_seq

    async def calibrate(self, check_type, arm_id=0, serial=None, workspace_id=None):
        """自动化标定. check_type: 4=鱼眼双目 7=鱼眼手眼 10=内窥镜双目 13=鱼眼左目到内窥镜左目.
        → ROBOT_MODE 150/151/152/153. arm_id: 0=左 1=右 2=双."""
        mode = CALIB_MODE_BY_CHECKTYPE.get(check_type)
        if mode is None:
            return {"error": f"unknown check_type {check_type}"}
        return await self.robot_action(mode, scenario=SCENARIO["SINGLE_STEP"],
                                       serial=serial, workspace_id=workspace_id,
                                       arm_id=arm_id)

    async def quality_check(self, mode, arm_id=0, serial=None, workspace_id=None,
                            wait_result=None):
        """标定质检. mode: 154=鱼眼双目 155=鱼眼手眼 156=内窥镜双目 157=鱼眼左目到内窥镜左目.
        触发后订阅 /ts_awr/qualitycheck/response 按 task_id 收结果并判定通过(标准差<1.5mm)。

        ⚠ 双目(154/156)单帧秒回,手眼(155)/鱼眼左内窥左(157)两阶段 ~55s;四项统一 120s 保底。"""
        if wait_result is None:
            wait_result = 120.0
        task_id = self._gen_task_id()
        # 先订阅结果 topic,再触发(质检计算耗时,结果稍后到)
        await self.ws.send(encode_json_wrapper(
            type_="subscribe", topic="/ts_awr/qualitycheck/response"))
        await asyncio.sleep(0.2)
        res = await self.robot_action(mode, scenario=SCENARIO["SINGLE_STEP"],
                                      serial=serial, workspace_id=workspace_id,
                                      arm_id=arm_id, task_id=task_id)
        if res.get("is_accepted") != 1:
            return {"accepted": False, "is_accepted": res.get("is_accepted"),
                    "task_id": task_id}
        result = await self._await_qc_result(task_id, mode, timeout=wait_result)
        result.update({"accepted": True, "task_id": task_id, "mode": mode})
        return result

    async def _await_qc_result(self, task_id, mode, timeout=30.0):
        """等待 /ts_awr/qualitycheck/response 中 task_id 匹配、且带最终结果的一帧。"""
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                raw = await asyncio.wait_for(self.ws.recv(),
                                             timeout=max(0.1, deadline - time.time()))
            except asyncio.TimeoutError:
                break
            msg = decode_json_wrapper(raw)
            if self._s(msg.get("topic")) != "/ts_awr/qualitycheck/response":
                continue
            payload = msg.get("msg", b"")
            if not payload:
                continue
            f = parse_response(payload)
            if f.get(21) != task_id:          # task_id echo
                continue
            tr = _as_bytes(f.get(20))         # qualitycheck_task_result (nested)
            if tr is None:
                continue                      # 中间帧无最终结果,继续等
            return {"passed": _qc_passed(tr, mode), "raw": f}
        return {"passed": None, "error": "timeout waiting qc result"}

    # ---- Read-only topic subscriptions (校验用) ----

    async def sub_raw(self, topic, timeout=8.0):
        """Subscribe one message and return the raw parsed {field_num: value}."""
        data = await self.subscribe(topic, timeout=timeout)
        return parse_response(data) if data else None

    async def get_info(self, timeout=8.0):
        """/aw_info (AwInfo) — 全局告警/信息。field2 code, field3 error_msg (约定)。"""
        r = await self.sub_raw("/aw_info", timeout=timeout)
        if not r:
            return None
        return {"raw": r, "error_msg": self._s(r.get(3)) or self._s(r.get(2))}

    async def get_kit_refine_result(self, timeout=20.0):
        """/kit_refine_result — 精定位结果。"""
        return await self.sub_raw("/kit_refine_result", timeout=timeout)

    async def get_kit_refine_progress(self, timeout=20.0):
        """/kit_refine_progress — 精定位进度。"""
        return await self.sub_raw("/kit_refine_progress", timeout=timeout)

    async def get_issue_report(self, timeout=8.0):
        """/issue_report — 问题上报。"""
        return await self.sub_raw("/issue_report", timeout=timeout)

    async def get_launcher_status(self, timeout=8.0):
        """/aw_launcher/status — 启动器/节点状态。"""
        return await self.sub_raw("/aw_launcher/status", timeout=timeout)

    # ---- Cloud API operations ----

    def _rest(self, method, path, params=None, body=None, timeout=10):
        """Generic REST helper for the cloud backend."""
        url = f"{self.api_base}{path}"
        if params:
            url += "?" + urllib.parse.urlencode(params)
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            url, data=data, method=method,
            headers={"Content-Type": "application/json"} if data else {})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                try:
                    return json.loads(raw)
                except Exception:
                    return {"raw": raw.decode("utf-8", "ignore")}
        except Exception as e:
            return {"error": str(e)}

    # Recipe
    def recipe_get(self, recipe_id):
        return self._rest("GET", "/recipe/getOneById", params={"id": recipe_id})

    def recipe_update(self, recipe_body):
        return self._rest("PUT", "/recipe/updateById", body=recipe_body)

    def recipe_update_status(self, recipe_id, status):
        return self._rest("PATCH", "/recipe/updateStatus", body={"id": recipe_id, "status": status})

    def recipe_copy(self, recipe_id):
        return self._rest("GET", "/recipe/copyRecipe", params={"id": recipe_id})

    def recipe_delete(self, recipe_id):
        return self._rest("DELETE", "/recipe/deleteById", params={"id": recipe_id})

    # Maps
    def opmap_list(self):
        return self._rest("GET", "/opMap/getList")

    def opmap_save(self, opmap_body):
        return self._rest("PUT", "/opMap/saveOrUpdateById", body=opmap_body)

    def navmap_list(self):
        return self._rest("GET", "/navMap/getList")

    def navmap_save(self, navmap_body):
        return self._rest("PUT", "/navMap/saveOrUpdateById", body=navmap_body)

    def navmap_delete(self, nav_id):
        return self._rest("DELETE", "/navMap/deleteById", params={"id": nav_id})

    # Device conf
    def device_conf_get(self, device_id):
        return self._rest("GET", "/deviceConf/getDeviceConf", params={"device_id": device_id})

    def device_conf_set(self, conf_body):
        return self._rest("PUT", "/deviceConf/setDeviceConf", body=conf_body)

    # Agent
    def agent_save(self, agent_body):
        return self._rest("PUT", "/agent/saveOrUpdateById", body=agent_body)

    def agent_delete(self, agent_id):
        return self._rest("DELETE", "/agent/deleteById", params={"id": agent_id})

    # Camera / safe position / part info
    def camera_calib(self, cam_body):
        return self._rest("PUT", "/camera/calibById", body=cam_body)

    def safe_position_list(self):
        return self._rest("GET", "/safePosition/getList")

    def safe_position_save(self, body):
        return self._rest("POST", "/safePosition/saveSafePosition", body=body)

    def recipe_list(self, device_id="142"):
        """List recipes for a device from the cloud API."""
        url = f"{self.api_base}/recipe/getList?device_id={device_id}"
        try:
            with urllib.request.urlopen(url, timeout=5) as resp:
                data = json.loads(resp.read())
                return data.get("items", [])
        except Exception as e:
            return [{"error": str(e)}]

    def resolve_op_map(self, device_id):
        """Resolve (op_map_id, nav_map_id) for a device WITHOUT hardcoding.

        1) 沿用该 device 现有 recipe 的 op_map/nav_map(最可靠);
        2) 否则按 opMap 名 board<device_id> 在 /opMap/getList 里找 id。
        Returns (op_map_id or None, nav_map_id or None).
        """
        items = self.recipe_list(device_id=device_id)
        for r in items:
            if isinstance(r, dict) and r.get("op_map_id"):
                return r.get("op_map_id"), r.get("nav_map_id")
        for m in (self.opmap_list() or []):
            if isinstance(m, dict) and m.get("name") == f"board{device_id}":
                return m.get("id"), None
        return None, None

    def recipe_create(self, name, device_id="142",
                      op_map_id=None, nav_map_id=None):
        """Create a blank recipe. Returns the new recipe ID or None.

        op_map_id/nav_map_id 省略时按 device 自动解析(不再硬编码 board142 的 86)。
        """
        if op_map_id is None:
            op_map_id, nav = self.resolve_op_map(device_id)
            if nav_map_id is None:
                nav_map_id = nav
        if nav_map_id is None:
            nav_map_id = 6
        print(f"  (device={device_id} op_map_id={op_map_id} nav_map_id={nav_map_id})")
        payload = json.dumps({
            "name": name,
            "device_id": str(device_id),
            "op_map_id": op_map_id,
            "nav_map_id": nav_map_id,
        }).encode()

        # Step 1: Create
        req = urllib.request.Request(
            f"{self.api_base}/recipe/create",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                result = json.loads(resp.read())
                print(f"  Create: {result}")
        except Exception as e:
            print(f"  Create failed: {e}")
            return None

        # Step 2: Find the new recipe
        items = self.recipe_list(device_id)
        if items:
            newest = max(items, key=lambda x: x["id"])
            print(f"  New recipe: id={newest['id']} name={newest['name']}")
            return newest["id"]
        return None


# ============================================================
# Channel C — Power / fault WS (ws://<robot>:8766/power, JSON)
# Source: composables/powerWs.ts
# ============================================================

async def power_action(robot_ip, action, collect=6.0):
    """Send a power/fault action over the 8766 JSON socket and collect replies.

    action: 'clear_fault' | 'read_fault_log' | 'clear_fault_log'
    Replies arrive as JSON frames with a `type` field (started/entry/result...).
    """
    url = f"ws://{robot_ip}:8766/power"
    frames = []
    try:
        async with websockets.connect(url) as ws:
            await ws.send(json.dumps({"action": action}))
            deadline = time.time() + collect
            while time.time() < deadline:
                try:
                    raw = await asyncio.wait_for(ws.recv(),
                                                 timeout=max(0.1, deadline - time.time()))
                except asyncio.TimeoutError:
                    break
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                frames.append(msg)
                t = msg.get("type", "")
                # 结束条件:收到 *_result / *_complete 即可停
                if t.endswith("_result") or t.endswith("_complete"):
                    if action != "read_fault_log" or t in (
                            "read_fault_log_result", "fault_log_complete"):
                        break
    except Exception as e:
        return {"error": str(e), "frames": frames}
    return {"frames": frames}


# ============================================================
# CLI
# ============================================================

async def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return

    robot_ip = sys.argv[1]
    cmd = sys.argv[2] if len(sys.argv) > 2 else "status"

    # Commands that don't need the 9094 ROS-bridge socket (REST / 8766 power).
    NO_WS = {
        "recipe-list", "recipe-create", "recipe-get", "recipe-status",
        "recipe-copy", "recipe-delete", "opmap-list", "navmap-list",
        "deviceconf", "safepos-list",
        "clear-fault", "read-fault-log", "clear-fault-log",
    }
    ctrl = HmiController(robot_ip)
    # DEVICE_ID(=板号,如 board188→188)≠ agent serial(72)。workspace_id 取 DEVICE_ID。
    # 通过环境变量指定,例: AWR_DEVICE_ID=188 python3 ehmi_client.py 127.0.0.1 start-job 1841 30104 0
    import os
    ctrl.device_id = os.environ.get("AWR_DEVICE_ID", ctrl.device_id)
    if cmd not in NO_WS:
        await ctrl.connect()

    try:
        if cmd == "status":
            print("=== Robot Status ===")
            status = await ctrl.get_robot_status()
            for k, v in status.items():
                print(f"  {k}: {v}")

        elif cmd in ("lock", "unlock", "manual-refine"):
            # lock <recipe_id> <wire_id> [serial]  (serial 省略=自动探测)
            print(f"=== {cmd} (精定位) ===")
            recipe_id = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3].isdigit() else None
            wire_id = int(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4].isdigit() else None
            serial = sys.argv[5] if len(sys.argv) > 5 else None
            fn = {"lock": ctrl.lock_refinement, "unlock": ctrl.unlock_refinement,
                  "manual-refine": ctrl.manual_refinement}[cmd]
            if recipe_id is None and cmd == "lock":
                print("  ⚠ 锁精定位需先选 recipe+wire: lock <recipe_id> <wire_id> [serial]")
            result = await fn(serial=serial, recipe_id=recipe_id, wire_id=wire_id)
            print(f"  recipe_id={recipe_id} wire_id={wire_id} workspace={ctrl.device_id}")
            print(f"  is_accepted={result.get('is_accepted')}  success={result.get('success')}")

        elif cmd == "agents":
            print("=== Bindable Agents (HMI 绑定下拉框) ===")
            atype = int(sys.argv[3]) if len(sys.argv) > 3 else 0
            agents = await ctrl.list_bindable_agents(agent_type=atype)
            if not agents:
                print("  (无在线可绑定机器人)")
            for a in agents:
                print(f"  name={a['name']}  serial={a['serial_number']}  "
                      f"agent_type={a['agent_type']}  "
                      f"agent_status={a['agent_status']} (1=空闲,2=已绑定)  "
                      f"is_bound={a['is_bound']}")

        elif cmd in ("bind", "unbind", "rebind"):
            # Reproduce the dropdown: accept a name (agent72) OR serial (72) OR
            # 'auto'. Resolve to the serial_number the UI would actually send.
            sel = sys.argv[3] if len(sys.argv) > 3 else "auto"
            if not sel or sel == "auto":
                serial = await ctrl.resolve_serial()
            else:
                serial = await ctrl.resolve_agent(sel)
            if not serial:
                print("  ERROR: 无法解析机器人(在线列表为空?);用 'agents' 查看可绑定项或显式传 serial")
                return
            print(f"  (选中机器人 -> serial={serial})")
            ws_id = int(sys.argv[4]) if len(sys.argv) > 4 else (int(serial) if serial.isdigit() else 0)
            agent = int(sys.argv[5]) if len(sys.argv) > 5 else 0
            db_ip = sys.argv[6] if len(sys.argv) > 6 else "https://awr-backend-test.tars-ai.com"
            db_port = int(sys.argv[7]) if len(sys.argv) > 7 else 0

            if cmd == "bind":
                print("=== Bind Robot ===")
                pre = await ctrl.get_robot_status()
                if pre.get("in_workspace"):
                    # Server has no is_accepted=2 path; detect already-bound here.
                    print(f"  Serial: {serial}  Workspace: {ws_id}")
                    print("  Result: ALREADY BOUND (already ONLINE_WITH_WORKSPACE) — use 'rebind' to force")
                    return
                result = await ctrl.bind_robot(serial=serial, workspace_id=ws_id,
                                               agent_type=agent, database_ip=db_ip,
                                               database_port=db_port)
                print(f"  Serial: {serial}  Workspace: {ws_id}  Agent: {agent}")
                print(f"  Database: {db_ip}:{db_port}")
                print(f"  Accepted(is_accepted): {result['is_accepted']}")
                print(f"  Result: {'BIND SUCCESS' if result['success'] else 'BIND FAILED'}")

            elif cmd == "unbind":
                print("=== Unbind Robot ===")
                result = await ctrl.unbind_robot(serial=serial, workspace_id=ws_id,
                                                 agent_type=agent, database_ip=db_ip,
                                                 database_port=db_port)
                print(f"  Serial: {serial}  Workspace: {ws_id}")
                print(f"  Accepted(is_accepted): {result['is_accepted']}")
                print(f"  Result: {'UNBIND SUCCESS' if result['success'] else 'UNBIND FAILED'}")

            else:  # rebind — idempotent unbind→bind→verify for automation
                print("=== Rebind Robot (unbind-if-bound -> bind -> verify) ===")
                result = await ctrl.rebind_robot(serial=serial, workspace_id=ws_id,
                                                 agent_type=agent, database_ip=db_ip,
                                                 database_port=db_port)
                for name, acc in result["steps"]:
                    print(f"  {name}: is_accepted={acc}")
                print(f"  Final status: {result['final_status']}")
                print(f"  Result: {'REBIND SUCCESS' if result['success'] else 'REBIND FAILED'}")

        elif cmd == "bindmap":
            # bindmap <map_name> [wire=THHB] [agent=auto] [pattern]
            print("=== Bind Operation Map (保存地图) ===")
            map_name = sys.argv[3] if len(sys.argv) > 3 else None
            if not map_name:
                print("  用法: bindmap <map_name> [wire THHB|C134|THD30|AIO] [agent|auto] [pattern AIO|LZY_TH|OP]")
                return
            wire = sys.argv[4] if len(sys.argv) > 4 else "THHB"
            wire_val = WIRE_TYPE.get(wire.upper(), int(wire) if wire.isdigit() else 2)
            sel = sys.argv[5] if len(sys.argv) > 5 else "auto"
            serial = (await ctrl.resolve_serial()) if sel in (None, "auto") \
                else await ctrl.resolve_agent(sel)
            patt = sys.argv[6] if len(sys.argv) > 6 else None
            patt_val = MAP_PATTERN.get(patt.upper()) if patt else None

            # 前置校验: 机器人必须已绑定 (前端同样校验 getChooseAgent)
            st = await ctrl.get_robot_status()
            if not st.get("in_workspace"):
                print(f"  ⚠ 机器人未绑定 (agent_status={st.get('agent_status')}), 前端要求先绑定机器人再绑地图")
                print(f"  先执行: rebind {serial}")
                return
            print(f"  serial={serial}  map_name={map_name}  wire={wire}({wire_val})  pattern={patt or '无'}")
            result = await ctrl.bind_map(serial, map_name, wire_harness=wire_val,
                                         pattern=patt_val)
            print(f"  events: {result.get('events')}")
            if result["success"]:
                print("  Result: MAP BIND SUCCESS")
            elif result.get("need_pattern"):
                print("  Result: 需要选择板型图案 (缺地图素材) — 重跑并加 pattern 参数 (AIO|LZY_TH|OP)")
            else:
                print(f"  Result: MAP BIND FAILED — {result.get('error')} "
                      f"reason={result.get('failure_reason')}")

        elif cmd == "recipe-list":
            print("=== Recipe List ===")
            device = sys.argv[3] if len(sys.argv) > 3 else "72"
            items = ctrl.recipe_list(device_id=device)
            for item in sorted(items, key=lambda x: x.get("id", 0), reverse=True):
                print(f"  id={item['id']} name={item['name']} "
                      f"status={item['status']} "
                      f"op_map={item.get('op_map_id')} "
                      f"nav_map={item.get('nav_map_id')}")

        elif cmd == "recipe-create":
            name = sys.argv[3] if len(sys.argv) > 3 else "test_recipe"
            device = sys.argv[4] if len(sys.argv) > 4 else "72"
            print(f"=== Create Recipe: {name} (device={device}) ===")
            rid = ctrl.recipe_create(name, device_id=device)
            if rid:
                print(f"  Created: id={rid}")

        elif cmd == "gate1":
            print("=== Gate-1 Check ===")
            status = await ctrl.get_robot_status()
            checks = [
                ("System running", status.get("serial") != "?"),
                ("Robot bound", status.get("is_bound", False)),
                ("Board identified", status.get("serial") != "?"),
            ]
            all_pass = True
            for name, passed in checks:
                mark = "PASS" if passed else "FAIL"
                if not passed:
                    all_pass = False
                print(f"  [{mark}] {name}: {status}")
            print(f"\n  Gate-1: {'READY' if all_pass else 'BLOCKED'}")

        # ---- Generic + named robot actions (aw_robot_service) ----
        elif cmd == "action":
            mode = sys.argv[3]
            mode_val = ACTION.get(mode.upper(), int(mode) if mode.isdigit() else None)
            scenario = int(sys.argv[4]) if len(sys.argv) > 4 else 2
            print(f"=== robot_action mode={mode}({mode_val}) scenario={scenario} ===")
            res = await ctrl.robot_action(mode_val, scenario=scenario)
            print(f"  is_accepted={res['is_accepted']}  success={res['success']}")

        elif cmd in ("reset", "clear-alarm", "init-all", "home-all", "config-check",
                     "pause-job", "continue-job", "stop-job",
                     "record-start", "record-stop"):
            fn = {
                "reset": ctrl.reset, "clear-alarm": ctrl.clear_alarm,
                "init-all": ctrl.init_all, "home-all": ctrl.home_all,
                "config-check": ctrl.config_check,
                "pause-job": ctrl.pause_job, "continue-job": ctrl.continue_job,
                "stop-job": ctrl.stop_job,
                "record-start": ctrl.start_recording, "record-stop": ctrl.stop_recording,
            }[cmd]
            print(f"=== {cmd} ===")
            res = await fn()
            print(f"  is_accepted={res.get('is_accepted')}  success={res.get('success')}  resp={res.get('response')}")

        elif cmd == "start-job":
            # start-job <recipe_id> <wire_id 起始线束> [job_type 0理线/1缠绞]
            print("=== start-job (执行作业) ===")
            recipe_id = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3].isdigit() else None
            wire_id = int(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4].isdigit() else None
            jt = int(sys.argv[5]) if len(sys.argv) > 5 else 0
            print(f"  recipe_id={recipe_id} 起始wire_id={wire_id} job_type={jt} workspace={ctrl.device_id}")
            res = await ctrl.start_job(recipe_id=recipe_id, wire_id=wire_id, start_job_type=jt)
            print(f"  is_accepted={res.get('is_accepted')}  success={res.get('success')}")

        elif cmd in ("gen-traj", "del-traj"):
            # gen-traj [recipe_id]   (从线束3开始由服务端按 recipe 处理)
            recipe_id = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3].isdigit() else None
            fn = ctrl.generate_all_trajectories if cmd == "gen-traj" else ctrl.delete_all_trajectories
            print(f"=== {cmd} recipe_id={recipe_id} ===")
            res = await fn(recipe_id=recipe_id)
            print(f"  is_accepted={res.get('is_accepted')}")

        elif cmd == "single-traj":
            # single-traj <wire_id> [recipe_id] [--delete]   (线束3..14 逐条)
            wire_id = int(sys.argv[3])
            recipe_id = int(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4].isdigit() else None
            delete = "--delete" in sys.argv[3:]
            print(f"=== single-traj wire_id={wire_id} recipe_id={recipe_id} delete={delete} ===")
            res = await ctrl.single_trajectory(wire_id, recipe_id=recipe_id, delete=delete)
            print(f"  is_accepted={res['is_accepted']}")

        elif cmd == "launcher-abort":
            print("=== launcher ABORT_PIPELINE ===")
            print("  ", await ctrl.launcher_command(2))

        # ---- 姿态 / 安全恢复 ----
        elif cmd == "safe-pose":
            # safe-pose <recipe_id> [index=0 | 名字如"初始准备姿态"] [arm=0]
            recipe_id = int(sys.argv[3]) if len(sys.argv) > 3 else None
            sel = sys.argv[4] if len(sys.argv) > 4 else "0"
            arm = int(sys.argv[5]) if len(sys.argv) > 5 else 0
            if recipe_id is None:
                print("  用法: safe-pose <recipe_id> [index=0初始准备姿态 | 名字] [arm]")
                return
            idx = int(sel) if sel.isdigit() else 0
            name = None if sel.isdigit() else sel
            print(f"=== 移动到准备姿态 recipe={recipe_id} target={name or SAFE_POSE_LABELS[idx] if idx < len(SAFE_POSE_LABELS) else idx} arm={arm} (JOINT_MOVE/RECIPE) ===")
            res = await ctrl.move_safe_pose(recipe_id, index=idx, name=name, arm_id=arm)
            if res.get("error"):
                print(f"  ERROR: {res['error']}")
            else:
                print(f"  pose_name={res.get('pose_name')} joints={res.get('joints')} "
                      f"is_accepted={res.get('is_accepted')}")

        elif cmd == "move-op":
            print("=== 移动到操作位 (MOVE_ALL_FAR/MAINTAIN) ===")
            recipe_id = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3].isdigit() else None
            res = await ctrl.move_operation_pose(recipe_id=recipe_id)
            print(f"  is_accepted={res.get('is_accepted')}")

        elif cmd == "arm-vertical":
            arm = int(sys.argv[3]) if len(sys.argv) > 3 else 0
            param = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0
            print(f"=== 一键垂直 (ARM_VERTICAL/MAINTAIN) arm={arm} param={param} ===")
            res = await ctrl.arm_vertical(arm_id=arm, param=param)
            print(f"  is_accepted={res.get('is_accepted')}")

        elif cmd == "move-wait":
            print("=== 移动到等候区 (MOVE_TO_WAIT_AREA/RECIPE) ===")
            res = await ctrl.move_wait_area()
            print(f"  is_accepted={res.get('is_accepted')}")

        # ---- Recipe 位姿调整 (poseAdjust.vue) ----
        elif cmd == "pose-upload":
            print("=== 调整到上料高度 (MOVE_TO_LOAD_POSE/SINGLE_STEP) ===")
            print(f"  is_accepted={(await ctrl.adjust_upload_position()).get('is_accepted')}")

        elif cmd == "pose-cutting":
            print("=== 调整到理线插接高度 (MOVE_TO_WIRE_PLUGGING_POSE/SINGLE_STEP) ===")
            print(f"  is_accepted={(await ctrl.adjust_cutting_position()).get('is_accepted')}")

        elif cmd == "move-insert":
            arm = int(sys.argv[3]) if len(sys.argv) > 3 else 0
            print(f"=== 精调插接移动 (MOVE_INSERT/RECIPE) arm={arm} ===")
            print(f"  is_accepted={(await ctrl.move_insert(arm_id=arm)).get('is_accepted')}")

        elif cmd == "report-issue":
            # report-issue <描述> [operator] [tag_type=1] [recipe_id] [--no-mark]
            detail = sys.argv[3] if len(sys.argv) > 3 else None
            if not detail:
                print("  用法: report-issue <问题描述> [operator] [tag_type 0LOG/1NORMAL/2WARN/3ERR] [recipe_id] [--no-mark]")
                return
            operator = sys.argv[4] if len(sys.argv) > 4 and not sys.argv[4].startswith("--") else None
            tag = int(sys.argv[5]) if len(sys.argv) > 5 and sys.argv[5].isdigit() else 1
            recipe = int(sys.argv[6]) if len(sys.argv) > 6 and sys.argv[6].isdigit() else None
            mark = "--no-mark" not in sys.argv
            print(f"=== 打点日志上报 (quickdata快传 + issue_report打点={mark}) ===")
            res = await ctrl.report_issue(detail, operator=operator, tag_type=tag,
                                          recipe_id=recipe, mark=mark)
            print(f"  request_id={res.get('request_id')} quickdata={res.get('quickdata')} "
                  f"issue_report={res.get('issue_report')}")

        elif cmd == "calibrate":
            # calibrate <check_type 4|7|10|13> [arm 0左/1右/2双]  (前置: 人工摆好手臂+标定板)
            check_type = int(sys.argv[3]) if len(sys.argv) > 3 else 7
            arm = int(sys.argv[4]) if len(sys.argv) > 4 else 0
            print(f"=== 自动化标定 check_type={check_type}({CALIB_LABEL.get(check_type,'?')}) "
                  f"mode={CALIB_MODE_BY_CHECKTYPE.get(check_type)} arm={arm} ===")
            print("  ⚠ 前置需人工: 手臂/底盘/标定板已就位, 标定板在相机视野内")
            res = await ctrl.calibrate(check_type, arm_id=arm)
            print(f"  is_accepted={res.get('is_accepted')}  success={res.get('success')}")

        elif cmd == "quality-check":
            # quality-check <mode 154|155|156|157> [arm]
            mode = int(sys.argv[3]) if len(sys.argv) > 3 else 155
            arm = int(sys.argv[4]) if len(sys.argv) > 4 else 0
            print(f"=== 标定质检 mode={mode}({QUALITY_CHECK_MODE.get(mode,'?')}) arm={arm} ===")
            print("  ⚠ 前置需人工: 手臂/标定板已就位")
            res = await ctrl.quality_check(mode, arm_id=arm)
            print(f"  accepted={res.get('accepted')} task_id={res.get('task_id')} "
                  f"passed={res.get('passed')}")
            if res.get("error"):
                print(f"  {res['error']}")

        # ---- Read-only subscriptions ----
        elif cmd in ("info", "kit-result", "kit-progress", "issue-report", "launcher-status"):
            fn = {"info": ctrl.get_info, "kit-result": ctrl.get_kit_refine_result,
                  "kit-progress": ctrl.get_kit_refine_progress,
                  "issue-report": ctrl.get_issue_report,
                  "launcher-status": ctrl.get_launcher_status}[cmd]
            print(f"=== {cmd} ===")
            print("  ", await fn())

        # ---- Channel C: power/fault (8766) ----
        elif cmd in ("clear-fault", "read-fault-log", "clear-fault-log"):
            action = cmd.replace("-", "_")
            print(f"=== power: {action} (8766) ===")
            res = await power_action(robot_ip, action)
            if res.get("error"):
                print(f"  ERROR: {res['error']}")
            for f in res.get("frames", []):
                print(f"  {f.get('type','?')}: {f}")

        # ---- Cloud REST ----
        elif cmd == "recipe-get":
            print(ctrl.recipe_get(sys.argv[3]))
        elif cmd == "recipe-status":
            print(ctrl.recipe_update_status(int(sys.argv[3]), int(sys.argv[4])))
        elif cmd == "recipe-copy":
            print(ctrl.recipe_copy(sys.argv[3]))
        elif cmd == "recipe-delete":
            print(ctrl.recipe_delete(sys.argv[3]))
        elif cmd == "opmap-list":
            for m in ctrl.opmap_list() or []:
                if isinstance(m, dict):
                    print(f"  id={m.get('id')} name={m.get('name')}")
        elif cmd == "navmap-list":
            print(ctrl.navmap_list())
        elif cmd == "deviceconf":
            print(ctrl.device_conf_get(sys.argv[3] if len(sys.argv) > 3 else "72"))
        elif cmd == "safepos-list":
            print(ctrl.safe_position_list())

        else:
            print(f"Unknown command: {cmd}")
            print("Commands: status lock unlock manual-refine agents bind unbind rebind bindmap")
            print("          action reset clear-alarm init-all home-all config-check")
            print("          start-job pause-job continue-job stop-job gen-traj del-traj single-traj")
            print("          record-start record-stop launcher-abort")
            print("          calibrate <4|7|10|13> [arm] | quality-check <154..157> [arm]")
            print("          safe-pose <recipe_id> [idx0=初始准备姿态] | move-op | arm-vertical [arm] [param] | move-wait")
            print("          pose-upload | pose-cutting | move-insert [arm]  (recipe 位姿调整)")
            print("          info kit-result kit-progress issue-report launcher-status")
            print("          clear-fault read-fault-log clear-fault-log")
            print("          recipe-list recipe-create recipe-get recipe-status recipe-copy recipe-delete")
            print("          opmap-list navmap-list deviceconf safepos-list gate1")

    finally:
        await ctrl.close()


if __name__ == "__main__":
    asyncio.run(main())
