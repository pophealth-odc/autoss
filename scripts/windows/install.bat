@echo off
rem ======================================================================================================================
rem  Installs everything the local service needs: checks Node.js and Microsoft Edge, installs the packages, builds the
rem  service, and creates service\.env. Safe to run again at any time.
rem
rem  Double-click it, or run it from any folder. Set NO_PAUSE=1 to skip the "press a key" prompt at the end.
rem ======================================================================================================================
setlocal EnableExtensions
set "SS3_SCRIPT_DIR=%~dp0"
pushd "%~dp0..\.." || ( echo Could not open the project folder. & goto :fail_nopush )
set "SS3_ROOT=%CD%"

echo.
echo  Screenshot Gallery - installing the local service
echo  -------------------------------------------------

call "%SS3_SCRIPT_DIR%_common.bat" :check_node || goto :fail
call "%SS3_SCRIPT_DIR%_common.bat" :check_edge
if errorlevel 1 echo      (Installation continues; the service will tell you again if Edge is still missing.)

echo.
echo  Installing packages for the service (this can take a minute)...
pushd "%SS3_ROOT%\service" || goto :fail
if exist package-lock.json (
  call npm ci --no-audit --no-fund
) else (
  call npm install --no-audit --no-fund
)
if errorlevel 1 ( popd & echo  [!] npm could not install the service packages. & goto :fail )

echo.
echo  Building the service...
call npm run build
if errorlevel 1 ( popd & echo  [!] The service could not be built. & goto :fail )
popd

call "%SS3_SCRIPT_DIR%_common.bat" :ensure_env

echo.
echo  Done. Start the service with  scripts\windows\start-service.bat
goto :ok

:fail
echo.
echo  Installation did not finish. Fix the problem above and run install.bat again.
popd
endlocal & set "SS3_EXIT=1"
goto :end

:fail_nopush
endlocal & set "SS3_EXIT=1"
goto :end

:ok
popd
endlocal & set "SS3_EXIT=0"

:end
call :maybe_pause
exit /b %SS3_EXIT%

:maybe_pause
rem  Pause only when the window was opened by double-clicking (so the text can be read), never when scripted.
if defined NO_PAUSE exit /b 0
echo %CMDCMDLINE% | find /i "%~nx0" >nul 2>nul && ( echo. & pause )
exit /b 0
