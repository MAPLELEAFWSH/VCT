@echo off
chcp 65001 >nul
title 元素手帐 · 网页版（局域网）
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto NONODE

echo.
echo   元素手帐 · 网页版（局域网模式）
echo   ========================================
echo   服务会绑定到本机内网地址，同一个 WiFi / 同一个路由器下的
echo   手机、平板、其它电脑都能打开。
echo.
echo   · 启动后请看「元素手帐-局域网服务」窗口，里面会打印
echo     房间码 和 可分享的地址
echo   · 把地址发给别人即可；进茶室要填那个 6 位房间码
echo   · 第一次运行 Windows 防火墙会弹窗询问，
echo     要允许「专用网络」的访问，否则别的设备连不上
echo.
echo   注意：这个模式下同网段的人也能打开你的整站页面
echo   （这是「别人要能加载页面」的必然代价），
echo   在公共 WiFi 下请改用「启动网页版.bat」
echo.
start "元素手帐-局域网服务" cmd /k "chcp 65001 >nul && set MJ_HOST=0.0.0.0 && node server.js"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:5210/"
echo   已打开浏览器。房间码在「元素手帐-局域网服务」窗口里。
echo.
pause
exit /b

:NONODE
echo.
echo   没有检测到 Node.js，无法启动局域网服务。
echo   局域网聊天室需要 Node.js 作为服务端；
echo   只想像普通网页那样浏览，请用「启动网页版.bat」。
echo.
pause
