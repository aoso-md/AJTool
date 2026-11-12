# Existing pg driver; no installation and no password on command line/history/env.
[CmdletBinding()]
param([switch]$CheckOnly, [switch]$SelfTest,
    [ValidateSet('Migrator','Runtime')][string]$Role = 'Migrator',
    [switch]$SavePrivate, [switch]$RotationCompleted, [switch]$SecuritySelfTest,
    [switch]$EstablishRuntime)
$ErrorActionPreference = 'Stop'
$nodePath = 'C:\Users\aabaro\AppData\Local\npm-cache\_npx\52027bd8fc0022aa\node_modules\node\bin\node.exe'
$probePath = Join-Path $PSScriptRoot 'test-supabase-password.mjs'
if (!(Test-Path -LiteralPath $nodePath) -or !(Test-Path -LiteralPath $probePath)) {
    throw 'REQUIERE INTERVENCION: falta Node local o el archivo de prueba.'
}
if ($CheckOnly) {
    & $nodePath --check $probePath
    if ($LASTEXITCODE -ne 0) { throw 'Prueba local invalida.' }
    & $nodePath --input-type=module -e "import {createRequire} from 'node:module';const r=createRequire(process.argv[1]);console.log('Driver pg instalado: '+r('pg/package.json').version);" (Join-Path $PSScriptRoot '..\tools\calculate-cpk-ppk\package.json')
    return
}
if ($SelfTest -and $SavePrivate) { throw 'SelfTest cannot save credentials.' }
if ($EstablishRuntime -and ($Role -ne 'Runtime' -or !$SavePrivate -or $SelfTest)) { throw 'EstablishRuntime requires -Role Runtime -SavePrivate.' }
. (Join-Path $PSScriptRoot 'Private-Dacl.ps1')
if ($SecuritySelfTest) {
    & (Join-Path $PSScriptRoot 'Test-PrivateDacl.ps1')
    return
}
if ($SavePrivate) {
    # Fail BEFORE asking for a password or launching Node if either DACL cannot be protected.
    $privateDirectory = Join-Path $PSScriptRoot '..\.env.ajtool-supabase'
    Protect-AJToolPrivatePath -LiteralPath $privateDirectory
    Protect-AJToolPrivatePath -LiteralPath (Join-Path $privateDirectory 'connection.env')
}

if ($SelfTest) {
    # Public synthetic fixture, NOT a database password. Never connects to Supabase.
    $fixture = 'AJTool-pipe-' + [char]0x00f1 + [char]0x20ac + '-test'
    $securePassword = ConvertTo-SecureString $fixture -AsPlainText -Force
} else {
    Write-Host ('AJTool / Session pooler / ' + $Role + '. TLS obligatorio; sin cambios SQL.')
    if ($EstablishRuntime) {
        Write-Host 'Establecer credencial propia ajtool_service: minimo24 caracteres ASCII sin espacios. Se detiene si hay sesiones activas.'
        $securePassword = Read-Host 'Nueva contrasena runtime (oculta; guardar en gestor)' -AsSecureString
        $confirmation = Read-Host 'Confirmar nueva contrasena runtime (oculta)' -AsSecureString
        $firstPointer = [IntPtr]::Zero; $secondPointer = [IntPtr]::Zero
        try {
            $firstPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
            $secondPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($confirmation)
            $matches = [string]::Equals([Runtime.InteropServices.Marshal]::PtrToStringBSTR($firstPointer), [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secondPointer), [StringComparison]::Ordinal)
        } finally {
            if ($firstPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($firstPointer) }
            if ($secondPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secondPointer) }
            $confirmation.Dispose()
        }
        if (!$matches) { $securePassword.Dispose(); throw 'Passwords do not match; no remote operation performed.' }
    } else { $securePassword = Read-Host 'Contrasena PostgreSQL (oculta; Enter vacio cancela)' -AsSecureString }
}
if ($securePassword.Length -eq 0) { $securePassword.Dispose(); Write-Host 'REQUIERE INTERVENCION: sin contrasena; no se intento conectar.'; return }
$pointer = [IntPtr]::Zero
$process = $null
$inputBytes = $null
$phase = 'PREPARAR_PROCESO'
try {
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $nodePath
    $startInfo.Arguments = '"' + $probePath + '"'
    if ($SelfTest) { $startInfo.Arguments += ' --pipe-self-test' }
    if ($Role -eq 'Runtime') { $startInfo.Arguments += ' --runtime' }
    if ($SavePrivate) { $startInfo.Arguments += ' --save-private' }
    if ($RotationCompleted) { $startInfo.Arguments += ' --rotation-completed' }
    if ($EstablishRuntime) { $startInfo.Arguments += ' --establish-runtime' }
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    $phase = 'INICIAR_NODE'
    [void]$process.Start()
    $phase = 'ENVIAR_ENTRADA_OCULTA'
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    # Write explicit UTF8 bytes: .NET Framework may use an OEM StreamWriter encoding.
    # Transient managed string is unavoidable; never log or persist it.
    $inputBytes = [System.Text.Encoding]::UTF8.GetBytes([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer))
    $process.StandardInput.BaseStream.Write($inputBytes, 0, $inputBytes.Length)
    $process.StandardInput.BaseStream.Flush()
    $process.StandardInput.BaseStream.Close()
    [Array]::Clear($inputBytes, 0, $inputBytes.Length)
    $inputBytes = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    $pointer = [IntPtr]::Zero
    $phase = 'RECIBIR_RESULTADO'
    $safeOutput = $process.StandardOutput.ReadToEnd()
    $discardedErrors = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($SelfTest) {
        if ($process.ExitCode -ne 0 -or $safeOutput.Trim() -ne 'PIPE_SELF_TEST_PASS') { throw 'Synthetic pipe test failed' }
        Write-Host 'PIPE_SELF_TEST_PASS: entrada UTF8 verificada; cero conexiones SQL.'
    } elseif ($safeOutput) { Write-Host $safeOutput } else { Write-Host 'ERROR DE CONECTIVIDAD: prueba sin resultado; no se imprimen errores internos.' }
} catch {
    Write-Host ('REQUIERE INTERVENCION: fallo local en ' + $phase + '; no se imprimen detalles sensibles.')
    if ($SelfTest) { throw 'Synthetic pipe test failed; no credentials used.' }
} finally {
    if ($inputBytes) { [Array]::Clear($inputBytes, 0, $inputBytes.Length) }
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    $securePassword.Dispose()
    if ($process) { $process.Dispose() }
    $discardedErrors = $null
}
