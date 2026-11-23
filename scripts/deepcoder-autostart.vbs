' DeepCoder autostart runner.
'
' Starts the bridge without any window. It is used by the Windows scheduled
' task that runs at system boot and by the Startup folder entry that runs at
' every sign-in. Both call this script, so both start the bridge the same way.
'
' The bridge itself never needs the provider key: the harness sends the
' Authorization header with every request and the bridge forwards it. The key
' therefore stays in the environment of the harness, not in this script.

Option Explicit
Dim shell, fso, packageDir, configFile, scriptFile, nodePath, command

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

packageDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
configFile = fso.BuildPath(fso.BuildPath(packageDir, "config"), "deepcoder-config.json")
scriptFile = fso.BuildPath(packageDir, "deepcoder.cjs")

If Not fso.FileExists(scriptFile) Then
  WScript.Quit 1
End If

' The configuration path is handed to the bridge through the environment, so
' the bridge reads the file that belongs to this copy of the package.
If fso.FileExists(configFile) Then
  shell.Environment("Process")("DEEPCODER_CONFIG") = configFile
End If

' Prefer the node that runs this script, fall back to the one on PATH.
nodePath = ""
If Not IsEmpty(WScript.Arguments) Then
  If WScript.Arguments.Count > 0 Then
    nodePath = WScript.Arguments(0)
  End If
End If
If nodePath = "" Then
  nodePath = "node"
End If

command = Chr(34) & nodePath & Chr(34) & " " & Chr(34) & scriptFile & Chr(34) & " --autostart"

' 0 = hidden window, False = do not wait for the bridge to finish.
On Error Resume Next
shell.Run command, 0, False
If Err.Number <> 0 Then
  WScript.Quit 1
End If
On Error GoTo 0
