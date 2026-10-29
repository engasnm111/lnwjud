#include <bcrypt.h>
#include <cmath>
#include <cstdint>
#include <memory>
#include <mutex>

static std::mutex archiveQuarantineMutex;
static std::vector<HANDLE> archiveQuarantineHandles;
static void QuarantineKnownHandles(std::vector<HANDLE>& handles) noexcept {
  try {
    std::lock_guard<std::mutex> guard(archiveQuarantineMutex);
    archiveQuarantineHandles.insert(archiveQuarantineHandles.end(), handles.begin(), handles.end());
  } catch (...) { }
  handles.clear();
}

#if defined(LNWJUD_ARCHIVE_SNAPSHOT_TEST)
static napi_value SetArchiveTestFault(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value argument; double value = 0;
  if (api.get_cb_info(env, info, &count, &argument, nullptr, nullptr) != napi_ok || count != 1
    || api.get_double(env, argument, &value) != napi_ok || !std::isfinite(value)
    || value < 0 || value > 11 || std::floor(value) != value) return Error(env, "Test fault invalid");
  archiveTestFault = static_cast<int>(value);
  napi_value result; api.undefined(env, &result); return result;
}
static napi_value ArchiveQuarantineCountForTest(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> guard(archiveQuarantineMutex);
  napi_value result;
  if (api.create_double(env, static_cast<double>(archiveQuarantineHandles.size()), &result) != napi_ok)
    return Error(env, "Test quarantine unavailable");
  return result;
}
static napi_value ReleaseArchiveQuarantineForTest(napi_env env, napi_callback_info) {
  std::lock_guard<std::mutex> guard(archiveQuarantineMutex);
  while (!archiveQuarantineHandles.empty()) {
    if (!CloseHandle(archiveQuarantineHandles.back())) return Error(env, "Test cleanup failed");
    archiveQuarantineHandles.pop_back();
  }
  napi_value result; api.undefined(env, &result); return result;
}
#endif

struct ArchiveSnapshot {
  Pins ancestors;
  HANDLE file = INVALID_HANDLE_VALUE;
  uint64_t size = 0;
  uint64_t expectedSize = 0;
  std::wstring expectedDigest;
  bool verified = false;
  bool failed = false;
  bool dispositionMarked = false;
  bool discarded = false;
  bool closeUnknown = false;
  bool Close() {
    if (closeUnknown) return false;
    if (file != INVALID_HANDLE_VALUE) {
#if defined(LNWJUD_ARCHIVE_SNAPSHOT_TEST)
      if (archiveTestFault == 5) return false;
      if (archiveTestFault == 6) {
        std::lock_guard<std::mutex> guard(archiveQuarantineMutex);
        archiveQuarantineHandles.push_back(file);
        file = INVALID_HANDLE_VALUE; closeUnknown = true; return false;
      }
#endif
      if (!CloseHandle(file)) { file = INVALID_HANDLE_VALUE; closeUnknown = true; return false; }
      file = INVALID_HANDLE_VALUE;
    }
#if defined(LNWJUD_ARCHIVE_SNAPSHOT_TEST)
    if (!ancestors.handles.empty() && (archiveTestFault == 7 || archiveTestFault == 8)) { closeUnknown = true; return false; }
#endif
    if (!ancestors.Close()) { closeUnknown = true; return false; }
    return true;
  }
  ~ArchiveSnapshot() {
    if (!Close()) {
      // Keep known handles until process exit when closure cannot be verified.
      try {
        std::lock_guard<std::mutex> guard(archiveQuarantineMutex);
        if (file != INVALID_HANDLE_VALUE && !closeUnknown) archiveQuarantineHandles.push_back(file);
        archiveQuarantineHandles.insert(archiveQuarantineHandles.end(), ancestors.handles.begin(), ancestors.handles.end());
      } catch (...) { }
      file = INVALID_HANDLE_VALUE;
      ancestors.handles.clear();
    }
  }
};

