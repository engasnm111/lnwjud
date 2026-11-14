param([Parameter(Mandatory=$true)][string]$SlotDirectory, [Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
$slotRoot = [IO.Path]::GetFullPath($SlotDirectory).TrimEnd('\') + '\'
$manifest = [IO.File]::ReadAllText((Join-Path $slotRoot 'manifest.json')) | ConvertFrom-Json
$names = @($manifest.files | ForEach-Object { $_.path }) + @('manifest.json')
$output = [IO.File]::Open($OutputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
  $zip = [IO.Compression.ZipArchive]::new($output, [IO.Compression.ZipArchiveMode]::Create, $true)
  try {
    foreach ($name in $names) {
      if ($name -notmatch '^[\x20-\x7e]{1,240}$' -or $name.Contains('\') -or $name.Contains(':') -or $name.Split('/') -contains '..') { throw 'UPDATE_PAYLOAD_PATH_INVALID' }
      $filename = [IO.Path]::GetFullPath((Join-Path $slotRoot $name))
      if (-not $filename.StartsWith($slotRoot, [StringComparison]::OrdinalIgnoreCase) -or
          ([IO.File]::GetAttributes($filename) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'UPDATE_PAYLOAD_PATH_INVALID' }
      $sourceStream = [IO.File]::Open($filename, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
      try {
        $entry = $zip.CreateEntry($name, [IO.Compression.CompressionLevel]::Optimal)
        $entry.LastWriteTime = [DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
        $stream = $entry.Open()
        try { $sourceStream.CopyTo($stream) } finally { $stream.Dispose() }
      } finally { $sourceStream.Dispose() }
    }
  } finally { $zip.Dispose() }
} finally { $output.Dispose() }
