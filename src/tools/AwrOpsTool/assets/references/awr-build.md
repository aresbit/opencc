---
name: awr-build
description: AWR 项目 Docker 容器内编译构建 + 生成 .run 自解压包 + 传输到 Thor 开发板全流程
---

# AWR Build & Package Skill

AWR 线束装配机器人项目的完整构建工作流：进入 Docker 容器 → 编译 → 生成 `.run` 自解压安装包 → 测试人员 wget/scp 下载 → 部署到 Thor 测试板。

## 环境拓扑

```
主机 (PC, x86_64, 192.168.10.1)
  ├── Docker 容器 (tars_dev_nvidia, Ubuntu 24.04, CUDA 12.8)
  │     └── /apollo (mount from host)
  └── USB 以太网 → Thor 开发板 (192.168.10.15, aarch64)
```

## 前置条件

- 主机已安装 `nvidia-container-toolkit`（GPU 透传）
- Docker 镜像: `harbor.tars-ai.com/apollo/os:x86_64-dev-v5.2`
- 容器名: `tars_dev_nvidia`，用户: `nvidia`
- 容器内已安装 `zstd`（压缩工具）
- SSH 密码脚本: `/home/pc/ssh-pass.sh` (内容: `echo "nvidia"`)
- 主机 SSH 服务已安装 (`openssh-server`)，构建机 IP: `192.168.10.1`

## 第一步：启动容器

```bash
cd /home/pc/yyscode/work/thor_workspace/deployment
bash docker/container/container_start.sh --ci -u nvidia
```

如果容器已在运行，直接进入：
```bash
bash docker/container/container_into.sh -u nvidia
```

## 第二步：进入容器并初始化环境

```bash
cd /apollo && source gaea.bashrc
```

## 第三步：编译

```bash
# 单模块编译
./apollo.sh build awr_workflow

# 全部 AWR 模块编译
./apollo.sh build-awr
```

构建参数说明：
- `build-awr` 加载 `scripts/build_sets/awr.conf` 中 `common:` 节的所有模块
- 自动检测 GPU 平台（`--config=gpu --config=nvidia`）
- 输出目录: `bazel-out/k8-fastbuild/bin/modules/`

## 第四步：生成 .run 自解压安装包

```bash
# 在容器内执行
cd /apollo && source gaea.bashrc >/dev/null 2>&1

PACKAGE_NAME="awr_$(date +%Y%m%d_%H%M%S)_release"
echo "AWR Release Package - $(date)" > /apollo/${PACKAGE_NAME}.txt
bash scripts/apollo_install.sh "${PACKAGE_NAME}"
```

产物：`/apollo/${PACKAGE_NAME}.run`（即主机上的 `thor_workspace/deployment/${PACKAGE_NAME}.run`）

`.run` 文件结构：
```
#!/usr/bin/env bash          ← 自解压脚本头
...                          ← 安装逻辑 (kill旧节点 → 释放payload → 校验MD5 → 解压zstd分片)
__APOLLO_INSTALL_PAYLOAD_BELOW__
<tar archive>                ← 内嵌 install.tar (含 zstd 分片 + decompression.sh + MD5校验)
```

## 第五步：测试人员下载 .run 包

### 方式一：wget 下载（推荐，最简单）

构建机起 HTTP 服务：
```bash
# 在主机上执行
cd /home/pc/yyscode/work/thor_workspace/deployment
python3 -m http.server 8080
```

测试人员在 Thor 开发板上执行：
```bash
cd /mnt/gaea/package
wget -c http://192.168.10.1:8080/awr_*_release.run
```

### 方式二：SCP 拉取

测试人员在 Thor 开发板上执行：
```bash
scp pc@192.168.10.1:/home/pc/yyscode/work/thor_workspace/deployment/awr_*_release.run /mnt/gaea/package/
# 密码: qwertqwert
```

### 方式三：从构建机推送

```bash
# 在主机上执行
export SSH_ASKPASS=/home/pc/ssh-pass.sh
export DISPLAY=dummy:0
setsid scp -o StrictHostKeyChecking=no \
  /home/pc/yyscode/work/thor_workspace/deployment/awr_*_release.run \
  nvidia@192.168.10.15:/mnt/gaea/package/
```

## 第六步：部署 .run 包到板子

```bash
# 在板子上执行
cd /mnt/gaea/package
bash awr_*_release.run
```

部署过程自动完成：
1. 检测并清理已有节点
2. 释放安装 payload
3. MD5 校验文件完整性
4. 并行解压 zstd 分片到 `/mnt/gaea/package/`
5. 创建 `/apollo` 符号链接
6. 配置 humanoid-startup systemd 服务开机自启

## 快速参考

| 命令 | 用途 |
|------|------|
| `bash docker/container/container_start.sh -u nvidia` | 启动容器 |
| `bash docker/container/container_into.sh -u nvidia` | 进入容器 |
| `cd /apollo && source gaea.bashrc` | 初始化构建环境 |
| `./apollo.sh build awr_workflow` | 编译单模块 |
| `./apollo.sh build-awr` | 编译全部 AWR 模块 |
| `PACKAGE_NAME=awr_$(date +%Y%m%d_%H%M%S)_release` | 设置包名 |
| `echo "..." > /apollo/${PACKAGE_NAME}.txt` | 创建版本文件 |
| `bash scripts/apollo_install.sh "${PACKAGE_NAME}"` | 生成 .run 自解压包 |
| `python3 -m http.server 8080` | 主机起 HTTP 服务供 wget |
| `wget -c http://192.168.10.1:8080/awr_*_release.run` | 板子下载 |
| `bash awr_*_release.run` | 板子部署 |

## 常见问题

### 1. GPU 未检测到 / USE_GPU_HOST=0
- 原因: 主机未安装 `nvidia-container-toolkit`
- 修复: `sudo apt-get install -y nvidia-container-toolkit && sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker`
- 然后重建容器: `docker stop tars_dev_nvidia && bash docker/container/container_start.sh -u nvidia`

### 2. zstd: command not found（打包时报错）
```bash
# 容器内以 root 安装
apt-get update && apt-get install -y zstd
```

### 3. 编译时 protobuf 版本冲突
- 确保使用 `upb` 实现: `export PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION=upb`
- gaea.bashrc 已自动设置此环境变量

### 4. 构建缓存
- Bazel 缓存位于 `/apollo/.cache/bazel/`
- 远程缓存: `harbor.tars-ai.com` 的 remote cache

### 5. 构建机 SSH 服务未启动
```bash
sudo apt-get install -y openssh-server
sudo systemctl start ssh
systemctl is-active ssh  # 验证
```

### 6. .run 部署后服务未启动
Slot 切换后 `/apollo` 符号链接和 systemd 服务丢失，需手动恢复：
```bash
sudo ln -sfn /mnt/gaea/package/awr_*_output/output /apollo
cd /apollo && source gaea.bashrc
sudo cp /apollo/scripts/humanoid/humanoid_start_up.sh /usr/local/bin/
sudo cp /apollo/scripts/humanoid/humanoid-startup.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now humanoid-startup.service
```