static bool ArchivePathValid(const std::wstring& filename) {
  if (filename.size() < 4 || filename.size() > 32760
    || !((filename[0] >= L'A' && filename[0] <= L'Z') || (filename[0] >= L'a' && filename[0] <= L'z'))
    || filename[1] != L':' || filename[2] != L'\\') return false;
  size_t start = 3;
  while (start < filename.size()) {
    size_t end = filename.find(L'\\', start);
    if (end == std::wstring::npos) end = filename.size();
    const std::wstring part = filename.substr(start, end - start);
    if (part.empty() || part == L"." || part == L".." || part.back() == L'.' || part.back() == L' ') return false;
    for (wchar_t character : part)
      if (character < 32 || character == L'/' || character == L':' || character == L'"'
        || character == L'<' || character == L'>' || character == L'|' || character == L'?' || character == L'*') return false;
    const std::wstring base = part.substr(0, part.find(L'.'));
    if (_wcsicmp(base.c_str(), L"CON") == 0 || _wcsicmp(base.c_str(), L"PRN") == 0
      || _wcsicmp(base.c_str(), L"AUX") == 0 || _wcsicmp(base.c_str(), L"NUL") == 0) return false;
    if (base.size() == 4 && ((base[3] >= L'1' && base[3] <= L'9') || base[3] == L'\u00b9' || base[3] == L'\u00b2' || base[3] == L'\u00b3')
      && (_wcsnicmp(base.c_str(), L"COM", 3) == 0 || _wcsnicmp(base.c_str(), L"LPT", 3) == 0)) return false;
    if (end == filename.size()) return true;
    start = end + 1;
  }
  return false;
}

static bool HashArchive(HANDLE file, uint64_t size, const std::wstring& expected) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  DWORD objectLength = 0, resultLength = 0;
  bool valid = false;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return false;
  if (BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&objectLength), sizeof(objectLength), &resultLength, 0) >= 0
    && resultLength == sizeof(objectLength) && objectLength > 0 && objectLength <= 65536) {
    std::vector<UCHAR> object(objectLength), buffer(1024 * 1024), digest(32);
    if (BCryptCreateHash(algorithm, &hash, object.data(), objectLength, nullptr, 0, 0) >= 0) {
      LARGE_INTEGER start{};
      if (SetFilePointerEx(file, start, nullptr, FILE_BEGIN)) {
        uint64_t remaining = size;
        bool success = true;
        while (remaining > 0) {
          DWORD wanted = static_cast<DWORD>(remaining < buffer.size() ? remaining : buffer.size()), read = 0;
          if (!ReadFile(file, buffer.data(), wanted, &read, nullptr) || read != wanted
            || BCryptHashData(hash, buffer.data(), read, 0) < 0) { success = false; break; }
          remaining -= read;
        }
        if (success && BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) >= 0) {
          static const wchar_t hex[] = L"0123456789abcdef";
          std::wstring actual;
          for (UCHAR byte : digest) { actual.push_back(hex[byte >> 4]); actual.push_back(hex[byte & 15]); }
          valid = actual == expected;
        }
      }
      BCryptDestroyHash(hash);
    }
  }
  BCryptCloseAlgorithmProvider(algorithm, 0);
  return valid;
}

static ArchiveSnapshot* ArchiveReceiver(napi_env env, napi_callback_info info, size_t* count, napi_value* arguments) {
  napi_value self;
  if (api.get_cb_info(env, info, count, arguments, &self, nullptr) != napi_ok) return nullptr;
  bool matches = false;
  if (api.check_type_tag(env, self, &archiveTag, &matches) != napi_ok || !matches) return nullptr;
  void* value = nullptr;
  if (api.unwrap(env, self, &value) != napi_ok || !value) return nullptr;
  return static_cast<ArchiveSnapshot*>(value);
}
static void ArchiveFinalize(napi_env, void* value, void*) { delete static_cast<ArchiveSnapshot*>(value); }

