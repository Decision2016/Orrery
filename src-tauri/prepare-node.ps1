param([Parameter(Mandatory)][ValidateSet('x86_64', 'aarch64')][string]$Architecture)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Digests from the corresponding official Node release's SHASUMS256.txt.
$version = 'v24.22.3'
$arch, $zipHash, $exeHash = if ($Architecture -eq 'x86_64') {
    'x64', 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f', '86fc4785327db5f5c7558dc6156c543b433c313e813a222e088086222ab4afa6'
} else {
    'arm64', 'b3cc74a295b39d4f273271e96f58c06dd2b35757ca12abec64c7d0598b434f14', '172e320db179ce416fc012b96b9917dacfb442beb081de57c4deaed7b5a24644'
}
$runtime = Join-Path $PSScriptRoot 'target/orrery-runtime'
$exe = Join-Path $runtime 'node.exe'
$license = Join-Path $runtime 'LICENSE'
if ((Test-Path -LiteralPath $license) -and (Test-Path -LiteralPath $exe) -and
    (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -eq $exeHash) { return }

$package = "node-$version-win-$arch"
$archive = New-TemporaryFile
try {
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$version/$package.zip" -OutFile $archive.FullName
    if ((Get-FileHash -LiteralPath $archive.FullName -Algorithm SHA256).Hash -ne $zipHash) {
        throw "Checksum mismatch for $package.zip"
    }
    [void][IO.Directory]::CreateDirectory($runtime)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($archive.FullName)
    try {
        foreach ($name in 'node.exe', 'LICENSE') {
            [IO.Compression.ZipFileExtensions]::ExtractToFile($zip.GetEntry("$package/$name"), (Join-Path $runtime $name), $true)
        }
    } finally { $zip.Dispose() }
} finally { Remove-Item -LiteralPath $archive.FullName }
