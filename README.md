# agnes-openai-proxy-skill

把 **Agnes AI** 的图像 / 视频模型转成 **OpenAI 协议兼容**的本地代理（单文件、零依赖），让 Hypit 等只支持 OpenAI 形状接口的客户端/agent 框架能像调用文本模型一样调用 Agnes 的生图、生视频能力。

> **为什么需要它**：Agnes 官方的 `/v1/chat/completions` 通道会拒绝 image / video 模型（报"不是 openai 格式"或"请使用 /v1/images/generations"）。本代理按**模型名**自动把请求路由到正确的 Agnes 端点，并对客户端返回标准的 OpenAI 响应。

## 特性

- **单文件、零依赖**：只要 Node ≥ 18，`node agnes-openai-proxy.mjs` 即可运行，无需 `npm install`
- **按模型名智能路由**：model 名含 `image` → 图像生成；含 `video` → 视频生成（自动创建任务 + 轮询到出片）；其余 → 文本透传（支持 SSE 流式）
- **兼容 OpenAI 客户端**：`/v1/chat/completions`、`/v1/models`、`/v1/images/generations`、`/v1/videos` 均可用
- **本地常驻**：默认只监听 `127.0.0.1:18787`，密钥不出本机
- **跨平台服务化**：Windows（bat 守护 + VBS 开机自启）、macOS/Linux（launchd / systemd / cron）

## 快速开始

### 1. 前置要求

- [Node.js](https://nodejs.org/) ≥ 18（无其他依赖）
- 一个 Agnes API Key（国内站 [api.agnes-ai.cn](https://api.agnes-ai.cn) 或国际站 apihub.agnes-ai.com）

### 2. 配置 API Key（不要提交到 git！）

```bash
# macOS / Linux
echo "你的agnes密钥" > ~/.agnes_key

# Windows (PowerShell)
"你的agnes密钥" | Out-File -Encoding ascii "$env:USERPROFILE\.agnes_key"
```

也可以用环境变量 `AGNES_API_KEY` 直接传入。Key 的读取顺序：

```
AGNES_API_KEY → AGNES_KEY_FILE → ~/.agnes_key → ~/.workbuddy/agnes-key.txt
```

### 3. 启动代理

```bash
# 前台运行（先跑通）
node scripts/agnes-openai-proxy.mjs

# macOS / Linux：后台常驻
bash scripts/agnes-proxy-service.sh start

# Windows：双击 scripts/agnes-proxy-start.bat（带守护，崩溃 5 秒自动重启）
```

### 4. 验证

```bash
curl http://127.0.0.1:18787/healthz
# {"ok":true,"upstream":"https://api.agnes-ai.cn","key_loaded":true}
```

### 5. 生个图试试

```bash
curl http://127.0.0.1:18787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "agnes-image-2.5-flash",
    "messages": [{"role": "user", "content": "一只戴墨镜的橘猫，赛博朋克风格"}]
  }'
```

返回的是标准 OpenAI chat 响应，`content` 里是图片链接（Markdown 格式）。视频同理，把 model 换成 `agnes-video-2.5-flash`（会自动轮询任务直到出片，返回视频下载地址）。

## 客户端接入

| 客户端 | 配置 |
|---|---|
| Hypit 等框架 | Base URL: `http://127.0.0.1:18787/v1`，API Key 随意填 |
| OpenAI SDK (Python) | `base_url="http://127.0.0.1:18787/v1"` |
| OpenAI SDK (JS) | `new OpenAI({ baseURL: "http://127.0.0.1:18787/v1" })` |

参考图 / 首尾帧：在 `messages` 里用 OpenAI 的 `image_url` 内容块传图即可，代理会自动取最后一条用户消息里的全部图片作为参考图（视频最多 5 张）。

## 请求路由表

| 请求 | 行为 |
|---|---|
| `POST /v1/chat/completions`（model 含 image） | 转调 Agnes 图像生成，包装成 chat 回复 |
| `POST /v1/chat/completions`（model 含 video） | 创建 Agnes 视频任务 + 自动轮询（超时默认 900s），包装成 chat 回复 |
| `POST /v1/chat/completions`（其他 model） | 原样透传到 Agnes 文本接口（含 SSE 流式） |
| `POST /v1/images/generations` | 透传（自动把顶层 `response_format` 规范化进 `extra_body`） |
| `POST /v1/videos` | 透传（创建视频任务） |
| `GET /agnesapi?video_id=&model_name=` | 透传（视频任务查询） |
| `GET /v1/models` | 透传 |
| `GET /healthz` | 健康检查 |

## 作为 WorkBuddy 技能使用

把整个目录放到 `~/.workbuddy/skills/agnes-openai-proxy`，之后在对话里直接说"**启动 agnes 代理**"即可。技能说明见 [SKILL.md](SKILL.md)。

## 开机自启

**Windows**：把 `scripts/agnes-proxy-autostart.vbs` 复制到启动文件夹（`Win+R` → `shell:startup`），登录后会静默启动并带崩溃守护。移除自启 = 删掉该文件。

**macOS / Linux**：

```bash
bash scripts/agnes-proxy-service.sh install-autostart
# macOS 生成 launchd plist；systemd 机器生成 user service；其他输出 cron @reboot 指引
# 卸载：bash scripts/agnes-proxy-service.sh uninstall-autostart
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AGNES_API_KEY` | — | Agnes API Key（也可用 Key 文件，见上） |
| `AGNES_BASE_URL` | `https://api.agnes-ai.cn` | 上游站点（国际站填 `https://apihub.agnes-ai.com`） |
| `PORT` | `18787` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址（**请勿改成 0.0.0.0 暴露到公网**） |
| `AGNES_VIDEO_POLL_TIMEOUT` | `900` | 视频轮询超时（秒） |

## 故障排查

- **端口被占**：换端口 `PORT=18788 node scripts/agnes-openai-proxy.mjs`，客户端 Base URL 同步改
- **`key_loaded: false`**：检查 Key 文件路径 / 环境变量
- **429 / 队列满**：Agnes 免费档限速，等 30–60 秒重试；视频任务由代理自动轮询，无需干预
- **看日志**：Windows 守护模式日志在脚本同目录 `agnes-proxy.log`；macOS/Linux 同理

## 安全说明

- 本仓库**不包含任何 API Key**，密钥只在本机通过环境变量或 Key 文件加载
- 代理默认只监听 `127.0.0.1`，不会暴露到局域网/公网
- 安装技能前建议先做一次安全审计（本技能已通过审计：仅连接 Agnes 官方上游、零依赖、无下载执行）

## 目录结构

```
agnes-openai-proxy/
├── SKILL.md                        # WorkBuddy 技能说明（agent 用）
├── README.md                       # 本文件（人类用）
└── scripts/
    ├── agnes-openai-proxy.mjs      # 代理主体（单文件、零依赖）
    ├── agnes-proxy-start.bat       # Windows 启动 + 崩溃守护
    ├── agnes-proxy-stop.bat        # Windows 完整停止（杀守护 + node）
    ├── agnes-proxy-autostart.vbs   # Windows 开机静默自启
    └── agnes-proxy-service.sh      # macOS/Linux 启停/状态/自启管理
```