static napi_value ArchiveRead(napi_env env, napi_callback_info info) {
  size_t count = 2; napi_value arguments[2];
  ArchiveSnapshot* snapshot = ArchiveReceiver(env, info, &count, arguments);
  double offset = 0, length = 0;
  if (!snapshot || count != 2 || snapshot->file == INVALID_HANDLE_VALUE || !snapshot->verified || snapshot->dispositionMarked
    || api.get_double(env, arguments[0], &offset) != napi_ok || api.get_double(env, arguments[1], &length) != napi_ok
    || !std::isfinite(offset) || !std::isfinite(length) || offset < 0 || length < 0
    || std::floor(offset) != offset || std::floor(length) != length || length > 1024 * 1024
    || offset > static_cast<double>(snapshot->size) || length > static_cast<double>(snapshot->size) - offset)
    return Error(env, "Archive read bounds invalid");
  const DWORD wanted = static_cast<DWORD>(length);
  std::vector<unsigned char> buffer(wanted);
  LARGE_INTEGER position; position.QuadPart = static_cast<LONGLONG>(offset);
  if (!SetFilePointerEx(snapshot->file, position, nullptr, FILE_BEGIN)) return Error(env, "Archive read failed");
  DWORD total = 0;
  while (total < wanted) {
    DWORD read = 0;
    if (!ReadFile(snapshot->file, buffer.data() + total, wanted - total, &read, nullptr) || read == 0)
      return Error(env, "Archive read failed");
    total += read;
  }
  napi_value result;
  if (api.create_buffer_copy(env, wanted, wanted ? buffer.data() : nullptr, nullptr, &result) != napi_ok)
    return Error(env, "Archive read failed");
  return result;
}

static napi_value ArchiveWrite(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value argument;
  ArchiveSnapshot* snapshot = ArchiveReceiver(env, info, &count, &argument);
  bool isBuffer = false; void* data = nullptr; size_t length = 0;
  if (!snapshot || snapshot->file == INVALID_HANDLE_VALUE || snapshot->verified || snapshot->failed || snapshot->dispositionMarked
    || count != 1 || api.is_buffer(env, argument, &isBuffer) != napi_ok || !isBuffer
    || api.buffer_info(env, argument, &data, &length) != napi_ok || length > 1024 * 1024
    || length > snapshot->expectedSize - snapshot->size) {
    if (snapshot && !snapshot->verified) snapshot->failed = true;
    return Error(env, "Archive write invalid");
  }
  LARGE_INTEGER position; position.QuadPart = static_cast<LONGLONG>(snapshot->size);
  if (!SetFilePointerEx(snapshot->file, position, nullptr, FILE_BEGIN)) {
    snapshot->failed = true; return Error(env, "Archive write failed");
  }
  DWORD total = 0, wanted = static_cast<DWORD>(length);
  while (total < wanted) {
    DWORD written = 0;
    if (!WriteFile(snapshot->file, static_cast<unsigned char*>(data) + total, wanted - total, &written, nullptr) || written == 0) {
      snapshot->failed = true; return Error(env, "Archive write failed");
    }
    total += written;
  }
  snapshot->size += total;
  napi_value result; api.undefined(env, &result); return result;
}

static napi_value ArchiveSeal(napi_env env, napi_callback_info info) {
  ArchiveSnapshot* snapshot = ArchiveReceiver(env, info, nullptr, nullptr);
  if (!snapshot || snapshot->file == INVALID_HANDLE_VALUE || snapshot->verified || snapshot->failed || snapshot->dispositionMarked)
    return Error(env, "Archive cannot be sealed");
  LARGE_INTEGER actualSize{};
  if (snapshot->size != snapshot->expectedSize || !FlushFileBuffers(snapshot->file)
    || !GetFileSizeEx(snapshot->file, &actualSize) || actualSize.QuadPart != static_cast<LONGLONG>(snapshot->expectedSize)
    || !HashArchive(snapshot->file, snapshot->size, snapshot->expectedDigest)) {
    snapshot->failed = true; return Error(env, "Archive verification failed");
  }
  snapshot->verified = true;
  napi_value result; api.undefined(env, &result); return result;
}

static napi_value ArchiveClose(napi_env env, napi_callback_info info) {
  ArchiveSnapshot* snapshot = ArchiveReceiver(env, info, nullptr, nullptr);
  if (!snapshot) return Error(env, "Invalid archive receiver");
  if (!snapshot->Close()) return Error(env, "Archive close unverified");
  napi_value result; api.undefined(env, &result); return result;
}

