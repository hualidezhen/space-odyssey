@echo off
chcp 65001 >nul
title 深空方舟 · DEEP SPACE ARK
cd /d "%~dp0"
echo.
echo   DEEP SPACE ARK  /  深空方舟
echo   ---------------------------------------------
echo   正在启动本地服务器  http://127.0.0.1:5183/
echo   关闭本窗口即可结束。
echo.
start "" /min cmd /c "node tools\serve.mjs 5183"
timeout /t 2 >nul
start "" "http://127.0.0.1:5183/"
exit
