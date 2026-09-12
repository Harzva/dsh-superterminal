<p align="center">
  <img src="https://raw.githubusercontent.com/Harzva/dsh-superterminal/main/site/assets/logo.svg" width="88" height="88" alt="DSH SuperTerminal" />
</p>

<h1 align="center">DSH SuperTerminal</h1>

<p align="center"><strong>用自然语言执行任务，让 Side Terminal 成为对话旁的工作台。</strong></p>

<p align="center">在 DSH 对话旁执行 AI 任务，邀请不同终端一起讨论，把结论交给合适的智能体。</p>

<p align="center">
  <a href="https://harzva.github.io/dsh-superterminal/">官网交互导览</a> ·
  <a href="#安装">安装</a> ·
  <a href="#让不同终端一起讨论">终端讨论组</a> ·
  <a href="https://github.com/Harzva/dsh-superterminal/blob/main/docs/guide.zh-CN.md">使用指南</a> ·
  <a href="https://github.com/Harzva/dsh-superterminal/releases">更新记录</a>
</p>

![DSH SuperTerminal alpha.13 浅色工作台](https://raw.githubusercontent.com/Harzva/dsh-superterminal/main/site/assets/screenshots/light-workspace.jpg)

**alpha.13 浅色外观。** 通过 **更多 → 外观** 选择浅色、深色或跟随系统，切换时保留运行中的任务、输出和草稿。

## 安装

当前版本 **0.1.0-alpha.13**，默认使用浅色外观，并改进 SSH 连接的就绪确认。在同一个工作台选择执行主机，断线后接回原任务。支持 **macOS · Node.js 24+ · 官方 DSH 0.1.1-rc.2**。

```sh
dsh plugin --profile web add https://github.com/Harzva/dsh-superterminal/releases/download/v0.1.0-alpha.13/harzva-dsh-terminal-0.1.0-alpha.13.tgz
```

首次运行：

1. 重启所选 DSH 配置（上述命令为 `web`），在输入栏点击 **终端**，或输入 **/terminal**。
2. 在来源对话中选择可用的 DSH 模型，第一次发送 AI 任务时会沿用它。任务按来源工作区权限执行；本插件不附带模型或额度。
3. 点击 **＋ 终端**，写下第一个任务；通过 **更多 → 智能体管理** 打开本机 CLI。

目前仍为 Alpha，暂不支持 Windows、其他 DSH 版本或 Harvis 接管。远程终端暂不支持 DSH AI 的文件操作与自动参会；可直接使用远端 Agent CLI。DSH Supervisor 的终端状态适配尚未包含在公开 Supervisor 0.2.4 中。

## 从一句话，到实际结果

输入「检查这个项目，修复失败的测试」，DSH 会调用当前配置允许的工具，读取文件、修改代码、执行命令并展示结果。你可以继续追问、在执行中追加要求，或停止任务。

每个终端有自己的上下文和草稿。模型、权限、工具步骤都能看见；选区由你决定是否附上，任务不会自动送回主对话。工作台支持自由分屏，拖动调整大小、放大或收起，最多 12 个窗格。同一服务最多同时执行 2 个 AI 任务；停止 AI 会话保留记录和 Shell。重启 DSH 会结束本机终端；远端任务不提供跨 DSH 重启的恢复保证。

<details>
<summary><strong>查看截图：完整的 AI 执行过程</strong></summary>

查看工具步骤与返回结果，继续追问、追加要求或停止。

**alpha.8 实测用例：** 在独立示例项目中修复购物车合计，`35 → 80`，相关 **2 项测试通过**。以下截图记录当时的真实任务。

![AI 任务中的文件检查、编辑与测试步骤](https://raw.githubusercontent.com/Harzva/dsh-superterminal/main/site/assets/screenshots/ai-task.jpg)

</details>

<details>
<summary><strong>查看截图：对话旁的 Side Terminal</strong></summary>

绑定当前对话，或留在独立工作台。收起侧栏，任务继续。

![DSH SuperTerminal alpha.13 浅色 Side Terminal](https://raw.githubusercontent.com/Harzva/dsh-superterminal/main/site/assets/screenshots/light-side-terminal.jpg)

</details>

## 同一个工作台，连接远端终端

在空窗格选择 **SSH 远程**，选择已有 SSH 主机、填写远端绝对目录（`~` 表示远端主目录），点击 **检查连接**。检查成功后，可启动 Shell 或远端实际检测到的 Agent CLI。运行中的窗格始终显示执行主机与目录。

使用本机已有的 SSH 配置和认证，远端需要安装 **tmux**。首次使用前，应已通过系统 SSH 完成主机身份确认，并能免交互登录。当前来源 DSH 会话需为 **Full access**；本插件不会自动更改权限。

**收起**保留任务；SSH 中断后点击 **重新连接** 接回原进程，不重新执行任务；**结束任务**会停止这个远端任务。远端 CLI 使用远端账号和模型配置，“已检测到”不代表登录、模型或额度已就绪。

首版支持远端原生 Shell / Agent CLI 和显式选区的解释建议。DSH AI 执行、自动交接、Terminal Group 仍限本机；不会把远端目标交给本机文件工具。已在 macOS 和 Linux 远端实机验证连接、终端尺寸调整、断线重连与任务清理。远端模型执行与额度未包含在这次验收中，跨 DSH 重启续接仍不提供保证。详见[远程终端指南](https://github.com/Harzva/dsh-superterminal/blob/main/docs/guide.zh-CN.md#连接远端终端)。

## 让不同终端，一起讨论

**Terminal Group** 把同一工作台中的终端组成讨论组，保留各自的窗口、进程与布局。

![alpha.9 实际界面：DSH AI 与 Pi 参会，讨论结论交给 Agent 执行](https://raw.githubusercontent.com/Harzva/dsh-superterminal/main/site/assets/screenshots/terminal-group.jpg)

1. 拖动终端标题到讨论组，或点击 **新建讨论组** 选择成员；每组最多 6 个终端。
2. 写下问题，指定本次发言的成员。**1 轮**收集各自意见；**2 轮**让成员参考上一轮回复继续讨论。
3. 选择一位成员 **形成结论**。结论注明作者，整理共识、分歧与待办；它不代表所有成员已经同意。
4. 点击 **将结论交给 Agent 执行**，确认执行者与验收标准。结果返回后可验收，或携带原目标和结果安排返工。

| 参会方式 | 实际使用的会话 |
| --- | --- |
| 终端 DSH AI | 沿用这个终端已有的 DSH AI 会话与模型，保留它自己的上下文。 |
| Pi / piagent、Codex | 每次发言启动独立 CLI 任务，不继承终端里已经打开的 CLI 对话。 |
| Kimi Code 等其他 CLI | 保留原生终端交互，暂不支持自动 CLI 参会。可以明确选择该终端的 DSH AI，回复按 DSH AI 身份署名。 |

加入组不会自动广播旧终端日志；你可以预览并附上选中的内容。停止讨论会保留已完成的发言；重启后未完成的讨论显示中断，不会自动重跑。讨论组沿用 DSH 的会话、本地记录和现有 Agent 交接能力，无需额外运行群聊或消息中转服务。

## 熟悉的智能体，在同一个工作台

通过 **更多 → 智能体管理** 打开本机 Shell、Codex、Claude Code、Kimi Code、Pi 等工具，保留各自的原生界面。目录显示可识别的版本与使用状态。下图为 alpha.8 的实际目录；当前版本会随所选外观显示。

![alpha.8 实际界面：本机智能体目录与使用状态](https://raw.githubusercontent.com/Harzva/dsh-superterminal/main/site/assets/screenshots/agents.jpg)

需要搭档时，可把任务交给 **Pi / piagent 或 Codex** 在后台执行，收到结果后验收或要求返工。当前受管后台交接支持这两类 Agent；其他 CLI 可在原生终端中交互使用。

Codex、Claude Code、Kimi 和 Pi 使用当前工作区的独立配置。即使你已在其他终端登录，在这里首次使用仍可能需要重新登录或配置模型。

目录分别显示安装、登录和上次任务的模型连接证据；无法确认的状态显示「未知」。本机已安装不代表已有登录或可用额度，套餐与额度以各服务提供的信息为准。

完整操作、恢复方式、协作范围与隐私说明见 **[中文使用指南](https://github.com/Harzva/dsh-superterminal/blob/main/docs/guide.zh-CN.md)**。

---

[反馈问题](https://github.com/Harzva/dsh-superterminal/issues) · [MIT 许可](https://github.com/Harzva/dsh-superterminal/blob/main/LICENSE) · [第三方声明](https://github.com/Harzva/dsh-superterminal/blob/main/THIRD_PARTY_NOTICES.txt)

终端显示基于 [xterm.js](https://github.com/xtermjs/xterm.js)。设计参考与组件来源见[使用指南](https://github.com/Harzva/dsh-superterminal/blob/main/docs/guide.zh-CN.md#开源与许可)。
