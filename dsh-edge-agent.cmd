@echo off
rem dsh-edge-agent: launch dsh-edge-agent through the official dsh CLI profile boot.
rem Equivalent to: dsh --profile dsh-edge-agent ^<args^>
rem   --resume: read ~/.dsh-edge-agent/resume.txt (legacy ~/.dsh-cc/resume.txt as
rem             fallback) and feed it to the agent as DSH_EDGE_RESUME_SESSION.
rem Prereq: dsh CLI on PATH (npm install -g @deepseek-ai/dsh). The profile
rem         is created by `dsh plugin --profile dsh-edge-agent add @deepseek-harness-edge-agent/dsh-edge-agent`
rem         under $DSH_HOME/profiles/dsh-edge-agent (default ~/.dsh), so this
rem         launcher must NOT pin DSH_HOME.
rem
rem WORKSPACE: 工作目录（默认当前目录；可用 DSH_EDGE_WORKSPACE 环境变量覆盖）。
setlocal
set "WORKSPACE=%DSH_EDGE_WORKSPACE%"
if "%WORKSPACE%"=="" set "WORKSPACE=%CD%"
cd /d "%WORKSPACE%"

where dsh >nul 2>nul
if errorlevel 1 (
  echo [dsh-edge-agent] 未找到 dsh CLI。请先安装：npm install -g @deepseek-ai/dsh 1>&2
  exit /b 1
)

set "ARGS="
:parse
if "%~1"=="" goto :run
if /i "%~1"=="--resume" (
  if exist "%USERPROFILE%\.dsh-edge-agent\resume.txt" (
    set /p DSH_EDGE_RESUME_SESSION=<"%USERPROFILE%\.dsh-edge-agent\resume.txt"
  ) else if exist "%USERPROFILE%\.dsh-cc\resume.txt" (
    set /p DSH_EDGE_RESUME_SESSION=<"%USERPROFILE%\.dsh-cc\resume.txt"
  )
) else (
  set "ARGS=%ARGS% "%~1""
)
shift
goto :parse

:run
@dsh --profile dsh-edge-agent %ARGS%
endlocal