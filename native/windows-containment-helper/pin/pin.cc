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
  decltype(&napi_create_object) create_object;
  decltype(&napi_create_function) create_function;
  decltype(&napi_set_named_property) set_property;
  decltype(&napi_wrap) wrap;
  decltype(&napi_unwrap) unwrap;
  decltype(&napi_get_undefined) undefined;
  decltype(&napi_throw_error) throw_error;
};
static Api api;
struct Pins {
  std::vector<HANDLE> handles;
  void Close() { for (HANDLE handle : handles) CloseHandle(handle); handles.clear(); }
  ~Pins() { Close(); }
};
static napi_value Error(napi_env env, const char* message) { api.throw_error(env, "NATIVE_EXECUTABLE_PIN_FAILED", message); return nullptr; }
static void Finalize(napi_env, void* value, void*) { delete static_cast<Pins*>(value); }
static napi_value Close(napi_env env, napi_callback_info info) {
  napi_value self;
  if (api.get_cb_info(env, info, nullptr, nullptr, &self, nullptr) != napi_ok) return Error(env, "Invalid pin receiver");
  void* value = nullptr;
  if (api.unwrap(env, self, &value) != napi_ok || !value) return Error(env, "Invalid pin receiver");
  static_cast<Pins*>(value)->Close();
  napi_value result; api.undefined(env, &result); return result;
}
static bool AddPin(Pins* pins, const std::wstring& filename, bool directory) {
  HANDLE handle = CreateFileW(filename.c_str(), directory ? FILE_READ_ATTRIBUTES : GENERIC_READ,
    directory ? FILE_SHARE_READ | FILE_SHARE_WRITE : FILE_SHARE_READ, nullptr, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), nullptr);
  if (handle == INVALID_HANDLE_VALUE) return false;
  BY_HANDLE_FILE_INFORMATION information;
  if (!GetFileInformationByHandle(handle, &information)
    || (information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)
    || !!(information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != directory) { CloseHandle(handle); return false; }
  pins->handles.push_back(handle); return true;
}
static napi_value Pin(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value argument;
  if (api.get_cb_info(env, info, &count, &argument, nullptr, nullptr) != napi_ok || count != 1) return Error(env, "Expected an absolute executable path");
  size_t length = 0;
  if (api.get_string(env, argument, nullptr, 0, &length) != napi_ok || length < 4 || length > 32760) return Error(env, "Invalid executable path");
  std::vector<char16_t> buffer(length + 1);
  if (api.get_string(env, argument, buffer.data(), buffer.size(), &length) != napi_ok) return Error(env, "Invalid executable path");
  std::wstring filename(reinterpret_cast<wchar_t*>(buffer.data()), length);
  for (wchar_t character : filename) if (character == L'\0' || character == L'/') return Error(env, "Invalid executable path");
  if (!((filename[0] >= L'A' && filename[0] <= L'Z') || (filename[0] >= L'a' && filename[0] <= L'z'))
    || filename[1] != L':' || filename[2] != L'\\' || filename.find(L':', 2) != std::wstring::npos) return Error(env, "Local absolute executable path required");
  Pins* pins = new Pins();
  if (!AddPin(pins, filename, false)) { delete pins; return Error(env, "Executable is mutable, reparsed or unavailable"); }
  size_t separator = filename.find_last_of(L'\\');
  while (separator != std::wstring::npos) {
    const std::wstring ancestor = separator == 2 ? filename.substr(0, 3) : filename.substr(0, separator);
    if (!AddPin(pins, ancestor, true)) { delete pins; return Error(env, "Executable ancestry cannot be pinned"); }
    if (separator <= 2) break;
    separator = filename.find_last_of(L'\\', separator - 1);
  }
  napi_value result, close;
  if (api.create_object(env, &result) != napi_ok || api.wrap(env, result, pins, Finalize, nullptr, nullptr) != napi_ok) { delete pins; return Error(env, "Pin object unavailable"); }
  if (api.create_function(env, "close", NAPI_AUTO_LENGTH, Close, nullptr, &close) != napi_ok || api.set_property(env, result, "close", close) != napi_ok) return Error(env, "Pin close unavailable");
  return result;
}
extern "C" __declspec(dllexport) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  HMODULE node = GetModuleHandleW(nullptr);
#define RESOLVE(member, name) api.member = reinterpret_cast<decltype(api.member)>(GetProcAddress(node, name)); if (!api.member) return nullptr
  RESOLVE(get_cb_info, "napi_get_cb_info"); RESOLVE(get_string, "napi_get_value_string_utf16");
  RESOLVE(create_object, "napi_create_object"); RESOLVE(create_function, "napi_create_function");
  RESOLVE(set_property, "napi_set_named_property"); RESOLVE(wrap, "napi_wrap"); RESOLVE(unwrap, "napi_unwrap");
  RESOLVE(undefined, "napi_get_undefined"); RESOLVE(throw_error, "napi_throw_error");
#undef RESOLVE
  napi_value function;
  if (api.create_function(env, "pinExecutable", NAPI_AUTO_LENGTH, Pin, nullptr, &function) != napi_ok
    || api.set_property(env, exports, "pinExecutable", function) != napi_ok) return Error(env, "Pin API unavailable");
  return exports;
}
