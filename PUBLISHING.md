# 传到 GitHub

仓库：https://github.com/heyikai060215-jpg/dsh-wechat-wake （空仓库，默认分支 `main`）

这个目录是干净的仓库结构：没有 `node_modules`、没有 `.venv`、没有 `wechat-wake.json` 这类运行时状态。

## 方式一：网页拖拽（不用装 git）

1. 解压 `dsh-wechat-wake-0.1.0.zip`；
2. 打开仓库 → **Add file → Upload files**；
3. 把 `dsh-wechat-wake` 文件夹里的**内容**（不是文件夹本身）全选拖进去；
   - Windows 默认不显示 `.gitignore`，先在「查看 → 显示 → 隐藏的项目」里打开，否则会漏掉它；
4. Commit message 写 `feat: 微信里的定时唤醒`，提交。

## 方式二：Git 命令

```powershell
cd D:\dsh-mod\github-ready\dsh-wechat-wake
git init
git add .
git commit -m "feat: 微信里的定时唤醒"
git branch -M main
git remote add origin https://github.com/heyikai060215-jpg/dsh-wechat-wake.git
git push -u origin main
```

首次 push 会弹 GitHub 登录（或要 PAT 当密码）；本机目前没装 git，需要先装。

## 方式三：给 agent 一个 token，让它用 API 推

生成 fine-grained token（仅这一个仓库，权限 `Contents: Read and write`），交给 agent，它就能把文件逐个提交上去，不用手动拖。

## 上传前检查

- 不要提交 `wechat-wake.json`（里面是待触发列表、聊天键、本机路径）
- 不要提交 `node_modules/`、`.venv/`、日志和 `*.zip`
- `README.md` 里出现的聊天号 / wxid 都是占位写法，不要换成真实值
- 改过本机 `config/wechatagent.json` 的授权，那属于本机私有配置，不进仓库

## 提交后建议顺手做的

- 仓库 **About** 右侧加 topics：`deepseek-harness` `dsh-plugin` `wechat` `reminder` `agent`
- 描述直接用：给微信里的 agent 一组自己的定时工具：到点它自己醒过来说话，说的话直接落进当前微信聊天。
- 发版打个 `v0.1.0` tag，以后 `dsh plugin add github:...` 能指定版本
