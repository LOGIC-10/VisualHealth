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
   默认仅使用 `docker-compose.yml`（生产配置）。如需启用热更新开发模式，显式加上 `VISUALHEALTH_INCLUDE_DEV_OVERRIDE=1` 环境变量，例如 `VISUALHEALTH_INCLUDE_DEV_OVERRIDE=1 bash scripts/start.sh`。
3) 访问：
   - 前端：http://localhost:3000
   - Auth：http://localhost:4001/health
   - Media：http://localhost:4003/health
   - Analysis：http://localhost:4004/health
 - Feed：http://localhost:4005/health
   默认前端通过 `/api/*` 代理请求后端；仅当你绕过 Docker 直接运行 `npm run dev` 时，需在环境中设置 `NEXT_PUBLIC_API_AUTH=http://localhost:4001` 等变量或使用本地反向代理，否则浏览器无法连接各服务。

生产部署建议
- 仅暴露前端端口（默认 3000，可置于 Nginx/Traefik 反向代理后提供 80/443）；其余服务和数据库现在只在 Compose 网络内互联。
- 如需本地调试/数据库连通，可以在开发机器上以 `VISUALHEALTH_INCLUDE_DEV_OVERRIDE=1` 启动，override 文件会重新映射 4001/4003… 及 5433–5436 端口。

热更新（前端）
- 已提供 docker-compose.override.yml，使前端以开发模式运行（next dev），并挂载源码目录。
- 代码改动后浏览器会热更新；若未自动热替换，刷新页面即可看到最新效果。
- 默认启用文件轮询（WATCHPACK_POLLING/CHOKIDAR_USEPOLLING）以兼容 Docker on macOS 的文件事件。
- 如需单独启动前端开发：
  - 方式一（Docker）：`docker compose up frontend -d`（会自动 npm install 并运行 dev）。
  - 方式二（本机）：`cd apps/web && npm install && npm run dev`（其余服务仍通过 Docker 提供）。

- Web（Jest，Node 环境）：`cd apps/web && npm install && npm test`。覆盖 `lib/`、`components/`、`app/api/` 与 `middleware.ts`，以及 LLM 流式代理与 Edge Middleware 场景，验证请求缓存、SSE 透传与 Cookie 设置。
- Web E2E（Playwright）：`cd apps/web && npm install && npx playwright install && npm run test:e2e`。自动驱动浏览器走访客注册 → 邮箱验证引导 → 重新登录的端到端路径，依赖整个 docker-compose 栈运行；本地先 `bash scripts/start.sh`，或设置环境变量 `E2E_BASE_URL` 覆盖默认 `http://localhost:3000`。
- Node.js 微服务（Jest + Supertest + pg-mem）：依次执行 `cd services/<service> && npm install && npm test`，具体包括 `auth`、`media`、`analysis`、`feed`。全部测试在内存数据库中自动建表，覆盖鉴权边界、数据校验、缓存/加密策略、媒体签名 URL 以及社区投票状态机等关键路径。
- Python 服务（Pytest + FastAPI TestClient）：`cd services/viz && pip install -r requirements.txt && pytest` 与 `cd services/llm && pip install -r requirements.txt && pytest`。通过注入 httpx/LLM stub 验证波形特征、频谱生成、HSMM 事件抽取与流式聊天异常兜底。
- 汇总回归：`bash scripts/run-tests.sh` 串行执行所有前端、Node 微服务与 Python 服务单元测试，默认带 `--runInBand`/`pytest -q`。端到端测试体量较大，需单独运行 `npm run test:e2e`。
- 日常排查：可继续在各目录单独调用测试命令，所有套件默认无需真实数据库或外部网络；如需覆盖新增服务，请同步更新脚本与 README。
- 覆盖约定：新增模块保持 ≥80%，关键路径（认证、媒体加密、分析缓存、LLM 网关、前端音频预处理与边缘路由）均维持成功/失败场景测试。提交新功能必须附带相应测试或说明例外情况。

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

Analysis Service（AI 报告保存接口）
- 背景：AI 分析不再由后端算法计算指标，而是由前端将已有指标（clinical PCG `adv` + 基础特征 `features`）拼接进 prompt 调用 LLM 生成文本。为保持数据一致性与审计，新增专用接口用于保存 AI 报告文本。
- 接口：`POST /records/:id/ai`
  - 鉴权：`Authorization: Bearer <token>`（记录必须属于该用户）
  - 请求体：
    - `lang`：语言代码（如 `zh`、`en`），默认 `zh`
    - `text`：AI 生成的 Markdown 文本（必填）
    - `model`：可选，模型标识（默认 `llm`）
  - 响应（示例）：
    ```json
    {
      "ok": true,
      "ai": { "model": "llm", "texts": { "zh": "...markdown..." } },
      "ai_generated_at": "2025-09-13T04:56:12.345Z"
    }
    ```
  - 错误码：
    - `401 unauthorized`：缺少/无效 token
    - `404 not found`：记录不存在或非当前用户
    - `400 text required`：缺少 `text`
- cURL 示例：
  ```bash
  curl -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
          "lang": "zh",
          "text": "## 结论\n常规节律……",
          "model": "gpt-xx"
        }' \
    http://localhost:4004/records/<record_id>/ai
  ```
- 迁移说明：
  - 已移除旧接口 `POST /records/:id/ai_start`（后端算法与后台 pending 机制不再使用）。
  - 前端/客户端流程：先用本地指标构造 prompt 调用 LLM → 拿到文本后调用本接口保存 → UI 读取 `ai.texts[lang]` 展示。

算法评估（可选）
- 已提供两个脚本用于公共数据集上的离线评估，运行结果会以时间戳 JSON 存于 `evals/` 便于迭代：
  - PhysioNet 2016（正常/异常）：
    - 脚本：`scripts/eval_physionet2016_iter.py`
    - 示例（各类各取 100 条，共 200 条）：
      - `python scripts/eval_physionet2016_iter.py --per-class 100 --out-dir evals/physionet2016`
    - 输出：基于无训练“杂音得分”的 AUROC/准确率，以及样例行。
  - PhysioNet 2022 / CirCor DigiScope（儿童，多部位，含分割）：
    - 脚本：`scripts/eval_circor2022_iter.py`
    - 会按需下载 `training_data.csv` 与对应 WAV/TSV 标注；示例（100 个受试者、每人 2 个位置）：
      - `python scripts/eval_circor2022_iter.py --subjects 100 --per-subject-locs 2 --out evals/physionet2022`
    - 输出：病人层面的杂音 AUROC 与分割 macro‑F1 指标；同时给出样例行。
  - 依赖：`numpy`, `scipy`, `scikit-learn`, `fastapi`, `httpx`（脚本首次会提示安装）。
  - 备注：评测为离线工具，产品功能不依赖，可按需运行。

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
