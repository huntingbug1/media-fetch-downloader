Set WshShell = CreateObject("WScript.Shell")
' Run setup.bat hidden (0 = hide window, false = don't wait for execution to end)
WshShell.Run chr(34) & WshShell.CurrentDirectory & "\setup.bat" & chr(34), 0, false