static napi_value ArchiveDiscard(napi_env env, napi_callback_info info) {
  ArchiveSnapshot* snapshot = ArchiveReceiver(env, info, nullptr, nullptr);
  if (!snapshot) return Error(env, "Invalid archive receiver");
  if (snapshot->discarded) { napi_value result; api.undefined(env, &result); return result; }
  if (!snapshot->dispositionMarked) {
    if (snapshot->file == INVALID_HANDLE_VALUE) return Error(env, "Archive is not open");
    FILE_DISPOSITION_INFO disposition{}; disposition.DeleteFile = TRUE;
    if (!SetFileInformationByHandle(snapshot->file, FileDispositionInfo, &disposition, sizeof(disposition)))
      return Error(env, "Archive cleanup unverified");
    snapshot->dispositionMarked = true;
  }
  if (!snapshot->Close()) return Error(env, "Archive cleanup unverified");
  snapshot->discarded = true;
  napi_value result; api.undefined(env, &result); return result;
}

static napi_value ArchiveInitializationError(napi_env env, ArchiveSnapshot* snapshot, bool created) {
  if (created && snapshot->file != INVALID_HANDLE_VALUE) {
    FILE_DISPOSITION_INFO disposition{}; disposition.DeleteFile = TRUE;
    bool removed = false;
#if defined(LNWJUD_ARCHIVE_SNAPSHOT_TEST)
    if (archiveTestFault != 4)
#endif
      removed = !!SetFileInformationByHandle(snapshot->file, FileDispositionInfo, &disposition, sizeof(disposition));
    if (!removed) {
      snapshot->Close(); return Error(env, "Archive cleanup unverified");
    }
  }
  if (!snapshot->Close()) return Error(env, "Archive cleanup unverified");
  return Error(env, "Archive initialization failed");
}

