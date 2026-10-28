@echo off
rem ======================================================================================================================
rem  Starts the local automation service. Keep this window open while you use the gallery; close it (or press Ctrl+C) to
rem  stop the service. On the first run it installs and builds whatever is missing.
rem
rem  Set NO_PAUSE=1 to skip the "press a key" prompt when the service ends.
rem ======================================================================================================================
setlocal EnableExtensions
set "SS3_SCRIPT_DIR=%~dp0"
pushd "%~dp0..\.." || ( echo Could not open the project folder. & goto :fail_nopush )
set "SS3_ROOT=%CD%"

echo.
echo  Screenshot Gallery - local service
echo  ----------------------------------

call "%SS3_SCRIPT_DIR%_common.bat" :check_node || goto :fail

rem  Install on first use, so double-clicking this file is enough.
if not exist "%SS3_ROOT%\service\node_modules" (
  echo  First start: installing the service ^(one time^)...
  call "%SS3_SCRIPT_DIR%install.bat" || goto :fail
)

rem  Rebuild when the compiled service is missing or older than the sources.
set "SS3_NEEDS_BUILD="
if not exist "%SS3_ROOT%\service\dist\index.js" set "SS3_NEEDS_BUILD=1"
if not defined SS3_NEEDS_BUILD (
  for /f "usebackq delims=" %%R in (`node "%SS3_ROOT%\scripts\needs-build.mjs" "%SS3_ROOT%\service" 2^>nul`) do set "SS3_NEEDS_BUILD=%%R"
)
if defined SS3_NEEDS_BUILD (
  echo  Building the service...
  pushd "%SS3_ROOT%\service" || goto :fail
  call npm run build
  if errorlevel 1 ( popd & echo  [!] The service could not be built. & goto :fail )
  popd
)

call "%SS3_SCRIPT_DIR%_common.bat" :ensure_env

echo.
pushd "%SS3_ROOT%\service" || goto :fail
call npm start
set "SS3_EXIT=%errorlevel%"
popd
rem  A stop from Ctrl+C or from stop-service.bat also ends with a non-zero code on Windows, so the code alone cannot say
rem  whether something went wrong. Describe what is known and point at the messages instead of claiming an error.
echo.
if "%SS3_EXIT%"=="0" (
  echo  The service has stopped.
) else (
  echo  The service has stopped ^(exit code %SS3_EXIT%^).
  echo  If you did not stop it yourself, the messages above say why.
)
goto :done

:fail
set "SS3_EXIT=1"
echo.
echo  The service did not start.
goto :done

:fail_nopush
set "SS3_EXIT=1"
goto :end

:done
popd

:end
call :maybe_pause
endlocal & exit /b %SS3_EXIT%

:maybe_pause
rem  Pause only when the window was opened by double-clicking (so the text can be read), never when scripted.
if defined NO_PAUSE exit /b 0
echo %CMDCMDLINE% | find /i "%~nx0" >nul 2>nul && ( echo. & pause )
exit /b 0
