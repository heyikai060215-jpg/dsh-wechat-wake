# 维护与发布

仓库：https://github.com/heyikai060215-jpg/dsh-wechat-wake

本机工作目录：`D:\dsh-mod\dsh-wechat-wake`（已经 `git init` 过，`origin` 指向上面的仓库，`main` 分支）
本机 git：`D:\tools\git\cmd\git.exe`（MinGit 2.56，已加入用户 PATH）

## 日常改完怎么发

```powershell
cd D:\dsh-mod\dsh-wechat-wake
git add -A
git commit -m "fix: ……"          # 中文提交信息请写到文件里再用 -F，避免 PowerShell 编码把中文变乱码
git push
```

中文提交信息的安全写法（PowerShell 直接传 `-m` 会按 GBK 编码，推到 GitHub 上就是乱码）：

```powershell
[System.IO.File]::WriteAllText("$env:TEMP\msg.txt", "fix: 修掉某个问题", (New-Object System.Text.UTF8Encoding($false)))
git commit -F "$env:TEMP\msg.txt"
```

## 发版

```powershell
git tag -a v0.1.1 -m "v0.1.1"
git push origin v0.1.1
```

打完 tag 之后，别人可以这样钉版本安装：

```sh
dsh plugin --profile web add github:heyikai060215-jpg/dsh-wechat-wake#v0.1.1
```

## 提交前检查

- 不要提交 `wechat-wake.json`（待触发列表、聊天键、本机路径）——`.gitignore` 已经挡住
- 不要提交 `node_modules/`、`.venv/`、日志、`*.zip`
- `README.md` / `tools/selftest.mjs` 里的聊天号和 wxid 保持占位写法
- 本机 `config/wechatagent.json` 里的授权属于私有配置，不进仓库

## 关于凭据

这台机器的 Windows 凭据管理器里已经存了 `git:https://github.com`（用户 `heyikai060215-jpg`），git 走的是 `credential.helper = manager`，所以 `push` 不用每次输密码。换机器时要重新登录一次。