static napi_value OpenArchive(napi_env env, napi_callback_info info, bool create) {
  size_t count = 3; napi_value arguments[3];
  if (api.get_cb_info(env, info, &count, arguments, nullptr, nullptr) != napi_ok || count != 3)
    return Error(env, "Archive arguments invalid");
  size_t pathLength = 0, digestLength = 0;
  double expectedSize = 0;
  if (api.get_string(env, arguments[0], nullptr, 0, &pathLength) != napi_ok || pathLength < 4 || pathLength > 32760
    || api.get_double(env, arguments[1], &expectedSize) != napi_ok || !std::isfinite(expectedSize)
    || expectedSize <= 0 || expectedSize > 5.0 * 1024 * 1024 * 1024 || std::floor(expectedSize) != expectedSize
    || api.get_string(env, arguments[2], nullptr, 0, &digestLength) != napi_ok || digestLength != 64)
    return Error(env, "Archive arguments invalid");
  std::vector<char16_t> pathBuffer(pathLength + 1), digestBuffer(digestLength + 1);
  if (api.get_string(env, arguments[0], pathBuffer.data(), pathBuffer.size(), &pathLength) != napi_ok
    || api.get_string(env, arguments[2], digestBuffer.data(), digestBuffer.size(), &digestLength) != napi_ok)
    return Error(env, "Archive arguments invalid");
  const std::wstring filename(reinterpret_cast<wchar_t*>(pathBuffer.data()), pathLength);
  const std::wstring expected(reinterpret_cast<wchar_t*>(digestBuffer.data()), digestLength);
  if (!ArchivePathValid(filename)) return Error(env, "Archive path invalid");
  for (wchar_t value : expected) if (!((value >= L'0' && value <= L'9') || (value >= L'a' && value <= L'f'))) return Error(env, "Archive digest invalid");
  const std::wstring root = filename.substr(0, 3);
  wchar_t filesystem[32]; DWORD serial = 0;
  if (GetDriveTypeW(root.c_str()) != DRIVE_FIXED
    || !GetVolumeInformationW(root.c_str(), nullptr, 0, &serial, nullptr, nullptr, filesystem, 32)
    || _wcsicmp(filesystem, L"NTFS") != 0) return Error(env, "Archive volume unsupported");
  std::unique_ptr<ArchiveSnapshot> snapshot(new ArchiveSnapshot());
  if (!AddPin(&snapshot->ancestors, root, true)) return ArchiveInitializationError(env, snapshot.get(), false);
  for (size_t separator = filename.find(L'\\', 3); separator != std::wstring::npos; separator = filename.find(L'\\', separator + 1))
    if (!AddPin(&snapshot->ancestors, filename.substr(0, separator), true)) return ArchiveInitializationError(env, snapshot.get(), false);
  snapshot->file = CreateFileW(filename.c_str(), GENERIC_READ | DELETE | (create ? GENERIC_WRITE : 0), create ? 0 : FILE_SHARE_READ, nullptr,
    create ? CREATE_NEW : OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (snapshot->file == INVALID_HANDLE_VALUE) return ArchiveInitializationError(env, snapshot.get(), false);
#if defined(LNWJUD_ARCHIVE_SNAPSHOT_TEST)
  if (create && (archiveTestFault == 1 || archiveTestFault == 4 || archiveTestFault == 8)) return ArchiveInitializationError(env, snapshot.get(), create);
#endif
  BY_HANDLE_FILE_INFORMATION information{}; LARGE_INTEGER actualSize{};
  if (!GetFileInformationByHandle(snapshot->file, &information) || GetFileType(snapshot->file) != FILE_TYPE_DISK
    || (information.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY))
    || information.nNumberOfLinks != 1 || information.dwVolumeSerialNumber != serial
    || !GetFileSizeEx(snapshot->file, &actualSize) || actualSize.QuadPart != (create ? 0 : static_cast<LONGLONG>(expectedSize)))
    return ArchiveInitializationError(env, snapshot.get(), create);
  snapshot->size = static_cast<uint64_t>(actualSize.QuadPart);
  snapshot->expectedSize = static_cast<uint64_t>(expectedSize);
  snapshot->expectedDigest = expected;
  if (!create) {
    if (!HashArchive(snapshot->file, snapshot->size, expected)) return ArchiveInitializationError(env, snapshot.get(), false);
    snapshot->verified = true;
  }
#if defined(LNWJUD_ARCHIVE_SNAPSHOT_TEST)
  if (create && archiveTestFault == 2) return ArchiveInitializationError(env, snapshot.get(), create);
#endif
  napi_value result, function, sizeValue;
  if (api.create_object(env, &result) != napi_ok || api.type_tag(env, result, &archiveTag) != napi_ok
    || api.create_double(env, expectedSize, &sizeValue) != napi_ok
    || api.set_property(env, result, "size", sizeValue) != napi_ok
    || api.wrap(env, result, snapshot.get(), ArchiveFinalize, nullptr, nullptr) != napi_ok)
    return ArchiveInitializationError(env, snapshot.get(), create);
  ArchiveSnapshot* owned = snapshot.release();
#if defined(LNWJUD_ARCHIVE_SNAPSHOT_TEST)
  if (create && archiveTestFault == 3) return ArchiveInitializationError(env, owned, create);
#endif
  if (api.create_function(env, "readAt", NAPI_AUTO_LENGTH, ArchiveRead, nullptr, &function) != napi_ok
    || api.set_property(env, result, "readAt", function) != napi_ok
    || (create && (api.create_function(env, "write", NAPI_AUTO_LENGTH, ArchiveWrite, nullptr, &function) != napi_ok
      || api.set_property(env, result, "write", function) != napi_ok
      || api.create_function(env, "seal", NAPI_AUTO_LENGTH, ArchiveSeal, nullptr, &function) != napi_ok
      || api.set_property(env, result, "seal", function) != napi_ok))
    || api.create_function(env, "discard", NAPI_AUTO_LENGTH, ArchiveDiscard, nullptr, &function) != napi_ok
    || api.set_property(env, result, "discard", function) != napi_ok
    || api.create_function(env, "close", NAPI_AUTO_LENGTH, ArchiveClose, nullptr, &function) != napi_ok
    || api.set_property(env, result, "close", function) != napi_ok) {
    return ArchiveInitializationError(env, owned, create);
  }
  return result;
}

static napi_value OpenArchiveSnapshot(napi_env env, napi_callback_info info) { return OpenArchive(env, info, false); }
static napi_value CreateArchiveSpool(napi_env env, napi_callback_info info) { return OpenArchive(env, info, true); }
