@echo off
rem ======================================================================================================================
rem  Runs the web page on THIS computer (http://127.0.0.1:5173 or the next free port) together with the service.
rem
rem  Use this when you cannot use the page hosted on GitHub Pages, for example because your browser or a company policy
rem  blocks websites from reaching programs on your computer. A page served from this computer needs no such permission.
rem
rem  It opens two windows: one for the service and one for the web page. Close both windows to stop.
rem ======================================================================================================================
setlocal EnableExtensions
set "SS3_SCRIPT_DIR=%~dp0"
pushd "%~dp0..\.." || ( echo Could not open the project folder. & goto :fail_nopush )
set "SS3_ROOT=%CD%"

echo.
echo  Screenshot Gallery - local development
echo  --------------------------------------

call "%SS3_SCRIPT_DIR%_common.bat" :check_node || goto :fail

if not exist "%SS3_ROOT%\service\node_modules" (
  call "%SS3_SCRIPT_DIR%install.bat" || goto :fail
)
if not exist "%SS3_ROOT%\frontend\node_modules" (
  echo  Installing the web page packages ^(one time^)...
  pushd "%SS3_ROOT%\frontend" || goto :fail
  if exist package-lock.json ( call npm ci --no-audit --no-fund ) else ( call npm install --no-audit --no-fund )
  if errorlevel 1 ( popd & echo  [!] npm could not install the web page packages. & goto :fail )
  popd
)

echo.
echo  Starting the service in its own window...
start "Screenshot Gallery - service" /D "%SS3_ROOT%" cmd /c ""%SS3_SCRIPT_DIR%start-service.bat""

echo  Starting the web page...
echo.
echo  When the address appears below, open it in Microsoft Edge, then pair with the token shown in the service window.
echo.
pushd "%SS3_ROOT%\frontend" || goto :fail
call npm run dev
set "SS3_EXIT=%errorlevel%"
popd
goto :done

:fail
set "SS3_EXIT=1"
echo.
echo  Could not start.
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
if defined NO_PAUSE exit /b 0
echo %CMDCMDLINE% | find /i "%~nx0" >nul 2>nul && ( echo. & pause )
exit /b 0
