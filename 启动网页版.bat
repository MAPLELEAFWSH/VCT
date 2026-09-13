@echo off
chcp 65001 >nul
title 元素手帐 · 网页版
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto NONODE

echo.
echo   元素手帐 · 网页版
echo   ========================================
echo   正在启动本地服务（包含局域网聊天室）
echo.
echo   · 浏览器会自动打开 http://127.0.0.1:5210/
echo   · 新开的那个「元素手帐-服务」窗口就是服务本体，
echo     关掉它网页就断了；要停服务直接关那个窗口
echo   · 只想自己看，用这个就够了
echo   · 想让同一 WiFi 的别人也能进聊天室，用
echo     「启动网页版(局域网).bat」
echo.
start "元素手帐-服务" cmd /k "chcp 65001 >nul && node server.js"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:5210/"
echo   已打开浏览器。
echo.
pause
exit /b

:NONODE
echo.
echo   没有检测到 Node.js —— 改为直接打开静态页面。
echo.
echo   直接打开（file://）时也能正常浏览，
echo   但聊天室会降级成「同一浏览器多标签」模式：
echo   再开一个标签页打开本页面，两边就能对上话。
echo   想跨设备聊天 / 想要房间码，请先安装 Node.js，
echo   然后重新运行本文件。
echo.
start "" "%~dp0index.html"
pause
