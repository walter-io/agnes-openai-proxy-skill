' Agnes OpenAI proxy - silent auto-start on boot (no window)
' Portable: locates agnes-proxy-start.bat next to this file
' To remove auto-start: delete this file from the Startup folder
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
batPath = scriptDir & "\agnes-proxy-start.bat"
If Not fso.FileExists(batPath) Then
  MsgBox "Cannot find " & batPath, 16, "Agnes Proxy"
  WScript.Quit 1
End If
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = scriptDir
sh.Run """C:\Windows\System32\cmd.exe"" /c """ & batPath & """", 0, False
