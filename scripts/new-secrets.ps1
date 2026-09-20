$ErrorActionPreference = "Stop"

function New-PocketEnvySecret {
    $Bytes = New-Object byte[] 48
    $Generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $Generator.GetBytes($Bytes)
    }
    finally {
        $Generator.Dispose()
    }
    return [Convert]::ToBase64String($Bytes)
}

Write-Host "Copy each value into Vercel. Do not commit this output." -ForegroundColor Yellow
Write-Host "JWT_SECRET=$(New-PocketEnvySecret)"
Write-Host "LICENSE_KEY_PEPPER=$(New-PocketEnvySecret)"
Write-Host "ZAPIER_WEBHOOK_SECRET=$(New-PocketEnvySecret)"
Write-Host "CRON_SECRET=$(New-PocketEnvySecret)"
Write-Host "ADMIN_SECRET=$(New-PocketEnvySecret)"
