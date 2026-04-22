param(
    [string]$StackName = "xleo-agile-workspace-dev",
    [string]$Region = "us-east-1",
    [string]$ProjectName = "xleo-agile-workspace",
    [string]$EnvironmentName = "dev",
    [string]$UserPoolId = "us-east-1_YyfseW56k",
    [string]$UserPoolClientName = "xleo-agile-workspace",
    [string]$AllowedEmails = "brianw@xleo.com",
    [string]$SuperAdminEmails = "brianw@xleo.com",
    [string]$PortalTitle = "XLEO Agile Workspace",
    [string]$PortalSubtitle = "AWS-hosted agile planning for projects, stories, and acceptance criteria.",
    [string]$CustomDomainName = "",
    [string]$HostedZoneId = "",
    [string]$PortalCertificateArn = "",
    [string]$BrandingSourceClientId = "50ig64fnjgfp3op76gl38vugl5",
    [switch]$ValidateOnly
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
Import-CompatibleAwsModule -ModuleName "AWS.Tools.CognitoIdentityProvider"
Import-CompatibleAwsModule -ModuleName "AWS.Tools.CertificateManager"
Import-CompatibleAwsModule -ModuleName "AWS.Tools.Route53"
Import-CompatibleAwsModule -ModuleName "AWS.Tools.SecurityToken"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$templatePath = (Resolve-Path (Join-Path $repoRoot "infra\cloudformation\application.yaml")).Path
$publishRuntimeScript = (Resolve-Path (Join-Path $repoRoot "scripts\publish-runtime.ps1")).Path
$caller = Get-STSCallerIdentity -Region $Region

Write-Output ("Using AWS account: " + $caller.Account)
Write-Output ("Using caller ARN: " + $caller.Arn)
Write-Output ("Using region: " + $Region)
Write-Output ("Application template: " + $templatePath)

if ($ValidateOnly) {
    Test-CFNTemplate -Region $Region -TemplateBody (Get-Content -Path $templatePath -Raw) | Out-Null
    Write-Output "CloudFormation template validation succeeded."
    exit 0
}

function New-StackParameter {
    param(
        [string]$Key,
        [string]$Value
    )

    return (New-Object Amazon.CloudFormation.Model.Parameter -Property @{
        ParameterKey = $Key
        ParameterValue = $Value
    })
}

function Wait-ForStack {
    param(
        [string]$TargetStackName,
        [string]$TargetRegion
    )

    while ($true) {
        Start-Sleep -Seconds 10
        $stack = Get-CFNStack -StackName $TargetStackName -Region $TargetRegion | Select-Object -First 1
        $status = $stack.StackStatus.Value
        Write-Output ("Current stack status for " + $TargetStackName + ": " + $status)

        if ($status -in @("CREATE_COMPLETE", "UPDATE_COMPLETE")) {
            return $stack
        }

        if ($status -match "FAILED" -or $status -match "ROLLBACK" -or $status -eq "DELETE_COMPLETE") {
            throw ("Stack operation failed with status " + $status)
        }
    }
}

function Wait-ForStackDeletion {
    param(
        [string]$TargetStackName,
        [string]$TargetRegion
    )

    while ($true) {
        Start-Sleep -Seconds 10
        try {
            $stack = Get-CFNStack -StackName $TargetStackName -Region $TargetRegion | Select-Object -First 1
            $status = $stack.StackStatus.Value
            Write-Output ("Current stack status for " + $TargetStackName + ": " + $status)
            if ($status -eq "DELETE_COMPLETE") {
                return
            }
        }
        catch {
            return
        }
    }
}

function Update-StackFromTemplate {
    param(
        [string]$TargetStackName,
        [string]$TargetTemplatePath,
        [System.Collections.IEnumerable]$Parameters,
        [System.Collections.IEnumerable]$Tags,
        [string[]]$Capabilities = @()
    )

    $templateBody = Get-Content -Path $TargetTemplatePath -Raw
    $stackExists = $false

    try {
        $existingStack = Get-CFNStack -StackName $TargetStackName -Region $Region | Select-Object -First 1
        $stackExists = $true
    }
    catch {
        $stackExists = $false
    }

    if ($stackExists -and $existingStack.StackStatus.Value -eq "ROLLBACK_COMPLETE") {
        Write-Output ("Deleting failed stack " + $TargetStackName + " before retrying")
        Remove-CFNStack -StackName $TargetStackName -Region $Region -Force | Out-Null
        Wait-ForStackDeletion -TargetStackName $TargetStackName -TargetRegion $Region
        $stackExists = $false
    }

    if ($stackExists) {
        Write-Output ("Updating stack " + $TargetStackName)
        try {
            $updateArgs = @{
                StackName = $TargetStackName
                Region = $Region
                TemplateBody = $templateBody
                Parameter = $Parameters
                Tag = $Tags
                Force = $true
            }
            if ($Capabilities.Count -gt 0) {
                $updateArgs["Capability"] = $Capabilities
            }
            Update-CFNStack @updateArgs | Out-Null
        }
        catch {
            if ($_.Exception.Message -match "No updates are to be performed") {
                Write-Output ("No stack changes were required for " + $TargetStackName)
                return (Get-CFNStack -StackName $TargetStackName -Region $Region | Select-Object -First 1)
            }
            throw
        }
    }
    else {
        Write-Output ("Creating stack " + $TargetStackName)
        $createArgs = @{
            StackName = $TargetStackName
            Region = $Region
            TemplateBody = $templateBody
            Parameter = $Parameters
            Tag = $Tags
            Force = $true
        }
        if ($Capabilities.Count -gt 0) {
            $createArgs["Capability"] = $Capabilities
        }
        New-CFNStack @createArgs | Out-Null
    }

    return Wait-ForStack -TargetStackName $TargetStackName -TargetRegion $Region
}

function Resolve-StackOutput {
    param(
        $Stack,
        [string]$OutputKey
    )

    return ($Stack.Outputs | Where-Object { $_.OutputKey -eq $OutputKey } | Select-Object -First 1).OutputValue
}

function Resolve-ExistingCertificateArn {
    param(
        [string]$DomainName
    )

    if ([string]::IsNullOrWhiteSpace($DomainName)) {
        return ""
    }

    $matches = @(Get-ACMCertificateList -Region $Region | Where-Object {
        $_.DomainName -eq $DomainName -and $_.Status -eq "ISSUED"
    })

    if (-not $matches.Count) {
        return ""
    }

    return ($matches | Sort-Object CertificateArn -Descending | Select-Object -First 1).CertificateArn
}

function Upsert-Route53AliasRecord {
    param(
        [string]$ZoneId,
        [string]$RecordName,
        [string]$RecordType,
        [string]$AliasDnsName,
        [string]$AliasHostedZoneId
    )

    $change = New-Object Amazon.Route53.Model.Change
    $change.Action = "UPSERT"
    $change.ResourceRecordSet = New-Object Amazon.Route53.Model.ResourceRecordSet
    $change.ResourceRecordSet.Name = $RecordName
    $change.ResourceRecordSet.Type = $RecordType
    $change.ResourceRecordSet.AliasTarget = New-Object Amazon.Route53.Model.AliasTarget
    $change.ResourceRecordSet.AliasTarget.HostedZoneId = $AliasHostedZoneId
    $change.ResourceRecordSet.AliasTarget.DNSName = $AliasDnsName
    $change.ResourceRecordSet.AliasTarget.EvaluateTargetHealth = $false

    Edit-R53ResourceRecordSet `
        -HostedZoneId $ZoneId `
        -ChangeBatch_Comment ("Codex managed alias for " + $RecordName) `
        -ChangeBatch_Change @($change) `
        -Force | Out-Null
}

function Get-SupportedIdentityProviders {
    param(
        [string]$TargetUserPoolId
    )

    $providers = @("COGNITO")
    $configuredProviders = @(Get-CGIPIdentityProviderList -UserPoolId $TargetUserPoolId -Region $Region | ForEach-Object {
        if ($_.ProviderName) { [string]$_.ProviderName }
    })

    foreach ($provider in $configuredProviders) {
        if ($provider -and -not $providers.Contains($provider)) {
            $providers += $provider
        }
    }

    return ,$providers
}

function Set-PortalAppClient {
    param(
        [string]$TargetUserPoolId,
        [string]$ClientName,
        [string[]]$SupportedProviders,
        [string[]]$CallbackUrls,
        [string[]]$LogoutUrls
    )

    $listedClient = Get-CGIPUserPoolClientList -UserPoolId $TargetUserPoolId -Region $Region |
        Where-Object { $_.ClientName -eq $ClientName } |
        Select-Object -First 1

    if (-not $listedClient) {
        Write-Output ("Creating Cognito app client " + $ClientName)
        New-CGIPUserPoolClient `
            -UserPoolId $TargetUserPoolId `
            -ClientName $ClientName `
            -GenerateSecret $false `
            -AllowedOAuthFlowsUserPoolClient $true `
            -AllowedOAuthFlow @("code") `
            -AllowedOAuthScope @("openid", "email", "profile") `
            -CallbackURLs $CallbackUrls `
            -LogoutURLs $LogoutUrls `
            -DefaultRedirectURI $CallbackUrls[0] `
            -EnableTokenRevocation $true `
            -ExplicitAuthFlow @("ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_SRP_AUTH", "ALLOW_USER_AUTH") `
            -SupportedIdentityProvider $SupportedProviders `
            -Region $Region `
            -Force | Out-Null

        $listedClient = Get-CGIPUserPoolClientList -UserPoolId $TargetUserPoolId -Region $Region |
            Where-Object { $_.ClientName -eq $ClientName } |
            Select-Object -First 1
    }

    Update-CGIPUserPoolClient `
        -UserPoolId $TargetUserPoolId `
        -ClientId $listedClient.ClientId `
        -ClientName $ClientName `
        -AllowedOAuthFlowsUserPoolClient $true `
        -AllowedOAuthFlow @("code") `
        -AllowedOAuthScope @("openid", "email", "profile") `
        -CallbackURLs $CallbackUrls `
        -LogoutURLs $LogoutUrls `
        -DefaultRedirectURI $CallbackUrls[0] `
        -EnableTokenRevocation $true `
        -ExplicitAuthFlow @("ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_SRP_AUTH", "ALLOW_USER_AUTH") `
        -SupportedIdentityProvider $SupportedProviders `
        -Region $Region `
        -Force | Out-Null

    return Get-CGIPUserPoolClient `
        -UserPoolId $TargetUserPoolId `
        -ClientId $listedClient.ClientId `
        -Region $Region
}

function Ensure-PortalManagedLoginBranding {
    param(
        [string]$TargetUserPoolId,
        [string]$TargetClientId,
        [string]$SourceClientId
    )

    try {
        $existing = Get-CGIPManagedLoginBrandingByClient `
            -UserPoolId $TargetUserPoolId `
            -ClientId $TargetClientId `
            -Region $Region
        if ($existing.ManagedLoginBrandingId) {
            Write-Output ("Managed login branding already exists for client " + $TargetClientId)
            return $existing
        }
    }
    catch {
        if ($_.Exception.Message -notmatch "does not exist") {
            throw
        }
    }

    Write-Output ("Cloning managed login branding from client " + $SourceClientId + " to " + $TargetClientId)
    $sourceBranding = Get-CGIPManagedLoginBrandingByClient `
        -UserPoolId $TargetUserPoolId `
        -ClientId $SourceClientId `
        -Region $Region

    foreach ($asset in $sourceBranding.Assets) {
        if ($asset.Bytes -and $asset.Bytes.CanSeek) {
            $asset.Bytes.Position = 0
        }
    }

    New-CGIPManagedLoginBranding `
        -UserPoolId $TargetUserPoolId `
        -ClientId $TargetClientId `
        -Asset $sourceBranding.Assets `
        -Setting $sourceBranding.Settings `
        -UseCognitoProvidedValue:$sourceBranding.UseCognitoProvidedValues `
        -Region $Region `
        -Force | Out-Null

    return Get-CGIPManagedLoginBrandingByClient `
        -UserPoolId $TargetUserPoolId `
        -ClientId $TargetClientId `
        -Region $Region
}

if ([string]::IsNullOrWhiteSpace($PortalCertificateArn) -and -not [string]::IsNullOrWhiteSpace($CustomDomainName)) {
    $PortalCertificateArn = Resolve-ExistingCertificateArn -DomainName $CustomDomainName
    if (-not [string]::IsNullOrWhiteSpace($PortalCertificateArn)) {
        Write-Output ("Reusing issued ACM certificate: " + $PortalCertificateArn)
    }
}

$userPool = Get-CGIPUserPool -UserPoolId $UserPoolId -Region $Region
if ([string]::IsNullOrWhiteSpace($userPool.Domain)) {
    throw "The selected Cognito user pool does not have a hosted UI domain configured."
}

$passwordPolicy = $userPool.Policies.PasswordPolicy
$supportedProviders = Get-SupportedIdentityProviders -TargetUserPoolId $UserPoolId
$externalProviders = $supportedProviders | Where-Object { $_ -ne "COGNITO" }

if (-not $externalProviders.Count) {
    Write-Output "No external social identity providers are configured in the shared user pool yet. The workspace will launch with Cognito sign-in only."
}

Write-Output ("Current shared pool password minimum length: " + $passwordPolicy.MinimumLength)
Write-Output ("Current shared pool complexity flags: upper=" + $passwordPolicy.RequireUppercase + ", lower=" + $passwordPolicy.RequireLowercase + ", number=" + $passwordPolicy.RequireNumbers + ", symbol=" + $passwordPolicy.RequireSymbols)

$placeholderCallback = @("https://example.invalid/auth/callback")
$placeholderLogout = @("https://example.invalid/")
$portalClient = Set-PortalAppClient `
    -TargetUserPoolId $UserPoolId `
    -ClientName $UserPoolClientName `
    -SupportedProviders $supportedProviders `
    -CallbackUrls $placeholderCallback `
    -LogoutUrls $placeholderLogout

Ensure-PortalManagedLoginBranding `
    -TargetUserPoolId $UserPoolId `
    -TargetClientId $portalClient.ClientId `
    -SourceClientId $BrandingSourceClientId | Out-Null

$cognitoDomain = $userPool.Domain + ".auth." + $Region + ".amazoncognito.com"
$tags = @(
    (New-Object Amazon.CloudFormation.Model.Tag -Property @{ Key = "Project"; Value = $ProjectName }),
    (New-Object Amazon.CloudFormation.Model.Tag -Property @{ Key = "Environment"; Value = $EnvironmentName }),
    (New-Object Amazon.CloudFormation.Model.Tag -Property @{ Key = "ManagedBy"; Value = "Codex" })
)

$parameters = @(
    (New-StackParameter -Key "ProjectName" -Value $ProjectName),
    (New-StackParameter -Key "EnvironmentName" -Value $EnvironmentName),
    (New-StackParameter -Key "PortalAllowedEmails" -Value $AllowedEmails),
    (New-StackParameter -Key "PortalSuperAdminEmails" -Value $SuperAdminEmails),
    (New-StackParameter -Key "PortalTitle" -Value $PortalTitle),
    (New-StackParameter -Key "PortalSubtitle" -Value $PortalSubtitle),
    (New-StackParameter -Key "PortalUserPoolId" -Value $UserPoolId),
    (New-StackParameter -Key "PortalUserPoolClientId" -Value $portalClient.ClientId),
    (New-StackParameter -Key "PortalCognitoDomain" -Value $cognitoDomain),
    (New-StackParameter -Key "CustomDomainName" -Value $CustomDomainName),
    (New-StackParameter -Key "HostedZoneId" -Value $HostedZoneId),
    (New-StackParameter -Key "PortalCertificateArn" -Value $PortalCertificateArn),
    (New-StackParameter -Key "ManageCustomDomainRecords" -Value "false")
)

$stack = Update-StackFromTemplate `
    -TargetStackName $StackName `
    -TargetTemplatePath $templatePath `
    -Parameters $parameters `
    -Tags $tags `
    -Capabilities @("CAPABILITY_NAMED_IAM")

$portalUrl = Resolve-StackOutput -Stack $stack -OutputKey "HostedPortalUrl"
$regionalDomainName = Resolve-StackOutput -Stack $stack -OutputKey "PortalCustomDomainRegionalDomainName"
$regionalHostedZoneId = Resolve-StackOutput -Stack $stack -OutputKey "PortalCustomDomainRegionalHostedZoneId"
$functionName = Resolve-StackOutput -Stack $stack -OutputKey "RuntimeFunctionName"

if (
    -not [string]::IsNullOrWhiteSpace($CustomDomainName) `
    -and -not [string]::IsNullOrWhiteSpace($HostedZoneId) `
    -and -not [string]::IsNullOrWhiteSpace($regionalDomainName) `
    -and -not [string]::IsNullOrWhiteSpace($regionalHostedZoneId)
) {
    Write-Output ("Upserting Route 53 alias records for " + $CustomDomainName)
    Upsert-Route53AliasRecord `
        -ZoneId $HostedZoneId `
        -RecordName $CustomDomainName `
        -RecordType "A" `
        -AliasDnsName $regionalDomainName `
        -AliasHostedZoneId $regionalHostedZoneId
    Upsert-Route53AliasRecord `
        -ZoneId $HostedZoneId `
        -RecordName $CustomDomainName `
        -RecordType "AAAA" `
        -AliasDnsName $regionalDomainName `
        -AliasHostedZoneId $regionalHostedZoneId
}

[string[]]$callbackUrl = @($portalUrl.TrimEnd("/") + "/auth/callback")
[string[]]$logoutUrl = @($portalUrl.TrimEnd("/") + "/")
$portalClient = Set-PortalAppClient `
    -TargetUserPoolId $UserPoolId `
    -ClientName $UserPoolClientName `
    -SupportedProviders $supportedProviders `
    -CallbackUrls $callbackUrl `
    -LogoutUrls $logoutUrl

Ensure-PortalManagedLoginBranding `
    -TargetUserPoolId $UserPoolId `
    -TargetClientId $portalClient.ClientId `
    -SourceClientId $BrandingSourceClientId | Out-Null

Write-Output ("Publishing latest runtime to " + $functionName)
& $publishRuntimeScript -StackName $StackName -FunctionName $functionName -Region $Region

Write-Output ""
Write-Output ("Hosted portal URL: " + $portalUrl)
Write-Output ("Cognito app client: " + $portalClient.ClientId)
Write-Output ("User pool domain: https://" + $cognitoDomain)
Write-Output ("Allowed portal emails: " + $AllowedEmails)
Write-Output ("Super admin emails: " + $SuperAdminEmails)
