# Windows PowerShell5.1 / PowerShell7. No SACL read/write and no privilege enablement.
if (-not ('AJToolDaclOnly' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
public static class AJToolDaclOnly {
    const uint DACL = 4, PROTECTED_DACL = 0x80000000;
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, EntryPoint="GetNamedSecurityInfoW")]
    static extern uint GetInfo(string path, int type, uint info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, EntryPoint="SetNamedSecurityInfoW")]
    static extern uint SetInfo(string path, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("advapi32.dll", SetLastError=true)]
    static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);
    [DllImport("advapi32.dll")]
    static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool DuplicateToken(IntPtr token,int level,out IntPtr duplicate);
    [StructLayout(LayoutKind.Sequential)] struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr token,uint flags,uint disabledCount,IntPtr disabled,uint privilegeCount,IntPtr privileges,uint restrictedCount,ref SidAndAttributes restricted,out IntPtr result);
    [StructLayout(LayoutKind.Sequential)] struct Mapping { public uint Read,Write,Execute,All; }
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool AccessCheck(byte[] descriptor,IntPtr token,uint desired,ref Mapping mapping,byte[] privileges,ref uint length,out uint granted,out bool status);
    static void Check(bool ok) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    public static byte[] ReadAccessOwnerGroup(string path) {
        IntPtr owner,group,dacl,sacl,descriptor;
        // OWNER/GROUP/DACL metadata only; deliberately excludes SACL_SECURITY_INFORMATION.
        uint error=GetInfo(path,1,7,out owner,out group,out dacl,out sacl,out descriptor);
        if(error!=0)throw new Win32Exception((int)error);
        try { byte[] data=new byte[GetSecurityDescriptorLength(descriptor)]; Marshal.Copy(descriptor,data,0,data.Length);return data; }
        finally { LocalFree(descriptor); }
    }
    public static void WriteProtectedDacl(string path,byte[] descriptor) {
        GCHandle pinned=GCHandle.Alloc(descriptor,GCHandleType.Pinned);
        try {
            bool present,defaulted;IntPtr dacl;
            Check(GetSecurityDescriptorDacl(pinned.AddrOfPinnedObject(),out present,out dacl,out defaulted));
            if(!present||dacl==IntPtr.Zero)throw new InvalidOperationException("Null/absent DACL refused");
            // Exactly0x80000004. Owner/group/SACL pointers are NULL and never selected.
            uint error=SetInfo(path,1,DACL|PROTECTED_DACL,IntPtr.Zero,IntPtr.Zero,dacl,IntPtr.Zero);
            if(error!=0)throw new Win32Exception((int)error);
        } finally { pinned.Free(); }
    }
    public static bool RestrictedPublicTokenCanReadWrite(byte[] descriptor) {
        IntPtr primary=IntPtr.Zero,restricted=IntPtr.Zero,impersonation=IntPtr.Zero,sid=IntPtr.Zero;
        try {
            Check(OpenProcessToken(GetCurrentProcess(),0xA,out primary));
            var publicSid=new SecurityIdentifier("S-1-1-0");byte[] bytes=new byte[publicSid.BinaryLength];publicSid.GetBinaryForm(bytes,0);
            sid=Marshal.AllocHGlobal(bytes.Length);Marshal.Copy(bytes,0,sid,bytes.Length);
            var item=new SidAndAttributes{Sid=sid,Attributes=0};
            Check(CreateRestrictedToken(primary,1,0,IntPtr.Zero,0,IntPtr.Zero,1,ref item,out restricted));
            Check(DuplicateToken(restricted,2,out impersonation));
            var mapping=new Mapping{Read=0x120089,Write=0x120116,Execute=0x1200A0,All=0x1F01FF};
            byte[] privileges=new byte[4096];uint length=(uint)privileges.Length,granted;bool allowed;
            Check(AccessCheck(descriptor,impersonation,3,ref mapping,privileges,ref length,out granted,out allowed));
            return allowed;
        } finally {if(impersonation!=IntPtr.Zero)CloseHandle(impersonation);if(restricted!=IntPtr.Zero)CloseHandle(restricted);if(primary!=IntPtr.Zero)CloseHandle(primary);if(sid!=IntPtr.Zero)Marshal.FreeHGlobal(sid);}
    }
}
'@
}

function Protect-AJToolPrivatePath {
    [CmdletBinding()]
    param([Parameter(Mandatory=$true)][string]$LiteralPath)
    $item = Get-Item -LiteralPath $LiteralPath -ErrorAction Stop
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Private path must not be a link.' }
    $path = $item.FullName
    $before = New-Object Security.AccessControl.RawSecurityDescriptor([AJToolDaclOnly]::ReadAccessOwnerGroup($path),0)
    $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    if ($before.Owner.Value -notin @($userSid.Value,'S-1-5-18','S-1-5-32-544')) { throw 'Untrusted private path owner; no ownership change attempted.' }
    if ($item.PSIsContainer) { $access = New-Object Security.AccessControl.DirectorySecurity } else { $access = New-Object Security.AccessControl.FileSecurity }
    $access.SetAccessRuleProtection($true,$false)
    foreach ($sid in @($userSid,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) {
        if ($item.PSIsContainer) { $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow') }
        else { $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow') }
        $access.AddAccessRule($rule)
    }
    [AJToolDaclOnly]::WriteProtectedDacl($path,$access.GetSecurityDescriptorBinaryForm())
    $afterBytes = [AJToolDaclOnly]::ReadAccessOwnerGroup($path)
    $after = New-Object Security.AccessControl.RawSecurityDescriptor($afterBytes,0)
    if ($before.Owner.Value -ne $after.Owner.Value -or $before.Group.Value -ne $after.Group.Value) { throw 'Owner/group changed unexpectedly.' }
    if (!($after.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -or $after.DiscretionaryAcl.Count -ne 2) { throw 'Private DACL verification failed.' }
    foreach ($ace in $after.DiscretionaryAcl) {
        if ($ace.SecurityIdentifier.Value -notin @($userSid.Value,'S-1-5-18') -or $ace.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed -or $ace.AccessMask -ne [int][Security.AccessControl.FileSystemRights]::FullControl) { throw 'Unexpected private permission.' }
    }
    if ([AJToolDaclOnly]::RestrictedPublicTokenCanReadWrite($afterBytes)) { throw 'Restricted public token unexpectedly allowed.' }
    if (!$item.PSIsContainer) {
        $stream = [IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite)
        $stream.Dispose()
    }
}
