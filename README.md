# dsh-task-confirm

> 非官方插件，与 DeepSeek 无隶属关系。

DeepSeek Harness 的两阶段任务确认 host 插件。它不依赖任何具体通道：Web 控制台、微信、CLI 等其他入口的顶层会话都走同一套门禁。

插件必须 `inject` `systemPrompt` 与 `tools` 两个宿主服务；在 Web profile 里还会按需等待 `connection` 服务，为设置页提供状态 API。此外它监听 `session/*` 与 `agent/pre-step` 事件。

## 安装

要求 Node 20+，宿主为 DeepSeek Harness 0.2.1-rc.2（针对该版本开发与验证）。Web 设置页需要 web profile 且宿主提供 `connection`、`configForms` 与 `plugins.item`；headless profile 只有门禁与服务。

```bash
git clone https://github.com/czdtech/dsh-task-confirm.git
cd dsh-task-confirm
pnpm install

# 把本仓库的绝对路径加进 web profile
dsh plugin --profile web add /absolute/path/to/dsh-task-confirm
```

`lib/` 已随仓库发布，克隆后不需要编译。改过 `src/` 才需要 `pnpm build`，并把 `lib/` 一起提交。

也可以直接从 GitHub 安装，安装时不需要执行构建：

```bash
dsh plugin --profile web add github:czdtech/dsh-task-confirm
```

安装后重载插件或重启宿主。插件自带的 `cordis.patch.yml` 会把自己插入 profile，不需要再改其他配置文件。

插件默认 `enabled: true`，**装上即生效**；如果只想安装暂不启用，先在 profile 配置里把 `enabled` 设为 `false`，或装好后在设置页关闭。

如果本地 pnpm 仍提示 `Ignored build scripts`（旧版工具链），运行 `pnpm approve-builds` 允许 `esbuild`，或确认 `pnpm-workspace.yaml` 里的 `allowBuilds` 已生效。

## 它做什么

需要改动文件、执行命令、调用子代理或改变系统状态的任务分两阶段执行：

1. **理解阶段**：模型可以先用只读工具调研，然后输出一段以「【任务理解】」开头的消息（目标、约束、做法、产出，必要时附一行「需要你定」），并结束本轮。此阶段修改类工具被 `tools/pre-execute` 直接拒绝，模型无法抢跑。
2. **执行阶段**：用户回复明确的确认词（「继续」「确认」等）后，模型按确认后的理解执行。给出修正后需要重新输出任务理解、再次确认。回复「取消」放弃本次任务。

纯问答或不需要动手的任务直接回答，不进入确认流程。

授权粒度是**一轮**：`turn/start` 会重新关上闸门，确认词换来的是一次全开窗口，不是永久放行。

## 门禁细节

