#nullable disable
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using System.Security.Principal;

namespace Lnwjud.Containment;

internal sealed class RepositoryImportAnchor : IDisposable {
 [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string descriptor,uint revision,out IntPtr security,out uint size);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
 const uint GenericRead=0x80000000, DeleteAccess=0x00010000, Synchronize=0x00100000, ReadAttributes=0x80;
 const uint ShareReadWrite=3, OpenExisting=3, BackupSemanticsOpenReparsePoint=0x02200000;
 const uint ObjectCaseInsensitiveNoReparse=0x1040, DirectoryAttribute=0x10;
 const uint FileCreate=2, FileOpen=1, DirectorySynchronousOpenReparsePoint=0x00200021, DeleteOnClose=0x1000;
 [StructLayout(LayoutKind.Sequential)] struct UnicodeString { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
 [StructLayout(LayoutKind.Sequential)] struct ObjectAttributes { public int Length; public IntPtr Root; public IntPtr Name; public uint Attributes; public IntPtr Security; public IntPtr SecurityQos; }
 [StructLayout(LayoutKind.Sequential)] struct IoStatus { public IntPtr Status; public UIntPtr Information; }
 [StructLayout(LayoutKind.Sequential)] struct FileIdentity { public ulong Volume; [MarshalAs(UnmanagedType.ByValArray, SizeConst=16)] public byte[] Id; }
 [StructLayout(LayoutKind.Sequential)] struct AttributeTag { public uint Attributes; public uint Tag; }
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern uint GetDriveType(string root);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetVolumeInformationByHandleW(SafeFileHandle handle,StringBuilder name,uint nameSize,out uint serial,out uint maxComponent,out uint flags,StringBuilder fileSystem,uint fileSystemSize);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,int infoClass,out AttributeTag info,uint size);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,int infoClass,out FileIdentity info,uint size);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle handle,StringBuilder path,uint size,uint flags);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle handle,int infoClass,IntPtr data,uint size);
 [DllImport("ntdll.dll")] static extern uint NtCreateFile(out SafeFileHandle handle,uint access,ref ObjectAttributes attrs,out IoStatus status,IntPtr allocation,uint attributes,uint share,uint disposition,uint options,IntPtr ea,uint eaLength);
 [DllImport("ntdll.dll")] static extern uint NtSetInformationFile(SafeFileHandle handle,out IoStatus status,IntPtr data,uint size,int infoClass);

 readonly List<SafeFileHandle> ancestors = new List<SafeFileHandle>();
 SafeFileHandle stage;
 SafeFileHandle guard;
 SafeFileHandle parent;
 readonly uint volumeSerial;
 readonly string parentPath;
 enum AnchorState { Anchored, Prepared, Published, Disposed }
 AnchorState state;
 bool publicationAccess;

 public RepositoryImportAnchor(string workspaceRoot,string relativeDestination) : this(workspaceRoot,relativeDestination,true) {}
 public RepositoryImportAnchor(string workspaceRoot,string relativeDestination,bool createGuard) {
  var absolute = Path.GetFullPath(workspaceRoot);
  var root = Path.GetPathRoot(absolute);
  if(root == null || root.Length != 3 || root[1] != ':' || GetDriveType(root) != 3) throw new IOException("IMPORT_UNSUPPORTED_VOLUME");
  var segments = relativeDestination.Split(new char[]{'\\','/'});
  if(segments.Length == 0) throw new IOException("IMPORT_INVALID_DESTINATION");
  foreach(var segment in segments) ValidateName(segment);
  DestinationName = segments[segments.Length-1];
  try {
   var drive = CreateFile(root,GenericRead,ShareReadWrite,IntPtr.Zero,OpenExisting,BackupSemanticsOpenReparsePoint,IntPtr.Zero);
   if(drive.IsInvalid) { drive.Dispose(); throw new IOException("IMPORT_ANCHOR_UNAVAILABLE"); }
   ancestors.Add(drive);
   CheckDirectory(drive);
   volumeSerial = RequireNtfs(drive);
   parent = drive;
   var workspaceSegments = absolute.Substring(root.Length).Split(new char[]{'\\','/'},StringSplitOptions.RemoveEmptyEntries);
   foreach(var segment in workspaceSegments) parent = KeepOpen(parent,segment);
   var canonicalWorkspace = FinalPath(parent);
   if(!String.Equals(canonicalWorkspace.TrimEnd('\\'),absolute.TrimEnd('\\'),StringComparison.OrdinalIgnoreCase)) throw new IOException("IMPORT_WORKSPACE_IDENTITY_CHANGED");
   for(int i=0;i<segments.Length-1;i++) parent = KeepOpen(parent,segments[i]);
   parentPath = FinalPath(parent);
   if(createGuard) guard = OpenRelative(parent,".lnwjud-import-guard-"+Guid.NewGuid().ToString("N"),true);
   CheckDirectory(parent);
  } catch { Dispose(); throw; }
 }

 public string DestinationName { get; private set; }
 public string DestinationPath { get { return Path.Combine(parentPath,DestinationName); } }
 public string ParentIdentity { get { return Identity(parent); } }

 public static string CreatePrivateStage(string stagePath) {
  var absolute=Path.GetFullPath(stagePath);
  var directory=Path.GetDirectoryName(absolute);
  var name=Path.GetFileName(absolute);
  if(directory==null || !System.Text.RegularExpressions.Regex.IsMatch(name,@"^\.lnwjud-import-stage-[0-9a-f-]{36}$"))throw new IOException("IMPORT_INVALID_STAGE");
  using(var anchor=new RepositoryImportAnchor(directory,"stage",false)) {
   var sid=WindowsIdentity.GetCurrent().User?.Value ?? throw new IOException("IMPORT_STAGE_OWNER_UNAVAILABLE");
   IntPtr security;
   uint size;
   if(!ConvertStringSecurityDescriptorToSecurityDescriptor("O:"+sid+"D:P(A;OICI;FA;;;"+sid+")",1,out security,out size))throw new IOException("IMPORT_STAGE_DACL_UNAVAILABLE");
   var chars=Marshal.StringToHGlobalUni(name);
   var unicode=new UnicodeString{Length=checked((ushort)(name.Length*2)),MaximumLength=checked((ushort)(name.Length*2+2)),Buffer=chars};
   var ptr=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
   try {
    Marshal.StructureToPtr(unicode,ptr,false);
    var attrs=new ObjectAttributes{Length=Marshal.SizeOf(typeof(ObjectAttributes)),Root=anchor.parent.DangerousGetHandle(),Name=ptr,Attributes=ObjectCaseInsensitiveNoReparse,Security=security};
    SafeFileHandle handle; IoStatus status;
    var result=NtCreateFile(out handle,GenericRead|Synchronize|ReadAttributes,ref attrs,out status,IntPtr.Zero,DirectoryAttribute,ShareReadWrite,FileCreate,DirectorySynchronousOpenReparsePoint,IntPtr.Zero,0);
    using(handle) {
     if(result!=0)throw new IOException("IMPORT_STAGE_CREATE_REFUSED_"+result.ToString("X8"));
     CheckDirectory(handle);
     if(RequireNtfs(handle)!=anchor.volumeSerial)throw new IOException("IMPORT_CROSS_VOLUME");
     return Identity(handle);
    }
   } finally {Marshal.FreeHGlobal(ptr);Marshal.FreeHGlobal(chars);LocalFree(security);}
  }
 }

 SafeFileHandle KeepOpen(SafeFileHandle root,string segment) {
  ValidateName(segment);
  var next = OpenRelative(root,segment,false);
  ancestors.Add(next);
  CheckDirectory(next);
  ValidateName(Path.GetFileName(FinalPath(next)));
  if(RequireNtfs(next) != volumeSerial) throw new IOException("IMPORT_VOLUME_CHANGED");
  return next;
 }

 static SafeFileHandle OpenRelative(SafeFileHandle root,string name,bool create) {
  var chars=Marshal.StringToHGlobalUni(name);
  var unicode = new UnicodeString{Length=checked((ushort)(name.Length*2)),MaximumLength=checked((ushort)(name.Length*2+2)),Buffer=chars};
  var ptr=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
  try {
   Marshal.StructureToPtr(unicode,ptr,false);
   var attrs=new ObjectAttributes{Length=Marshal.SizeOf(typeof(ObjectAttributes)),Root=root.DangerousGetHandle(),Name=ptr,Attributes=ObjectCaseInsensitiveNoReparse};
   SafeFileHandle handle; IoStatus status;
   uint access=GenericRead|Synchronize|ReadAttributes|(create?DeleteAccess:0);
   uint options=DirectorySynchronousOpenReparsePoint|(create?DeleteOnClose:0);
   uint result=NtCreateFile(out handle,access,ref attrs,out status,IntPtr.Zero,DirectoryAttribute,ShareReadWrite,create?FileCreate:FileOpen,options,IntPtr.Zero,0);
   if(result!=0) { if(handle!=null)handle.Dispose(); throw new IOException("IMPORT_ANCHOR_REFUSED_"+result.ToString("X8")); }
   return handle;
  } finally { Marshal.FreeHGlobal(ptr);Marshal.FreeHGlobal(chars); }
 }

 public string PrepareStage(string stagePath,bool forPublication=true) {
  if(state!=AnchorState.Anchored||stage!=null)throw new InvalidOperationException("IMPORT_PREPARATION_STATE");
  stage=CreateFile(stagePath,GenericRead|ReadAttributes|(forPublication?DeleteAccess:0),ShareReadWrite,IntPtr.Zero,OpenExisting,BackupSemanticsOpenReparsePoint,IntPtr.Zero);
  if(stage.IsInvalid)throw new IOException("IMPORT_STAGE_UNAVAILABLE");
  CheckDirectory(stage);
  if(RequireNtfs(stage)!=volumeSerial)throw new IOException("IMPORT_CROSS_VOLUME");
  var identity=Identity(stage);
  state=AnchorState.Prepared;
  publicationAccess=forPublication;
  return identity;
 }

 public string ReadPublishedIdentity() {
  if(state==AnchorState.Disposed)throw new ObjectDisposedException("RepositoryImportAnchor");
  if(state==AnchorState.Prepared)throw new InvalidOperationException("IMPORT_NOT_PUBLISHED");
  if(state==AnchorState.Published)return Identity(stage);
  using(var handle=OpenRelative(parent,DestinationName,false)) {
   CheckDirectory(handle);
   if(RequireNtfs(handle)!=volumeSerial)throw new IOException("IMPORT_CROSS_VOLUME");
   return Identity(handle);
  }
 }

 static string Identity(SafeFileHandle handle) {
  FileIdentity info;
  if(!GetFileInformationByHandleEx(handle,18,out info,(uint)Marshal.SizeOf(typeof(FileIdentity))))throw new IOException("IMPORT_IDENTITY_UNAVAILABLE");
  return info.Volume.ToString("X16")+"-"+BitConverter.ToString(info.Id).Replace("-","");
 }

 public void Publish() {
  if(state!=AnchorState.Prepared||!publicationAccess)throw new InvalidOperationException("IMPORT_PUBLICATION_STATE");
  {
   var name=Encoding.Unicode.GetBytes(DestinationName);
   int rootOffset=IntPtr.Size==8?8:4;
   int lengthOffset=rootOffset+IntPtr.Size;
   int nameOffset=lengthOffset+4;
   // FILE_RENAME_INFORMATION requires at least one full WCHAR field plus native structure padding.
   // A one-character destination otherwise yields STATUS_INFO_LENGTH_MISMATCH (C0000004).
   int size=Math.Max(nameOffset+name.Length,nameOffset+4);
   var buffer=Marshal.AllocHGlobal(size);
   try {
    for(int i=0;i<size;i++)Marshal.WriteByte(buffer,i,0);
    Marshal.WriteIntPtr(buffer,rootOffset,parent.DangerousGetHandle());
    Marshal.WriteInt32(buffer,lengthOffset,name.Length);
    Marshal.Copy(name,0,IntPtr.Add(buffer,nameOffset),name.Length);
    IoStatus status;
    uint result=NtSetInformationFile(stage,out status,buffer,(uint)size,10);
    if(result!=0)throw new IOException("IMPORT_PUBLICATION_REFUSED_"+result.ToString("X8"));
    state=AnchorState.Published;
    if(!String.Equals(FinalPath(stage),DestinationPath,StringComparison.OrdinalIgnoreCase))throw new IOException("IMPORT_PUBLICATION_IDENTITY_UNRESOLVED");
   } finally {Marshal.FreeHGlobal(buffer);}
  }
 }

 static uint RequireNtfs(SafeFileHandle handle) {
  var name=new StringBuilder(261);var fs=new StringBuilder(261);uint serial,max,flags;
  if(!GetVolumeInformationByHandleW(handle,name,261,out serial,out max,out flags,fs,261)||fs.ToString()!="NTFS")throw new IOException("IMPORT_UNSUPPORTED_FILESYSTEM");
  return serial;
 }

 static void CheckDirectory(SafeFileHandle handle) {
  AttributeTag info;
  if(!GetFileInformationByHandleEx(handle,9,out info,(uint)Marshal.SizeOf(typeof(AttributeTag)))||(info.Attributes&0x10)==0||(info.Attributes&0x400)!=0)throw new IOException("IMPORT_REPARSE_OR_INVALID_DIRECTORY");
 }

 static string FinalPath(SafeFileHandle handle) {
  var text=new StringBuilder(32768);
  uint length=GetFinalPathNameByHandle(handle,text,(uint)text.Capacity,0);
  if(length==0||length>=text.Capacity)throw new IOException("IMPORT_IDENTITY_UNAVAILABLE");
  var value=text.ToString();
  if(!value.StartsWith(@"\\?\",StringComparison.Ordinal))throw new IOException("IMPORT_UNSUPPORTED_IDENTITY");
  return value.Substring(4);
 }

 static void ValidateName(string name) {
  if(String.IsNullOrEmpty(name)||name=="."||name==".."||name.EndsWith(".")||name.EndsWith(" ")||name.IndexOfAny(new char[]{':','\\','/','\0','<','>','"','|','?','*'})>=0)throw new IOException("IMPORT_INVALID_NAME");
  foreach(char c in name)if(c<32)throw new IOException("IMPORT_INVALID_NAME");
  var stem=name.Split('.')[0].ToUpperInvariant();
  if(stem=="CON"||stem=="PRN"||stem=="AUX"||stem=="NUL"||stem=="CONIN$"||stem=="CONOUT$"||stem=="CLOCK$"||(stem.Length==4&&(stem.StartsWith("COM")||stem.StartsWith("LPT"))&&"123456789\u00b9\u00b2\u00b3".IndexOf(stem[3])>=0))throw new IOException("IMPORT_INVALID_NAME");
  if(name.Equals(".git",StringComparison.OrdinalIgnoreCase)||name.StartsWith(".lnwjud",StringComparison.OrdinalIgnoreCase))throw new IOException("IMPORT_PROTECTED_DESTINATION");
 }

 public void Dispose() {
  if(state==AnchorState.Disposed)return;
  state=AnchorState.Disposed;
  if(stage!=null)stage.Dispose();
  if(guard!=null)guard.Dispose();
  for(int i=ancestors.Count-1;i>=0;i--)ancestors[i].Dispose();
 }
}
