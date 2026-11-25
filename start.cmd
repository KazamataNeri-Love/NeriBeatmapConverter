@echo off
rem 双击即可启动（ES 模块必须经 http 加载，不能直接双击 index.html）
cd /d "%~dp0"
where node >nul 2>nul || (echo 需要先安装 Node.js：https://nodejs.org/ & pause & exit /b 1)
echo 启动中... 浏览器打开 http://localhost:5173/
start "" http://localhost:5173/
node tools\serve.js
pause
