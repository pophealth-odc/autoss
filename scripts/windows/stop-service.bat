@echo off
rem ======================================================================================================================
rem  Stops the local automation service if it is running in the background or in a window you cannot reach.
rem  It ends ONLY the Node.js process that runs THIS project's service (dist\index.js or src\index.ts), and nothing else.
rem  Normally you do not need it: closing the service window or pressing Ctrl+C stops the service cleanly.
rem ======================================================================================================================
setlocal EnableExtensions
pushd "%~dp0..\.." || ( echo Could not open the project folder. & exit /b 1 )
set "SS3_ROOT=%CD%"

where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js was not found, so there is nothing to stop.
  popd
  endlocal & exit /b 0
)

node "%SS3_ROOT%\scripts\stop-service.mjs" "%SS3_ROOT%\service"
set "SS3_EXIT=%errorlevel%"
popd
if defined NO_PAUSE goto :out
echo %CMDCMDLINE% | find /i "%~nx0" >nul 2>nul && ( echo. & pause )
:out
endlocal & exit /b %SS3_EXIT%
