# 羽光智教（Yuguang Digital Coach）

> 基于本地视频分析的羽毛球数字孪生教练平台<br>
> 暨南大学“羽光智教”团队出品

[![Release](https://img.shields.io/badge/release-v1.0.1-2764ff)](https://github.com/Ryrant/yuguang-digital-coach/releases/tag/v1.1.0)
[![License](https://img.shields.io/badge/license-MIT-24cdb8)](LICENSE)
[![Privacy](https://img.shields.io/badge/video-local--only-ffb33e)](#隐私与数据边界)

羽光智教是一个面向固定机位羽毛球单打视频的本地分析与展示平台。它将视频播放、球场标定、球员运动分析、姿态关键点、标准球场映射、训练指标、证据时间戳、训练建议和 2.5D 数字孪生回放整合在同一套网页界面中。

本仓库发布的是可离线运行的 `v1.1.0` 开源版本。原始学生训练视频、数据库和预计算分析结果不包含在仓库中；使用者可在平台界面中选择自己有权处理的 MP4 视频。

## v1.1.0 能力

| 模块     | 当前实现                                       | 状态  |
| ------ | ------------------------------------------ | --- |
| 本地案例库  | 在训练中心选择并导入本机 MP4 视频                        | 可用  |
| 视频播放   | FastAPI HTTP Range 流式播放，可拖动时间轴             | 可用  |
| 球场标定   | 手动点击四个角点，保存到 SQLite                        | 可用  |
| 球员运动分析 | OpenCV 固定机位运动基线、轨迹采样与身份侧选择                 | 可用  |
| 姿态分析   | MediaPipe BlazePose GHUM 视频关键点与置信度过滤       | 可用  |
| 球场映射   | 单应性变换到标准单打球场坐标                             | 可用  |
| 训练指标   | 距离、覆盖率、左右平衡、回中效率、节奏                        | 可用  |
| 训练建议   | 指标规则、证据时间戳、原因、处方、目标和验收标准                   | 可用  |
| 数字孪生   | 2.5D 球场、路线、落点和动作复现界面                       | 可用  |
| 网页报告   | 分析结果页面及浏览器打印                               | 可用  |
| 羽球轨迹   | TrackNetV3 接口方向已保留，但模型权重与可靠推理尚未随 v1.1.0 发布 | 未启用 |
| MMPose | 尚未作为默认运行时；当前默认姿态后端为 MediaPipe              | 规划中 |

## 技术架构

```text
浏览器
  └─ React 19 + TypeScript + Vinext/Vite
       ├─ 首页与案例库
       ├─ 分析实验室
       ├─ 2.5D 数字孪生
       └─ 训练报告
            │ HTTP / JSON / Range
            ▼
FastAPI 本地服务（127.0.0.1:8000）
  ├─ OpenCV 视频解码与运动轨迹
  ├─ MediaPipe BlazePose 姿态关键点
  ├─ 单应性球场映射与指标规则
  ├─ SQLite 任务、标定与分析索引
  └─ JSON 姿态/分析产物
            │
            ▼
本机导入视频与 platform/data/
```

所有服务默认只监听本机回环地址，不依赖 Docker、WSL 或 Hyper-V。

## 系统要求

推荐环境：

- Windows 10/11（当前一键脚本为 PowerShell）
- Node.js `22.13+`
- Python `3.11` 或 `3.12`
- 8 GB 以上内存
- FFmpeg 可选；当前主要通过 OpenCV 解码
- NVIDIA GPU 可选，CPU 也可以运行核心流程

本项目已在以下环境验证：

- Windows 11
- Python 3.12.7
- Node.js 22+
- RTX 4060 Laptop 8 GB

## 快速复现

解压项目后进入项目根目录。首次安装需要能够访问 Python 与 npm 软件源，安装完成后的日常启动和分析均在本机运行。

### 1. 安装

双击根目录的 `install.cmd`，或在 PowerShell 中运行：

```powershell
.\install.cmd
```

安装脚本会自动检测 Python 3.11/3.12 与 Node.js 22.13+，创建项目专用的 `platform/.venv`，执行 `pip install -r requirements.txt` 和 `npm ci`，修复 Vinext 的 Windows 兼容项，并完成后端及姿态资源自检。依赖均安装在项目目录内，不会把 Python 包安装到系统 Python 中。

如果没有安装 Python 3.12 和 Node.js 22 LTS，请以管理员身份打开 CMD，依次运行：

```cmd
winget install --id Python.Python.3.12 -e
winget install --id OpenJS.NodeJS.LTS -e --version 22.23.1
```

> **注意：** Node.js 更新的版本可以兼容，但是 Python 3.13 及以上版本无法运行。

安装的项目直接依赖如下；它们的间接依赖由 `requirements.txt` 和 `package-lock.json` 锁定并自动安装。

| 类别 | 直接依赖 |
| --- | --- |
| Python Web 服务 | `fastapi==0.115.12`、`uvicorn[standard]==0.30.6`、`pydantic>=2.5,<3` |
| Python 视频与模型 | `numpy==1.26.4`、`opencv-contrib-python==4.11.0.86`、`mediapipe==0.10.14`、`jax==0.4.35`、`jaxlib==0.4.35` |
| 前端运行时 | `next==16.2.6`、`react==19.2.6`、`react-dom==19.2.6`、`drizzle-orm==0.45.2` |
| 前端构建工具 | `vinext==0.0.50`、`vite==8.0.13`、`wrangler==4.92.0`、`typescript==5.9.3`、`tailwindcss==4.2.1`、`eslint==9.39.4` |
| 前端配套工具 | `@cloudflare/vite-plugin==1.37.1`、`@vitejs/plugin-react==6.0.2`、`@vitejs/plugin-rsc==0.5.26`、`@tailwindcss/postcss==4.2.1`、`drizzle-kit==0.31.10`、`eslint-config-next==16.2.6`、`react-server-dom-webpack==19.2.6` 及对应 TypeScript 类型包 |

PyTorch、CUDA、Docker、WSL 和 Hyper-V 均不是默认依赖。

### 2. 启动

双击根目录的 `start.cmd`，或运行：

```powershell
.\start.cmd
```

脚本会启动：

- 前端：<http://localhost:3000>
- API：<http://127.0.0.1:8000>
- 健康检查：<http://127.0.0.1:8000/api/health>

启动成功后会自动打开浏览器。

### 3. 停止

双击根目录的 `stop.cmd`，或运行：

```powershell
.\stop.cmd
```

进程号保存在 `platform/.run/`，持久日志保存在 `platform/logs/`。若端口被其他程序占用或服务未就绪，脚本会给出具体日志路径。

## 使用流程

1. 进入“训练中心”，点击“选择视频”导入本机 MP4；
2. 选择近端或远端球员；
3. 依次点击近左、近右、远右、远左四个球场角点；
4. 启动分析并等待任务完成；
5. 在诊断页面查看视频、球场路径、热区、指标和训练建议；
6. 点击证据时间戳回看对应片段；
7. 进入数字孪生页面复现动作与移动路线；
8. 使用“生成报告”调用浏览器打印。

首次分析较长视频时需要等待。答辩或演示场景建议提前预计算。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 服务、GPU、姿态后端状态 |
| `GET` | `/api/videos` | 枚举本地 MP4 与元数据 |
| `GET` | `/api/videos/{id}/stream` | 支持 Range 的视频流 |
| `GET` | `/api/videos/{id}/pose` | 计算或读取姿态关键点 |
| `POST` | `/api/videos/{id}/calibration` | 保存四点球场标定 |
| `POST` | `/api/analyses` | 创建分析任务 |
| `GET` | `/api/jobs/{id}` | 查询任务进度 |
| `GET` | `/api/analyses/{id}` | 获取分析结果 |

FastAPI 交互文档：<http://127.0.0.1:8000/docs>

## 目录结构

```text
.
├─ README.md
├─ LICENSE
├─ CHANGELOG.md
├─ install.cmd              # 首次安装与依赖自检
├─ start.cmd                # 启动前端和本地分析服务
├─ stop.cmd                 # 停止平台服务
└─ platform/
   ├─ app/                  # React 页面与样式
   ├─ backend/main.py       # FastAPI 与分析内核
   ├─ data/                 # SQLite、姿态缓存、分析产物（不提交）
   ├─ public/               # 静态资源
   ├─ requirements.txt
   ├─ setup.ps1
   ├─ start.ps1
   ├─ package.json
   └─ package-lock.json
```

## 验证

前端生产构建：

```powershell
cd platform
npm run build
```

前端测试：

```powershell
npm test
```

后端导入与健康检查：

```powershell
.\.venv\Scripts\python.exe -c "from backend.main import health; print(health())"
```

## 可选 GPU 状态

核心平台不强制安装 PyTorch。若希望健康接口展示 CUDA 设备，可自行安装与显卡驱动匹配的 PyTorch：

```powershell
.\.venv\Scripts\python.exe -m pip install torch
```

请参考 PyTorch 官方安装器选择正确的 CUDA 版本。没有 PyTorch 时，平台会正常运行并将 GPU 状态标记为不可用。

## 数据与隐私边界

- 原始视频不会上传公网；
- 不进行人脸识别；
- 不要求保存真实姓名；
- 导入的视频、`platform/data/`、数据库和分析缓存默认不会提交到公开仓库；
- 公开仓库不包含暨南大学学生训练原视频；
- 使用者应确保对导入视频具有合法处理权限；
- 训练建议只用于训练参考，不能替代专业教练或医疗判断。

## 常见问题

### 中文路径或 OneDrive 路径读取失败

建议先确认所选视频已完整下载到本机；如果 OneDrive 显示“正在同步”，可先下载完成再从平台界面选择。

### 端口被占用

检查 `3000` 和 `8000`：

```powershell
Get-NetTCPConnection -LocalPort 3000,8000 -ErrorAction SilentlyContinue
```

### 校园网提示多个虚拟网卡

本项目不需要 Docker、WSL、Hyper-V 或虚拟网卡。`start.ps1` 只启动本机进程并监听 `127.0.0.1`。

### MediaPipe 安装失败

优先使用 Python 3.11 或 3.12 的 64 位版本，并升级 pip：

```powershell
python -m pip install --upgrade pip
```

## 版本路线

- `v1.0.0`：本地视频闭环、球场标定、跑位分析、MediaPipe 姿态、指标建议、数字孪生与报告；
- `v1.1`：修复已知bug，优化体验；
- `v1.2`：可修正轨迹、回合边界与击球事件；
- `v1.3`：接入经过验证的 TrackNetV3 羽球轨迹；
- `v2.0`：可替换 MMPose/RTMPose 后端、更加完整的 3D 数字孪生。

## 开源协议

代码采用 [MIT License](LICENSE)。

如在课程项目、论文、比赛或演示中使用，请注明：

```text
羽光智教：基于本地多模态视频分析的羽毛球数字孪生教练平台
暨南大学“羽光智教”团队，v1.1.0，2026
https://github.com/Ryrant/yuguang-digital-coach
```

## 第三方资源说明

- MediaPipe、OpenCV、FastAPI、React 等依照各自开源协议使用；
- 首页青年羽毛球图片：Vlad Vasnetsov / Pexels；
- BWF Coach Education Level 1 只作为训练建议知识来源，不随仓库分发其受版权保护的材料。

---

暨南大学“羽光智教”团队出品 · 训练建议仅供训练参考
