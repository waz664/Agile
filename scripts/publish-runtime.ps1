param(
    [string]$StackName = "xleo-agile-workspace-dev",
    [string]$FunctionName = "",
    [string]$Region = "us-east-1"
)

$ErrorActionPreference = "Stop"

function Import-CompatibleAwsModule {
    param(
        [string]$ModuleName,
        [string]$PreferredRoot = (Join-Path ${env:ProgramFiles} "WindowsPowerShell\Modules")
    )

    $module = Get-Module -ListAvailable $ModuleName |
        Where-Object { $_.Path -like ($PreferredRoot + "*") } |
        Sort-Object Version -Descending |
        Select-Object -First 1

    if (-not $module) {
        $module = Get-Module -ListAvailable $ModuleName |
            Sort-Object Version -Descending |
            Select-Object -First 1
    }

    if (-not $module) {
        throw ("Required PowerShell module not found: " + $ModuleName)
    }

    Import-Module $module.Path -Force -ErrorAction Stop
}

Import-CompatibleAwsModule -ModuleName "AWS.Tools.Common"
Import-CompatibleAwsModule -ModuleName "AWS.Tools.CloudFormation"
Import-CompatibleAwsModule -ModuleName "AWS.Tools.Lambda"
Import-CompatibleAwsModule -ModuleName "AWS.Tools.SecurityToken"
Add-Type -AssemblyName System.IO.Compression.FileSystem

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$caller = Get-STSCallerIdentity -Region $Region

if ([string]::IsNullOrWhiteSpace($FunctionName)) {
    $stack = Get-CFNStack -StackName $StackName -Region $Region | Select-Object -First 1
    $FunctionName = ($stack.Outputs | Where-Object { $_.OutputKey -eq "RuntimeFunctionName" }).OutputValue
}

if ([string]::IsNullOrWhiteSpace($FunctionName)) {
    throw "Could not resolve the Lambda function name."
}

$stageDir = Join-Path $env:TEMP ("xleo-agile-runtime-" + [guid]::NewGuid().ToString("N"))
$zipPath = Join-Path $env:TEMP ("xleo-agile-runtime-" + [guid]::NewGuid().ToString("N") + ".zip")

try {
    New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
    Copy-Item -Path (Join-Path $repoRoot "index.py") -Destination $stageDir
    Copy-Item -Path (Join-Path $repoRoot "xleo_agile_workspace") -Destination $stageDir -Recurse

    $portalAssetStage = Join-Path $stageDir "xleo_agile_workspace\portal_assets"
    New-Item -ItemType Directory -Force -Path $portalAssetStage | Out-Null
    Copy-Item -Path (Join-Path $repoRoot "ui\workspace-admin\index.html") -Destination (Join-Path $portalAssetStage "index.html")
    Copy-Item -Path (Join-Path $repoRoot "ui\workspace-admin\app.js") -Destination (Join-Path $portalAssetStage "app.js")
    Copy-Item -Path (Join-Path $repoRoot "ui\workspace-admin\styles.css") -Destination (Join-Path $portalAssetStage "styles.css")

    if (Test-Path $zipPath) {
        Remove-Item -LiteralPath $zipPath -Force
    }

    [System.IO.Compression.ZipFile]::CreateFromDirectory($stageDir, $zipPath)

    Write-Output ("Using AWS account: " + $caller.Account)
    Write-Output ("Publishing Lambda code to: " + $FunctionName)
    Write-Output ("Package: " + $zipPath)

    Update-LMFunctionCode `
        -FunctionName $FunctionName `
        -ZipFilename $zipPath `
        -Region $Region `
        -Force | Out-Null

    Write-Output "Lambda code update submitted successfully."
}
finally {
    if (Test-Path $stageDir) {
        Remove-Item -LiteralPath $stageDir -Recurse -Force
    }
    if (Test-Path $zipPath) {
        Remove-Item -LiteralPath $zipPath -Force
    }
}
