param([string]$HelperPath = (Join-Path $PSScriptRoot 'Private-Dacl.ps1'))
$ErrorActionPreference='Stop'
. $HelperPath
$directory=Join-Path ([IO.Path]::GetTempPath()) ('ajtool-dacl-only-'+[Guid]::NewGuid().ToString('N'))
$file=Join-Path $directory 'fixture.txt'
$deniedFile=Join-Path $directory 'denied.txt'
$report=[ordered]@{powershell=$PSVersionTable.PSVersion.ToString();daclOnly=$false;ownerGroupPreserved=$false;currentUserReadWrite=$false;restrictedTokenDenied=$false;auditInInputNotApplied=$false;writeDacDeniedFailsClosed=$false;workflowStopsBeforePasswordAndDriver=$false;fixtureContentsPreserved=$false;credentialsUsed=$false}
$workflowRoot=Join-Path $directory 'workflow'
$workflowScripts=Join-Path $workflowRoot 'scripts'
$workflowPrivate=Join-Path $workflowRoot '.env.ajtool-supabase'
$workflowFile=Join-Path $workflowPrivate 'connection.env'
$sentinel=Join-Path $workflowScripts 'driver-started.txt'
try {
    [void][IO.Directory]::CreateDirectory($directory)
    [IO.File]::WriteAllText($file,'AJTool public synthetic ACL fixture')
    $before=New-Object Security.AccessControl.RawSecurityDescriptor([AJToolDaclOnly]::ReadAccessOwnerGroup($file),0)
    Protect-AJToolPrivatePath -LiteralPath $directory
    Protect-AJToolPrivatePath -LiteralPath $file
    $afterBytes=[AJToolDaclOnly]::ReadAccessOwnerGroup($file)
    $after=New-Object Security.AccessControl.RawSecurityDescriptor($afterBytes,0)
    if ($before.Owner.Value -ne $after.Owner.Value -or $before.Group.Value -ne $after.Group.Value) { throw 'Owner/group preservation failed' }
    $report.ownerGroupPreserved=$true
    if ([AJToolDaclOnly]::RestrictedPublicTokenCanReadWrite($afterBytes)) { throw 'Public restricted token allowed' }
    $report.restrictedTokenDenied=$true
    # Positive control: the same restricted token can access a deliberately public fixture DACL.
    $public=New-Object Security.AccessControl.FileSecurity
    $everyone=New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
    $public.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($everyone,'FullControl','Allow')))
    $user=[Security.Principal.WindowsIdentity]::GetCurrent().User
    $public.AddAuditRule((New-Object Security.AccessControl.FileSystemAuditRule($user,'ReadData','Success')))
    # Even though this input descriptor contains audit metadata, only its DACL is written.
    [AJToolDaclOnly]::WriteProtectedDacl($file,$public.GetSecurityDescriptorBinaryForm())
    if (![AJToolDaclOnly]::RestrictedPublicTokenCanReadWrite([AJToolDaclOnly]::ReadAccessOwnerGroup($file))) { throw 'AccessCheck positive control failed' }
    Protect-AJToolPrivatePath -LiteralPath $file
    $report.auditInInputNotApplied=$true
    [IO.File]::AppendAllText($file,' / write verified')
    if ([IO.File]::ReadAllText($file) -ne 'AJTool public synthetic ACL fixture / write verified') { throw 'Fixture content mismatch' }
    $report.currentUserReadWrite=$true;$report.fixtureContentsPreserved=$true
    [IO.File]::WriteAllText($deniedFile,'Public fixture used to test fail-closed WRITE_DAC denial')
    $denied=New-Object Security.AccessControl.FileSecurity
    $denied.SetAccessRuleProtection($true,$false)
    $ownerRights=New-Object Security.Principal.SecurityIdentifier('S-1-3-4')
    $denied.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($ownerRights,'ChangePermissions','Deny')))
    $denied.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($user,'FullControl','Allow')))
    [AJToolDaclOnly]::WriteProtectedDacl($deniedFile,$denied.GetSecurityDescriptorBinaryForm())
    $refused=$false
    try { Protect-AJToolPrivatePath -LiteralPath $deniedFile }
    catch {
        $errorObject=$_.Exception
        while ($errorObject.InnerException) { $errorObject=$errorObject.InnerException }
        $refused=($errorObject -is [ComponentModel.Win32Exception] -and $errorObject.NativeErrorCode -eq 5)
    }
    if (!$refused) { throw 'WRITE_DAC failure was not propagated' }
    [void][IO.Directory]::CreateDirectory($workflowScripts)
    [void][IO.Directory]::CreateDirectory($workflowPrivate)
    [IO.File]::WriteAllText($workflowFile,'# public fixture, not credentials')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Test-AJToolPostgresPassword.ps1') -Destination (Join-Path $workflowScripts 'Test-AJToolPostgresPassword.ps1')
    Copy-Item -LiteralPath $HelperPath -Destination (Join-Path $workflowScripts 'Private-Dacl.ps1')
    [IO.File]::WriteAllText((Join-Path $workflowScripts 'test-supabase-password.mjs'), "import {writeFileSync} from 'node:fs';writeFileSync(new URL('./driver-started.txt',import.meta.url),'driver should not start');")
    [AJToolDaclOnly]::WriteProtectedDacl($workflowFile,$denied.GetSecurityDescriptorBinaryForm())
    function Read-Host { throw 'PASSWORD_PROMPT_MUST_NOT_BE_REACHED' }
    $blockedBeforePrompt=$false
    try { & (Join-Path $workflowScripts 'Test-AJToolPostgresPassword.ps1') -Role Runtime -SavePrivate }
    catch {
        $errorObject=$_.Exception
        while ($errorObject.InnerException) { $errorObject=$errorObject.InnerException }
        $blockedBeforePrompt=($errorObject -is [ComponentModel.Win32Exception] -and $errorObject.NativeErrorCode -eq 5)
    }
    if (!$blockedBeforePrompt -or [IO.File]::Exists($sentinel)) { throw 'Credential workflow did not fail closed before prompt/driver' }
    $report.workflowStopsBeforePasswordAndDriver=$true
    $report.writeDacDeniedFailsClosed=$true;$report.daclOnly=$true
    $report.status='PRIVATE_DACL_ONLY_TEST_PASS'
    [pscustomobject]$report | ConvertTo-Json -Compress
} finally {
    foreach ($path in @($sentinel,$workflowFile,(Join-Path $workflowScripts 'Test-AJToolPostgresPassword.ps1'),(Join-Path $workflowScripts 'Private-Dacl.ps1'),(Join-Path $workflowScripts 'test-supabase-password.mjs'))) { if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) } }
    foreach ($path in @($workflowScripts,$workflowPrivate,$workflowRoot)) { if ([IO.Directory]::Exists($path)) { [IO.Directory]::Delete($path,$false) } }
    foreach ($path in @($deniedFile,$file)) { if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) } }
    if ([IO.Directory]::Exists($directory)) { [IO.Directory]::Delete($directory,$false) }
}
