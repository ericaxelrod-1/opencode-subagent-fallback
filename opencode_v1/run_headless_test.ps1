$proc = Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", "C:\Users\axelr\.npm-global\opencode.cmd", "run", "--agent", "developer", "--auto", "In 2 sentences, explain the high-level purpose of the opencode-subagent-fallback plugin.") -PassThru -NoNewWindow -RedirectStandardOutput "test_output.txt" -RedirectStandardError "test_err.txt"
$procId = $proc.Id
$startTime = $proc.StartTime
Write-Host "Started PID $procId at $startTime"

$finished = $proc.WaitForExit(90000)
if (-not $finished) {
    Write-Host "Process $procId timed out after 90s - checking PID $procId before stopping..."
    $check = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($check -and $check.StartTime -eq $startTime) {
        Write-Host "Confirmed exact PID and start time matches. Stopping PID $procId"
        Stop-Process -Id $procId -Force
    } else {
        Write-Host "PID $procId did not match expected start time or was already stopped."
    }
} else {
    Write-Host "Finished: $finished ExitCode: $($proc.ExitCode)"
}

Write-Host "=== Output ==="
if (Test-Path "test_output.txt") {
    Get-Content "test_output.txt"
    Remove-Item "test_output.txt" -Force
}

Write-Host "=== Errors ==="
if (Test-Path "test_err.txt") {
    Get-Content "test_err.txt"
    Remove-Item "test_err.txt" -Force
}
