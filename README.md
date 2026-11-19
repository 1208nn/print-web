# print-web

给 CUPS 队列加一个网页：上传 PDF、图片或纯文本，按单双面、纸张、清晰度提交打印。

网页提交的作业和 AirPrint、桌面客户端走同一个 CUPS 队列、同一条过滤链，不存在两套参数实现。

## 功能

- 拖拽或选择文件，可一次提交多个
- 单面 / 双面长边 / 双面短边，纸张与分辨率可选
- 右上角显示打印机名和队列状态，最近任务显示页数、时间、结果，可取消
- 无 npm 依赖，单文件后端

## 依赖

| 依赖 | 用途 |
|---|---|
| Node.js ≥ 18 | 运行服务 |
| `cups-client` | `lp` / `lpstat` / `cancel` |
| `ghostscript` | PostScript 转 PDF |
| `poppler-utils`（可选） | 用 `pdfinfo` 显示页数 |
| `qrencode`（可选） | 测试页上的二维码 |

```sh
# Debian / Ubuntu
apt install cups-client ghostscript poppler-utils qrencode
# Alpine
apk add cups-client ghostscript poppler-utils libqrencode-tools
```

同机需要已经配置好 CUPS 队列。

## 快速开始

```sh
CUPS_QUEUE=my-printer node server.mjs
```

打开 `http://localhost`。默认监听 80 端口，非 root 运行时可改用 `PORT=8080`。不设 `CUPS_QUEUE` 时自动使用 `lpstat -d` 的默认队列；找不到队列服务仍会启动，提交时返回 503。

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOST` | `0.0.0.0` | 监听地址 |
| `PORT` | `80` | 监听端口 |
| `CUPS_QUEUE` | 空 | 目标队列；留空用系统默认队列 |
| `CUPS_SERVER` | 空 | 远端 CUPS，填 `host:port` |
| `DEFAULT_DUPLEX` | `long` | `off` / `long` / `short` |
| `DEFAULT_PAPER` | `auto` | `auto` / `a4` / `letter` / `legal` / `a5` |
| `DEFAULT_RESOLUTION` | `600` | `300` / `600` / `1200` |
| `MAX_MB` | `50` | 单文件上限 |
| `QUEUE_MAX` | `20` | 排队上限 |
| `LP` / `LPSTAT` / `CANCEL` / `GS` | 同名命令 | 可执行文件路径 |
| `DRY_RUN` | 空 | `1` 时不调用 `lp`，只走任务状态机 |

页面上的选项会覆盖这些默认值，初始值由 `/api/status` 下发。

## 部署

### OpenRC

```sh
apk add nodejs cups-client ghostscript poppler-utils libqrencode-tools

install -d /opt/print-web
cp -r server.mjs public /opt/print-web/
install -m755 deploy/print-web.openrc /etc/init.d/print-web
install -m644 deploy/print-web.env.example /etc/conf.d/print-web   # 改 CUPS_QUEUE

rc-update add print-web default
rc-service print-web start
```

### systemd

```sh
useradd -r -G lp -s /usr/sbin/nologin print    # 需要 lp 组才能访问 CUPS socket

install -d /opt/print-web
cp -r server.mjs public /opt/print-web/
install -m644 deploy/print-web.service /etc/systemd/system/
install -m640 deploy/print-web.env.example /etc/print-web.env   # 改 CUPS_QUEUE

systemctl daemon-reload
systemctl enable --now print-web
```

用其它用户运行时，该用户需要能执行 `lp` 并访问 CUPS socket（通常在 `lp` 组）。服务单元已授予 `CAP_NET_BIND_SERVICE`，非 root 也能监听 80 端口。

测试页二维码优先使用能解析的 `<hostname>.local` / `<hostname>.lan`，否则使用浏览器访问时的主机地址。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 页面 |
| GET | `/api/status` | 打印机名、队列状态、默认选项 |
| GET | `/api/jobs` | 最近 30 个任务 |
| POST | `/api/jobs?name=&duplex=&paper=&copies=&resolution=` | body 为文件二进制 |
| POST | `/api/jobs/:id/cancel` | 取消任务 |
| POST | `/api/test?duplex=&paper=&resolution=` | 打印测试页（两页；含指向本站的二维码与链接） |

`duplex` 取 `off` / `long` / `short`，分别映射为 `lp` 的 `sides=one-sided` / `two-sided-long-edge` / `two-sided-short-edge`。

队列状态：`idle`、`printing`、`disabled`（暂停）、`missing`（找不到队列）、`unconfigured`（未配置队列）。

## 行为与限制

- **PostScript 先转 PDF**。部分 PPD 没有 `*cupsFilter`，cupsd 会把 PS 原样直通给打印机，`pdftops` / `pstops` 不运行，`sides` 等选项静默失效。统一转成 PDF 后可保证所有输入走同一条过滤链。
- **任务逐个提交**。同一时刻只有一个 `lp` 在跑，排到队首才提交，避免网页作业和手机作业交错。
- **状态以 CUPS 为准**。提交后轮询 `lpstat`，作业离开队列即视为完成；不显示进度百分比。
- **纯文本仅支持 ASCII**。中文等非 ASCII 文本请先“打印成 PDF”再上传。
- Office 文档和压缩包不接受，需先另存为 PDF。
- 缺纸时队列会停在“正在打印”，补纸后继续。
- **不要暴露到公网**。服务没有认证，任何能访问端口的人都能打印；远程使用请走 VPN 或 tailnet。

## 调试

```sh
DRY_RUN=1 CUPS_QUEUE=test node server.mjs
```

任务会正常入队、显示状态并标记完成，但不调用 `lp`，适合验证页面和接口。

## 目录

```
server.mjs              后端（HTTP + CUPS 调用）
public/index.html       页面
deploy/print-web.openrc OpenRC 服务
deploy/print-web.service systemd 服务
deploy/print-web.env.example 环境变量示例
```
