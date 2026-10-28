@echo off
rem ----------------------------------------------------------------------------------------------------------------------
rem  Shared helpers for the other scripts. Not meant to be run by itself.
rem  Usage from another script:   call "%~dp0_common.bat" :check_node
rem ----------------------------------------------------------------------------------------------------------------------
if "%~1"=="" (
  echo This file is used by the other scripts and is not run directly.
  exit /b 1
)
call %*
exit /b %errorlevel%

rem ----------------------------------------------------------------------------------------------------------------------
:check_node
rem  Makes sure Node.js is installed and recent enough (the minimum is read from service\package.json "engines").
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [!] Node.js was not found.
  echo      Install the LTS version from https://nodejs.org/en/download and run this script again.
  echo      If you just installed it, close this window and open a new one.
  exit /b 1
)
set "SS3_NODE_OK="
for /f "usebackq delims=" %%R in (`node "%SS3_ROOT%\scripts\check-node-version.mjs" "%SS3_ROOT%\service\package.json" 2^>^&1`) do set "SS3_NODE_OK=%%R"
if not defined SS3_NODE_OK (
  echo  [!] Could not check the Node.js version.
  exit /b 1
)
if /i not "%SS3_NODE_OK:~0,2%"=="OK" (
  echo.
  echo  [!] %SS3_NODE_OK%
  echo      Install a current Node.js LTS from https://nodejs.org/en/download and run this script again.
  exit /b 1
)
echo  Node.js: %SS3_NODE_OK:~3%
exit /b 0

rem ----------------------------------------------------------------------------------------------------------------------
:check_edge
rem  Prints where Microsoft Edge was found. Not fatal: the service reports a missing Edge itself, but the message here is
rem  the first the person sees.
node "%SS3_ROOT%\scripts\find-edge.mjs" 2>nul
if errorlevel 1 (
  echo  [!] Microsoft Edge was not found in its usual places.
  echo      Install it from https://www.microsoft.com/edge, or set EDGE_PATH in service\.env.
  exit /b 1
)
exit /b 0

rem ----------------------------------------------------------------------------------------------------------------------
:ensure_env
rem  Creates service\.env from the example the first time.
if not exist "%SS3_ROOT%\service\.env" (
  if exist "%SS3_ROOT%\service\.env.example" (
    copy /y "%SS3_ROOT%\service\.env.example" "%SS3_ROOT%\service\.env" >nul
    echo  Created service\.env from the example. Open it to set ALLOWED_ORIGINS for your GitHub Pages address.
  )
)
exit /b 0
