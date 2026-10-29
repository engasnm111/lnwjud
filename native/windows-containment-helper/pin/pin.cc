#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <node_api.h>
#include <string>
#include <vector>

// Resolve the stable N-API ABI from the already loaded Node/Electron executable.
// This avoids a node.exe import-table dependency in Electron on Windows.
struct Api {
  decltype(&napi_get_cb_info) get_cb_info;
  decltype(&napi_get_value_string_utf16) get_string;
  decltype(&napi_get_value_double) get_double;
  decltype(&napi_create_double) create_double;
  decltype(&napi_create_buffer_copy) create_buffer_copy;
  decltype(&napi_is_buffer) is_buffer;
  decltype(&napi_get_buffer_info) buffer_info;
  decltype(&napi_type_tag_object) type_tag;
  decltype(&napi_check_object_type_tag) check_type_tag;
  decltype(&napi_create_object) create_object;
  decltype(&napi_create_function) create_function;
  decltype(&napi_set_named_property) set_property;
  decltype(&napi_wrap) wrap;
  decltype(&napi_unwrap) unwrap;
  decltype(&napi_get_undefined) undefined;
  decltype(&napi_throw_error) throw_error;
};
static Api api;
static const napi_type_tag pinTag = { 0x249b0410ca824fd4ULL, 0x9706c565ad6a7798ULL };
static const napi_type_tag archiveTag = { 0x19d7a5be834f415bULL, 0x99c9d12777698323ULL };
static void QuarantineKnownHandles(std::vector<HANDLE>& handles) noexcept;
#if defined(LNWJUD_ARCHIVE_SNAPSHOT_TEST)
static int archiveTestFault = 0;
#endif
struct Pins {
  std::vector<HANDLE> handles;
  bool closeUnknown = false;
  bool Close() {
    if (closeUnknown) return false;
#if defined(LNWJUD_ARCHIVE_SNAPSHOT_TEST)
    if (!handles.empty() && (archiveTestFault == 10 || archiveTestFault == 11)) { closeUnknown = true; return false; }
#endif
    while (!handles.empty()) {
      HANDLE handle = handles.back();
      handles.pop_back();
      if (!CloseHandle(handle)) { closeUnknown = true; return false; }
    }
    return true;
  }
  ~Pins() { if (!Close()) QuarantineKnownHandles(handles); }
};
static napi_value Error(napi_env env, const char* message) { api.throw_error(env, "NATIVE_EXECUTABLE_PIN_FAILED", message); return nullptr; }
static bool ArchivePathValid(const std::wstring& filename);
static void Finalize(napi_env, void* value, void*) { delete static_cast<Pins*>(value); }
static napi_value Close(napi_env env, napi_callback_info info) {
  napi_value self;
  if (api.get_cb_info(env, info, nullptr, nullptr, &self, nullptr) != napi_ok) return Error(env, "Invalid pin receiver");
  bool matches = false;
  if (api.check_type_tag(env, self, &pinTag, &matches) != napi_ok || !matches) return Error(env, "Invalid pin receiver");
  void* value = nullptr;
  if (api.unwrap(env, self, &value) != napi_ok || !value) return Error(env, "Invalid pin receiver");
  if (!static_cast<Pins*>(value)->Close()) return Error(env, "Executable cleanup unverified");
  napi_value result; api.undefined(env, &result); return result;
}
static bool AddPin(Pins* pins, const std::wstring& filename, bool directory) {
  HANDLE handle = CreateFileW(filename.c_str(), directory ? FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES : GENERIC_READ,
    directory ? FILE_SHARE_READ | FILE_SHARE_WRITE : FILE_SHARE_READ, nullptr, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), nullptr);
  if (handle == INVALID_HANDLE_VALUE) return false;
  try { pins->handles.push_back(handle); }
  catch (...) { if (!CloseHandle(handle)) pins->closeUnknown = true; return false; }
  BY_HANDLE_FILE_INFORMATION information;
  if (!GetFileInformationByHandle(handle, &information)
    || (information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)
    || !!(information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != directory) return false;
  return true;
}
static napi_value PinFailure(napi_env env, Pins* pins, const char* reason) {
  const bool closed = pins->Close();
  delete pins;
  return Error(env, closed ? reason : "Executable cleanup unverified");
}
static napi_value Pin(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value argument;
  if (api.get_cb_info(env, info, &count, &argument, nullptr, nullptr) != napi_ok || count != 1) return Error(env, "Expected an absolute executable path");
  size_t length = 0;
  if (api.get_string(env, argument, nullptr, 0, &length) != napi_ok || length < 4 || length > 32760) return Error(env, "Invalid executable path");
  std::vector<char16_t> buffer(length + 1);
  if (api.get_string(env, argument, buffer.data(), buffer.size(), &length) != napi_ok) return Error(env, "Invalid executable path");
  std::wstring filename(reinterpret_cast<wchar_t*>(buffer.data()), length);
  if (!ArchivePathValid(filename)) return Error(env, "Local canonical executable path required");
  Pins* pins = new Pins();
  if (!AddPin(pins, filename.substr(0, 3), true)) return PinFailure(env, pins, "Executable ancestry cannot be pinned");
  for (size_t separator = filename.find(L'\\', 3); separator != std::wstring::npos; separator = filename.find(L'\\', separator + 1))
    if (!AddPin(pins, filename.substr(0, separator), true)) return PinFailure(env, pins, "Executable ancestry cannot be pinned");
#if defined(LNWJUD_ARCHIVE_SNAPSHOT_TEST)
  if (archiveTestFault == 11) return PinFailure(env, pins, "Executable ancestry test failure");
  if (archiveTestFault == 9) {
    const std::wstring parent = filename.substr(0, filename.find_last_of(L'\\'));
    HANDLE probe = CreateFileW(parent.c_str(), DELETE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr);
    if (probe != INVALID_HANDLE_VALUE) { CloseHandle(probe); return PinFailure(env, pins, "Executable ancestry test failed"); }
    if (GetLastError() != ERROR_SHARING_VIOLATION) return PinFailure(env, pins, "Executable ancestry test inconclusive");
  }
#endif
  if (!AddPin(pins, filename, false)) return PinFailure(env, pins, "Executable is mutable, reparsed or unavailable");
  napi_value result, close;
  if (api.create_object(env, &result) != napi_ok || api.type_tag(env, result, &pinTag) != napi_ok
    || api.wrap(env, result, pins, Finalize, nullptr, nullptr) != napi_ok) return PinFailure(env, pins, "Pin object unavailable");
  if (api.create_function(env, "close", NAPI_AUTO_LENGTH, Close, nullptr, &close) != napi_ok || api.set_property(env, result, "close", close) != napi_ok) {
    return Error(env, pins->Close() ? "Pin close unavailable" : "Executable cleanup unverified");
  }
  return result;
}
#include "archive-snapshot.inc"
extern "C" __declspec(dllexport) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  HMODULE node = GetModuleHandleW(nullptr);
#define RESOLVE(member, name) api.member = reinterpret_cast<decltype(api.member)>(GetProcAddress(node, name)); if (!api.member) return nullptr
  RESOLVE(get_cb_info, "napi_get_cb_info"); RESOLVE(get_string, "napi_get_value_string_utf16");
  RESOLVE(get_double, "napi_get_value_double"); RESOLVE(create_double, "napi_create_double");
  RESOLVE(create_buffer_copy, "napi_create_buffer_copy");
  RESOLVE(is_buffer, "napi_is_buffer"); RESOLVE(buffer_info, "napi_get_buffer_info");
  RESOLVE(type_tag, "napi_type_tag_object"); RESOLVE(check_type_tag, "napi_check_object_type_tag");
  RESOLVE(create_object, "napi_create_object"); RESOLVE(create_function, "napi_create_function");
  RESOLVE(set_property, "napi_set_named_property"); RESOLVE(wrap, "napi_wrap"); RESOLVE(unwrap, "napi_unwrap");
  RESOLVE(undefined, "napi_get_undefined"); RESOLVE(throw_error, "napi_throw_error");
