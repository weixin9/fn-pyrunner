# Python 编辑器 (pyrunner)

飞牛 fnOS 三方应用 —— Python 脚本编辑器，支持语法高亮、保存和运行。

## 功能

- 在文件管理器中双击或右键 `.py` 文件，用本应用打开
- CodeMirror 语法高亮、行号、Tab 缩进
- 保存文件（Ctrl+S），运行前自动保存
- 运行 Python 脚本（F5 或点击运行），实时查看 stdout/stderr
- **环境设置**：选择 Python 解释器、创建/选择 venv 虚拟环境
- **pip 管理**：默认清华镜像源，安装和查看 pip 包
- 自动适配飞牛系统深色/浅色主题

## 项目结构

```
pyrunner/
├── manifest              # 应用元数据
├── ICON.PNG / ICON_256.PNG
├── cmd/main              # 启停脚本
├── config/
│   ├── privilege         # 运行权限
│   └── resource
├── app/
│   ├── server/server.py  # 后端 HTTP 服务（Unix Socket）
│   ├── www/              # 前端静态资源
│   └── ui/
│       ├── config        # 桌面入口 & 文件关联
│       └── images/       # 应用图标
└── scripts/generate_icons.py
```

## 打包与安装

### 1. 在飞牛 NAS 上打包

将项目上传到 NAS，进入 `pyrunner` 目录：

```bash
fnpack build
```

生成 `pyrunner.fpk` 文件。

### 2. 安装

**方式 A：应用中心手动安装**

应用中心左下角 → 手动安装 → 选择 `pyrunner.fpk`

**方式 B：命令行安装**

```bash
appcenter-cli install-fpk pyrunner.fpk
```

**方式 C：开发调试（免打包）**

```bash
cd /path/to/pyrunner
appcenter-cli install-local
```

### 3. 使用

1. 安装并启动应用
2. 打开飞牛**文件管理器**
3. 找到 `.py` 文件，**双击**或**右键 → 打开方式 → Python 编辑器**
4. 编辑代码，点击**运行**或按 F5 执行

### 环境设置

1. 点击顶部 **⚙ 环境** 按钮打开设置面板
2. **解释器** 标签：选择 Python 版本，配置 pip 镜像源（默认清华源）
3. **虚拟环境** 标签：点击「创建 .venv」在当前脚本目录创建虚拟环境
4. **pip 包** 标签：输入包名安装依赖，查看已安装包列表
5. 顶部环境徽章显示当前运行环境（venv 或 system）

## 日志

```bash
cat /var/apps/pyrunner/var/info.log
appcenter-cli status pyrunner
```

## 依赖

- 系统自带 `python3`（飞牛 fnOS 默认已安装）
- 无需额外 pip 依赖

## 注意事项

- 应用以 root 权限运行，以便读写用户文件（与官方文本编辑器等文件类应用一致）
- 仅支持 `.py` 文件
- 单文件最大 10MB
- 脚本运行超时 300 秒
