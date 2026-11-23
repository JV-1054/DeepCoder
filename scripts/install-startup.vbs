Option Explicit
' Installs the DeepCoder sign-in entry: a small script in the Windows Startup
' folder that starts the bridge without a window at every sign-in.
'
' The boot task (system start, no sign-in needed) is installed separately by
'   node deepcoder.cjs --install-startup-task
' which needs administrator rights.

Dim shell, fso, folder, packageDir, runner, command, output

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

If WScript.Arguments.Count <> 1 Then
  WScript.Echo "Run setup.cmd to install Windows autostart."
  WScript.Quit 1
End If

folder = shell.SpecialFolders("Startup")
If folder = "" Then
  WScript.Echo "The current user's Windows Startup folder is unavailable."
  WScript.Quit 1
End If

packageDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
runner = fso.BuildPath(fso.BuildPath(packageDir, "scripts"), "deepcoder-autostart.vbs")
If Not fso.FileExists(runner) Then
  WScript.Echo "The autostart runner is missing: " & runner
  WScript.Quit 1
End If

command = "wscript.exe " & Chr(34) & runner & Chr(34) & " " & Chr(34) & WScript.Arguments(0) & Chr(34)

On Error Resume Next
Set output = fso.CreateTextFile(fso.BuildPath(folder, "deepcoder.vbs"), True, True)
output.WriteLine "Set shell = CreateObject(""WScript.Shell"")"
output.WriteLine "shell.Run " & Quote(command) & ", 0, False"
output.Close
If Err.Number <> 0 Then
  WScript.Echo "Unable to install autostart. Check write access to your Windows Startup folder."
  WScript.Quit 1
End If
On Error GoTo 0
WScript.Echo "Windows sign-in autostart installed for the current user."

Function Quote(value)
  Quote = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