- **只有真正的任务理解才会进入待确认**。模型撞了一次修改类工具但没输出任务理解时，轮末不会留下待确认；下一轮仍然从只读开始。
- **待确认有有效期**：`pendingTtlMs`（默认 2 小时）内没有人类回复就自动失效，避免很久以前的状态被一句无关消息激活。设为 `0` 表示不过期。
- **任务理解之后、本轮结束之前，所有工具都被拒绝**，包括只读工具——协议要求模型输出后立即结束本轮。
- **任务理解按行首识别**：允许 `#`/`>`/`*`/`+`/`-` 列表前缀；代码块（``` 围栏）里的引用不算，避免模型复述协议原文时误触发。
- **确认/取消词是整条消息精确匹配**：忽略首尾空白、尾部标点和大小写；长句里出现「取消」「继续」都不算，`不要继续` 也不会被当成确认。
- **待确认只接受明确的确认词**：等待期间其他人类消息不会解锁闸门，待确认状态保持不变（仍受 TTL 约束）；需要修正时模型重新给出任务理解，用户再确认。
- **确认只能由真人消息消费**：状态在 `agent/pre-step` 里被消费，且只认 `role === 'user'` 且 `source.kind === 'user'` 的消息。目标续轮、定时任务、文件变更通知等合成消息不会把「等待确认」升级成「已确认」。
- **无人值守的轮次不受闸门约束**：一轮的第一步如果没有人类消息（如 goal 续轮、定时任务），该轮直接放行，也不会注入确认协议；待确认状态不会被这类轮次消费。之后若同轮收到人类消息，从那一刻起恢复门禁。
- **异常轮次不留下待确认**：`turn/end` 原因为 `completed` / `max-tokens` 之外的值（含事件缺少 reason）一律复位。
- **内部异常一律失败开放**：门禁自身出错时放行工具调用并记录日志，绝不因插件异常中断宿主。
- **重复加载不抛异常**：`taskConfirm` 服务注册失败说明已有实例在管闸门，本实例保持惰性；协议段重复注册只记日志。

## 配置

`cordis.patch.yml` 只插入插件本身，全部字段走默认值：

```yaml
- insert:
    - id: dsh-task-confirm
      name: 'dsh-task-confirm'
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关闭后不注入协议、不拦截工具，服务 `phase()` 恒为 `undefined`、`cancel()` 恒为 `false`；重新开启即时恢复，旧的待确认状态已清空 |
| `marker` | `【任务理解】` | 理解阶段的识别前缀；配置为空时回退到默认值并告警 |
| `readOnlyTools` | 见 `src/index.ts` | 确认前允许调用的工具名白名单；未列出的工具一律拒绝。默认包含 `ask_user_question`、`job_list`、`job_output`、`schedule_list`、`terminal_list`、`terminal_read` |
| `cancelWords` | `取消`、`算了`、`不做了`、`cancel` | 整条消息精确匹配（忽略首尾空白、标点和大小写） |
| `confirmWords` | `继续`、`确认`、`开始`、`执行`、`可以`、`ok`、`continue`、`confirm`、`go` | 待确认与轮内转向都只认整条消息精确匹配的确认词 |
| `pendingTtlMs` | `7200000`（2 小时） | 待确认的有效期；`0` 表示不过期 |

新增 MCP 或其他自定义工具后若希望在调研阶段使用，需要把它们加入 `readOnlyTools`，否则会在确认前被拒绝。

## 设置页（Web）

Web 控制台的插件设置里有一张「任务确认」卡片，页面上半部分是实时状态，下半部分是配置：

- **实时状态**：列出当前 `pending` 与 `confirmed` 的顶层会话，显示会话标题、已等待时长和剩余 TTL；每行可以在页面上直接取消待确认或撤销当前轮的放行。没有活动会话时显示空状态。
- **刷新策略**：有会话在运行时每 4 秒刷新一次；空闲时每 60 秒检查一次。宿主的会话状态变化会立刻唤醒刷新，所以新任务不必等满一个周期。页面切到后台时停止请求，切回来时立刻刷新一次。卡片上会显示当前处于哪种节奏。
- **配置编辑**：`enabled`、`marker`、`pendingTtlMs`（页面上以分钟显示）、确认词、取消词与 `readOnlyTools`。词表和工具白名单用顿号、逗号或换行分隔。所有字段都是宿主的 volatile 配置。
- **保存即时生效**：插件读取 volatile 配置引用，并在 `loader/volatile-update` 时重建标记、词表、只读工具集与 TTL，不需要重启或重载插件；已有的待确认状态会保留。关闭 `enabled` 会清空内存状态，重新开启后从干净状态开始。
- **状态 API**：`GET /api/task-confirm/status` 与 `POST /api/task-confirm/cancel`，由宿主的 `connection` 服务注册在已鉴权的 `/api` 通道上，只接受本机 owner 浏览器的凭据。headless profile 没有 `connection` 服务，因此不会注册这两个路由，门禁本身不受影响。
- **标题来源**：状态里的会话标题来自插件运行期间观察到的 `session/title` 事件；插件刚启动时尚未收到标题的会话会退化为短会话 id。

## 作用域控制

- **子代理会话不受影响**：`session.header.origin === 'subagent'` 或 `delegationDepth > 0` 的会话直接放行，并且不会收到该协议提示——子代理没有人可以确认。
- **状态按会话 id 记录**：`agent.session.id` 优先，缺失时回退到 `agent.id`，与 `session/event` 的键保持一致。
- **轮次来源决定是否门禁**：一轮的来源由该轮首批进入 step 的消息分类（`role=user && source.kind=user` 为人类轮）；分类前默认按人类轮处理。只有带文本的人类消息能消费确认，附件-only 的人类消息仍然算人类轮。
- **信任边界**：无人值守豁免以宿主注入消息的 `source.kind` 为准。任何能以非 `user` 来源向顶层会话注入消息的插件，都能触发一次不受闸门约束的轮次；这与宿主自身的信任级别一致。

