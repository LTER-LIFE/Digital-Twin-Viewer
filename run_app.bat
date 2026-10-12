@echo off
title Digital Twin Viewer - server
cd /d "%~dp0"
rem install processing dependencies on first run (viewer itself needs none)
python -c "import importlib.util,sys; sys.exit(any(importlib.util.find_spec(m) is None for m in ('numpy','scipy','netCDF4','PIL')))" 2>nul
if errorlevel 1 (
  echo Installing Python dependencies for .nc processing ...
  python -m pip install -r requirements.txt
)
echo Starting Digital Twin Viewer on http://localhost:8501 ...
python server.py
