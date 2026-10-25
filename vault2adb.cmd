@echo off
rem ---------------------------------------------------------------------------
rem  Obsidian vault (.zip or folder)  ->  build\book.adb
rem
rem  One click: drag the vault .zip (or folder) onto this file, or run
rem      vault2adb.cmd "D:\path\to\vault.zip" [name]
rem
rem  The optional second argument is the database name written in the adb header
rem  (ASCII only; it is also the default base name). Output:
rem      build\book.adb          the database to open with accelon26
rem      build\book-xml\         the intermediate XML + images (for inspection)
rem ---------------------------------------------------------------------------
setlocal
if "%~1"=="" (
  echo Usage: drag a vault .zip or folder onto this file,
  echo        or:  vault2adb.cmd "D:\path\to\vault.zip" [dbname]
  echo.
  pause
  exit /b 2
)

set "NAME=%~2"
if "%NAME%"=="" set "NAME=book"

cd /d "%~dp0ts"
if not exist "bun.exe" (
  where bun >nul 2>nul
  if errorlevel 1 (
    echo [x] bun not found on PATH ^(install: https://bun.sh^)
    pause
    exit /b 2
  )
)

echo [1/2] building ..\build\%NAME%.adb from %~1
bun run tools/md2adb.ts "%~1" -o "..\build\%NAME%.adb" --name "%NAME%" --xml "..\build\%NAME%-xml"
if errorlevel 1 (
  echo [x] build failed
  pause
  exit /b 1
)

echo [2/2] done: %~dp0build\%NAME%.adb
echo     open it with accelon26.exe ^(it lists *.adb in its own folder^)
echo     or drag it onto build\accelon26.html
echo.
pause