## 与其他插件的协作

`dsh-channel-wechat` 通过宿主服务名 `taskConfirm` 读取 `{ marker, phase(sessionId), cancel(sessionId) }`，用于 `/status` 显示「待确认」、`/stop` 取消待确认任务、`/new` 清理状态，以及在待确认时跳过会话闲置重置。两个包之间没有代码依赖：确认插件不存在时微信通道照常工作。

Web 设置页由本包自己的 `client.js` 提供，走宿主的 `configForms` 与 `plugins.item` 槽；状态数据走 `connection.fetch` 注册的 `/api` 路由。它同样不依赖微信通道，也不需要额外安装设置包。

注意 `phase()` 返回 `'pending'` 只代表「在等人确认」，闸门仍然是关的；返回 `'confirmed'` 才代表当前轮的工具已放行。无人值守轮次的放行不改变 `phase()`，因此不会伪装成人类确认。

## 安全说明

这个插件约束的是“模型会不会在没得到确认前动手”，不是隔离恶意代码的沙箱。工具白名单和确认门禁都在宿主进程内执行；能修改宿主配置或直接调用宿主 API 的代码不受它约束。

- 插件不发起外部网络请求，不上报任何数据。
- 设置页的状态/取消接口注册在宿主已鉴权的 `/api` 通道上，未登录请求返回 401。
- 状态只保存在内存中，不写磁盘；日志只记录短会话 id。

## 已知边界

- 确认状态只保存在宿主内存中，DSH 重启后清空，待确认的任务需要重新发起；保存设置不会清空，关闭任务确认会清空。
- 待确认期间只接受明确的确认词；给出修正不会直接执行，模型需要按修正重新给出任务理解，用户再确认。
- 无人值守轮次按轮次来源豁免；如果未来某种自动投递方式在该轮第一步没有投递任何消息，会保守地按人类轮处理（被闸门拦住），需要回来扩展识别。
- 设置页只在 Web profile 且宿主提供 `connection`、`configForms` 与 `plugins.item` 时出现；headless 部署没有这些界面，但门禁与 `taskConfirm` 服务照常工作。
- 状态面板里的会话标题只来自插件运行期间收到的 `session/title` 事件；更早的会话会显示短 id，直到宿主再次更新标题。
- 插件用自己的结构视图对接宿主事件，不做编译期契约校验。dsh 升级后需要重新核对：`Session.header` 的 `origin`/`delegationDepth`、`agent/pre-step` 的 messages/source、`assistant/message` 的 content 形状、`turn/end` 的 reason.kind、`session/title` 的 data.title，以及 `connection.fetch` 与客户端槽位的签名。
- 运行时除 `@deepseek-ai/schemastery`（配置 schema）外不加载任何宿主包；该 peer 版本为 `~3.18.5`，与宿主版本不一致时会各自解析一份。`client.js` 是手写的浏览器模块，不参与 `tsc` 类型检查，由测试里的 VM 装配检查兜底。

## 兼容性

针对 dsh 0.2.1-rc.2 开发与验证（Cordis 4.0.5、Schemastery 3.18.5）。插件通过宿主注入的服务和事件工作，不做编译期契约校验；升级 dsh 后建议重新执行 `pnpm typecheck && pnpm test`，并在 Web 端验收设置页。

## 开发验证

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

`lib/` 随仓库发布：改完 `src/` 后运行 `pnpm build` 并提交 `lib/`，CI 会检查 `lib/` 与 `src/` 是否一致。CI 还会执行泄露守卫（`sh scripts/git-hooks/pre-commit --all`），该脚本也可复制到 `.git/hooks/pre-commit` 作为提交前检查。

`typecheck` 同时覆盖 `src/` 与 `test/`。测试用假 ctx 装配插件（不是真实 Cordis 上下文），验证提示注入、工具拒绝、真人确认后放行、TTL 过期、状态快照、`/api` 状态/取消路由、volatile 配置热更新（标记/词表/白名单/启用开关）与子代理放行；另用 Node `vm` 加载 `client.js`，检查设置卡片的槽位注册与 API 路径。测试不调用模型，也不写入任何真实目录。`client.js` 是手写浏览器模块，改动后用 `node --check client.js` 做语法检查。

## 许可证

[MIT](LICENSE)
