---
description: "可定制侧栏与首页 Hero 品牌雕塑徽标、点击浮出的像素鲸鱼以及设置中的「关于与品牌」引擎归属页。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-official

[English](README.md) | 中文

## 概述

本包内置四套品牌预设（默认为 `reins`／`执辔 Reins`，并包含 `loom`／`灵枢 Loom`、`lumen`／`澄明 Lumen` 与 `deepseek`），在各构建模式下统一接管侧栏与空白会话 Hero 品牌槽位（隐藏本地构建版本号胶囊），在设置中注册展示定制版版本号与上游 DSH 内核归属的「关于与品牌」分区，并在空白首页提供点击浮出的像素鲸鱼。随产品提供的 Web 与 Desktop 组合默认加载本包。背景只持有临时 Canvas 资源，不增加模型请求。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

随产品提供的 Web 与 Desktop 组合已挂载本插件。它在所有构建 profile 下统一占据 `sidebar.brand.mark`、`sidebar.brand.name`、`conversation.hero.brand.mark`、`conversation.hero.brand.headline` 与 `settings.section`（`id: 'about'`），并提供 `conversation.hero.frame` 背景。

### 选择 profile

用户可在设置（「关于与品牌」分区）中切换四套内置品牌预设（默认为 `reins`／`执辔 Reins`，可选 `loom`／`灵枢 Loom`、`lumen`／`澄明 Lumen` 与 `deepseek`）、四种字标格式（`bilingual`、`zh`、`en` 与 `custom`）以及三种首页欢迎词模式（`brand` 注解、`time` 时段问候与 `custom`），由 `dsh-client-ui-theme` 持久化配置承接。当 `preset` 为 `deepseek`、`labelMode` 非 `custom` 且 `DSH_CLIENT_BUILD_PROFILE` 为 `official` 时，侧栏名称使用官方矢量字标；其余场景渲染无本地构建版本号胶囊的品牌字标。上游 DSH 内核版本与提交号归属统一收纳于「关于与品牌」分区，配以 DeepSeek 鲸鱼徽标与一键复制版本信息按钮。

### 首页反馈

默认首页保持留白，主按钮点击空白处才播放一次浅灰色鲸鱼跃起。每次播放结束后的点击在点阵与代码填充之间交替，首次为点阵；两种填充使用相同的大幅动态轮廓。动画持续 5.7 秒，随后清空。连续点击不会打断当前播放。点击由鲸鱼的 frame 层自己判定：外框内部的留白可触发播放，包括输入卡片两侧的空白；输入框、控件、输入卡片、portal 出去的浮层以及结束文字选择的点击都不触发。Canvas 不获取焦点或指针事件，点击由外框接收。窄屏首页中的鲸鱼保留较大比例，在 Canvas 边缘裁切，不增加横向滚动。减少动态效果偏好会禁用它，离开空白首页时释放动画与观察器。

鲸鱼使用非常浅的主题中性色，呈现轻微的背景隐纹；代码文字的对比度略高于点阵。水花保留细小颗粒并使用较深的颜色，尤其是入水时左侧的水花。随包帧图提供动作，首次符合条件的点击时由浏览器经插件 asset 路由加载一次。代码填充使用密排的 7px 文字，内容只来自预设的代码标语，出水与入水时文本随动态轮廓裁切。解码或像素读取失败时停止装饰，首页仍可正常使用，并在日志中提示重新加载。

图形参数固定，本行不接受配置。这是内置呈现，没有需要单独安装的 Bundle 或插件页面开关。

### 替换品牌

内置品牌预设、自定义字标与自定义首页欢迎词可直接通过 `ui-theme` 设置项配置，无需替换本包。若部署需要四套内置雕塑之外的专属 SVG 组件，可移除本包并组合另一个占据侧栏、Hero 与设置 slot 的包。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

侧栏两个填充作为一组声明感知的注册安装：嵌套的 `ctx.slots.inject()` 调用等待侧栏声明，因此无论本行在声明者之前还是之后激活，这组注册都能工作；声明消失时两个填充一并撤回，HMR 期间也不会留下残缺的品牌混合。独立的 `ctx.slots.inject()` 调用分别注册 `HeroBrandMark`、`HeroBrandHeadline` 与 `AboutBrandSection`，均通过 `ctx.theme` 订阅响应式的 `ThemeSnapshot.brand` 状态。独立的 `conversation.hero.frame` 层持有 Canvas 绘制器，通过 `ctx.slots.inject()` 等待声明；`hero` 为 true 时它以负 `z-index` 绘制 Canvas，按 frame 层约定画在 Conversation 背景之上、所有 Conversation 内容之下。它在点击落到自身外框、且不在控件和输入卡片上时播放；portal 浮层的点击以及结束外框内文字选择的点击会被忽略。它不更改输入框或会话状态。浏览器半部是 [`src/client/index.ts`](src/client/index.ts)；node 半部是空的 Loader 席位。[帧图](src/client/assets/breach-atlas.webp) 来自用户提供的[展示视频](https://yinghuo-hg.deepseek.com/wuyexinrui/dev-cpu/web-showcase/orca.mp4)：截取 1.5–7.2 秒，以每秒 24 帧采样为 192 × 108 个单元，以无损 WebP 存储。红色与绿色通道以 32 级分别编码圆点半径和不透明度；绘制器在首次符合条件的点击后读取一次。除非构建时显式注入 `DSH_CLIENT_TITLE`，否则 `ui-layout` 会将文档标题同步为 `ThemeSnapshot.brand.title`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当品牌面不够用时阅读以下页面。它们从本包占据的 slot 进入渲染这些 slot 的外壳。

- [ui-sidebar](../ui-sidebar/README.zh.md)——声明 `sidebar.brand.mark` 与 `sidebar.brand.name` 并渲染其回退。
- [ui-conversation](../ui-conversation/README.zh.md)——在首屏声明 `conversation.hero.brand.mark`，以及本包占用的 `conversation.hero.frame` 层。
- [Web 客户端架构](../../../docs/subsystems/web-client.zh.md)——浏览器插件行如何加载并注册 slot。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包只贡献浏览器呈现；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了品牌呈现的供给方式。它们是当前包约束，不是品牌设计对比或任务积压。

- **只有一组填充**——四套内置预设之外的自定义 SVG 徽标属于占据相同 slot 的另一个 Cordis 包。
- **装饰绘制需要 Canvas 2D**——上下文不可用或偏好减少动态效果时，首页保持留白。
- **构建标题覆盖优先**——构建时若设置了 `DSH_CLIENT_TITLE`，其在 `document.title` 上优先于动态品牌标题。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