#undef RESOLVE
  napi_value function;
  if (api.create_function(env, "pinExecutable", NAPI_AUTO_LENGTH, Pin, nullptr, &function) != napi_ok
    || api.set_property(env, exports, "pinExecutable", function) != napi_ok) return Error(env, "Pin API unavailable");
  if (api.create_function(env, "openVerifiedArchiveSnapshot", NAPI_AUTO_LENGTH, OpenArchiveSnapshot, nullptr, &function) != napi_ok
    || api.set_property(env, exports, "openVerifiedArchiveSnapshot", function) != napi_ok) return Error(env, "Archive snapshot API unavailable");
  if (api.create_function(env, "createArchiveSpool", NAPI_AUTO_LENGTH, CreateArchiveSpool, nullptr, &function) != napi_ok
    || api.set_property(env, exports, "createArchiveSpool", function) != napi_ok) return Error(env, "Archive spool API unavailable");
#if defined(LNWJUD_ARCHIVE_SNAPSHOT_TEST)
  if (api.create_function(env, "setArchiveTestFault", NAPI_AUTO_LENGTH, SetArchiveTestFault, nullptr, &function) != napi_ok
    || api.set_property(env, exports, "setArchiveTestFault", function) != napi_ok) return Error(env, "Archive test API unavailable");
  if (api.create_function(env, "archiveQuarantineCountForTest", NAPI_AUTO_LENGTH, ArchiveQuarantineCountForTest, nullptr, &function) != napi_ok
    || api.set_property(env, exports, "archiveQuarantineCountForTest", function) != napi_ok) return Error(env, "Archive test API unavailable");
  if (api.create_function(env, "releaseArchiveQuarantineForTest", NAPI_AUTO_LENGTH, ReleaseArchiveQuarantineForTest, nullptr, &function) != napi_ok
    || api.set_property(env, exports, "releaseArchiveQuarantineForTest", function) != napi_ok) return Error(env, "Archive test API unavailable");
#endif
  return exports;
}
