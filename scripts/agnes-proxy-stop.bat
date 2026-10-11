@echo off
rem Agnes OpenAI proxy - full stop (kills watchdog cmd + node process)
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*agnes-openai-proxy.mjs*') -or ($_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*agnes-proxy-start.bat*') } | ForEach-Object { Write-Host ('Stopping ' + $_.Name + ' PID ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force }"
echo Done.
