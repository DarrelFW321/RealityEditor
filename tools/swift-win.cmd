@echo off
REM Swift-on-Windows build environment for SpatialCore.
REM
REM Swift needs three things that are NOT set in a plain shell:
REM   1. the MSVC environment (vcvars64) for the linker and C runtime libs
REM   2. SDKROOT pointing at the Swift Windows platform SDK, or swiftc cannot
REM      find the standard library for x86_64-unknown-windows-msvc
REM   3. the toolchain and runtime bin dirs on PATH
REM
REM Usage, from anywhere:
REM     tools\swift-win.cmd swift build
REM     tools\swift-win.cmd swift test
REM
REM Versions are discovered rather than hardcoded so a toolchain update does not
REM silently leave this pointing at a directory that no longer exists.

setlocal

set "SWIFT_ROOT=%LOCALAPPDATA%\Programs\Swift"
if not exist "%SWIFT_ROOT%" (
  echo [swift-win] Swift not found at "%SWIFT_ROOT%".
  echo [swift-win] Install it with:  winget install Swift.Toolchain
  exit /b 1
)

REM --- MSVC environment -------------------------------------------------------
set "VCVARS="
for %%P in (
  "%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools"
  "%ProgramFiles(x86)%\Microsoft Visual Studio\2022\Community"
  "%ProgramFiles%\Microsoft Visual Studio\2022\BuildTools"
  "%ProgramFiles%\Microsoft Visual Studio\2022\Community"
) do (
  if not defined VCVARS if exist "%%~P\VC\Tools\MSVC" (
    if exist "%%~P\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=%%~P\VC\Auxiliary\Build\vcvars64.bat"
  )
)

if not defined VCVARS (
  echo [swift-win] MSVC toolset not found. Swift on Windows links with MSVC.
  echo [swift-win] Install it with:
  echo     winget install Microsoft.VisualStudio.2022.BuildTools --override ^
"--quiet --wait --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64"
  exit /b 1
)

call "%VCVARS%" >nul 2>&1
if errorlevel 1 (
  echo [swift-win] vcvars64 failed: "%VCVARS%"
  exit /b 1
)

REM --- Swift toolchain / platform SDK -----------------------------------------
for /f "delims=" %%V in ('dir /b /ad /o-n "%SWIFT_ROOT%\Toolchains" 2^>nul') do (
  if not defined SWIFT_TC set "SWIFT_TC=%%V"
)
for /f "delims=" %%V in ('dir /b /ad /o-n "%SWIFT_ROOT%\Platforms" 2^>nul') do (
  if not defined SWIFT_PLAT set "SWIFT_PLAT=%%V"
)

if not defined SWIFT_TC (
  echo [swift-win] no toolchain under "%SWIFT_ROOT%\Toolchains".
  exit /b 1
)

set "SDKROOT=%SWIFT_ROOT%\Platforms\%SWIFT_PLAT%\Windows.platform\Developer\SDKs\Windows.sdk"
set "PATH=%SWIFT_ROOT%\Toolchains\%SWIFT_TC%\usr\bin;%SWIFT_ROOT%\Runtimes\%SWIFT_PLAT%\usr\bin;%PATH%"

if not exist "%SDKROOT%" (
  echo [swift-win] platform SDK missing at "%SDKROOT%"
  exit /b 1
)

cd /d "%~dp0..\ios\SpatialCore"

if "%~1"=="" (
  echo [swift-win] toolchain %SWIFT_TC%, platform %SWIFT_PLAT%
  echo [swift-win] SDKROOT=%SDKROOT%
  echo [swift-win] usage: tools\swift-win.cmd swift build ^| swift test
  exit /b 0
)

%*
