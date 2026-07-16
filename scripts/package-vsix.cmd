@echo off
pushd "%~dp0.."
if errorlevel 1 exit /b 1
node "%APPDATA%\npm\node_modules\@vscode\vsce\vsce" package
set "exitCode=%ERRORLEVEL%"
popd
exit /b %exitCode%
