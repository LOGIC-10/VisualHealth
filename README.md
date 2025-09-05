VisualHealth — 心音可视化与社区（微服务架构）

概述
- 目标：全球用户可上传心音，查看波形/基础特征，在社区发布内容互动。
- 架构：前端 + 认证服务 + 媒体加密存储服务 + 分析服务 + 社区服务；每个服务有独立数据库，低耦合高内聚，方便后续扩展算法服务。
- 加密：上传的音频以 AES‑256‑GCM 在媒体服务侧加密，密文、IV、Tag 与用户绑定存储在媒体库。
- 运行平台：面向 macOS Apple Silicon（M1/M2），使用 Docker Compose 一键启动/停止。

目录结构
- apps/web：Next.js 前端（首页、分析、社区、设置、登录/注册）。
- services/auth：认证服务（注册/登录、用户资料）。
- services/media：媒体服务（上传/列表/下载，AES‑256‑GCM 加密存储）。
- services/analysis：分析服务（接收下采样 PCM，计算 RMS/ZCR/峰值率等基础特征）。
- services/feed：社区服务（帖子、点赞、收藏、评论）。
- docker-compose.yml：本地多服务编排；每个服务对应独立 Postgres。
- scripts/start.sh / scripts/stop.sh：一键启动/停止所有服务。

快速开始（本地）
1) 安装 Docker Desktop（Apple Silicon 版本）。
2) 在项目根目录执行：
   - 启动：bash scripts/start.sh
   - 停止：bash scripts/stop.sh
3) 访问：
   - 前端：http://localhost:3000
   - Auth：http://localhost:4001/health
   - Media：http://localhost:4003/health
   - Analysis：http://localhost:4004/health
   - Feed：http://localhost:4005/health

热更新（前端）
- 已提供 docker-compose.override.yml，使前端以开发模式运行（next dev），并挂载源码目录。
- 代码改动后浏览器会热更新；若未自动热替换，刷新页面即可看到最新效果。
- 默认启用文件轮询（WATCHPACK_POLLING/CHOKIDAR_USEPOLLING）以兼容 Docker on macOS 的文件事件。
- 如需单独启动前端开发：
  - 方式一（Docker）：`docker compose up frontend -d`（会自动 npm install 并运行 dev）。
  - 方式二（本机）：`cd apps/web && npm install && npm run dev`（其余服务仍通过 Docker 提供）。

账号与登录
- 前端“Login/Sign up”完成注册/登录；浏览器本地保存 JWT（localStorage: vh_token）。
- 受保护接口通过 Authorization: Bearer <token> 访问（示例：上传、发帖、点赞等）。

上传与分析流程
- 分析页选择音频文件后：
  - 前端用 WebAudio 解码并下采样（默认至 ~8kHz）
  - 调用 analysis-service /analyze 返回基础特征（RMS、ZCR、峰值率等）
  - 同时可调用 media-service /upload 进行加密存储（页面示例已包含上传位点，请按需接入）
- 波形与频谱：
  - 波形在前端用 wavesurfer.js 可视化。
  - 频谱图可通过 wavesurfer 插件或后续引入服务端生成（此版本优先前端渲染）。

数据与安全
- 每个微服务使用独立 Postgres（auth-db、media-db、feed-db）。
- 媒体服务使用 AES‑256‑GCM：
  - 每个文件生成随机 12B IV；
  - 密钥来自环境变量 MEDIA_MASTER_KEY_BASE64（32 字节 Base64）。
  - 存储字段：ciphertext（密文）、iv、tag，与 user_id 关联。
  - 开发环境若未提供有效密钥，会使用不安全的默认密钥（仅限本地测试）。

扩展与演进
- 分析服务目前基于前端提供的 PCM 计算基础特征，后续可：
  - 新增 Python/FastAPI + librosa/torch 的算法服务（独立容器、独立 DB）。
  - 通过消息总线或任务队列执行离线重计算。
- 网关/鉴权：生产建议在入口网关统一校验 JWT 与路由策略（本演示为直连后端 + CORS）。

注意
- 首次启动会拉取镜像并构建，耗时较长；M1/M2 架构镜像已支持。
- 如需变更端口或环境变量，请修改 docker-compose.yml 与相关服务配置。
