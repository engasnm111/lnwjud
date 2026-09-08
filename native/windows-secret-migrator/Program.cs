using System.Runtime.InteropServices;
using System.Security;
using System.Text;
using System.Text.Json;

namespace Lnwjud.WindowsSecretMigrator;

internal static class Program
{
    private const int MaxInputBytes = 64 * 1024;
    private const int MaxPlaintextBytes = 16 * 1024;
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false,
    };

    private static void Main()
    {
        string? line;
        while ((line = Console.ReadLine()) is not null)
        {
            object response;
            try
            {
                if (Encoding.UTF8.GetByteCount(line) > MaxInputBytes)
                {
                    response = Failure("INPUT_TOO_LARGE");
                }
                else
                {
                    using var document = JsonDocument.Parse(line);
                    response = Handle(document.RootElement);
                }
            }
            catch
            {
                // Do not expose DPAPI details, ciphertext, or plaintext through
                // the helper protocol. The TypeScript coordinator records only
                // the stable failure code.
                response = Failure("MIGRATION_FAILED");
            }

            Console.WriteLine(JsonSerializer.Serialize(response, JsonOptions));
            Console.Out.Flush();
        }
    }

    private static object Handle(JsonElement input)
    {
        if (input.ValueKind != JsonValueKind.Object
            || !input.TryGetProperty("op", out var op)
            || op.ValueKind != JsonValueKind.String)
        {
            return Failure("INVALID_INPUT");
        }

        var operation = op.GetString();
        byte[] protectedBytes;
        Encoding plaintextEncoding;
        if (operation == "dpapi_v2")
        {
            if (!input.TryGetProperty("ciphertextBase64", out var value) || value.ValueKind != JsonValueKind.String)
            {
                return Failure("INVALID_INPUT");
            }

            protectedBytes = Convert.FromBase64String(value.GetString() ?? string.Empty);
            plaintextEncoding = StrictUtf8;
        }
        else if (operation == "secure_string_v1")
        {
            if (!input.TryGetProperty("ciphertextHex", out var value) || value.ValueKind != JsonValueKind.String)
            {
                return Failure("INVALID_INPUT");
            }

            protectedBytes = DecodeHex(value.GetString() ?? string.Empty);
            plaintextEncoding = Encoding.Unicode;
        }
        else
        {
            return Failure("UNSUPPORTED_OPERATION");
        }

        if (protectedBytes.Length == 0 || protectedBytes.Length > MaxInputBytes)
        {
            return Failure("INPUT_TOO_LARGE");
        }

        var plaintextBytes = UnprotectCurrentUser(protectedBytes);
        if (plaintextBytes.Length == 0 || plaintextBytes.Length > MaxPlaintextBytes)
        {
            return Failure("PLAINTEXT_INVALID");
        }

        var plaintext = plaintextEncoding.GetString(plaintextBytes);
        if (string.IsNullOrWhiteSpace(plaintext)) return Failure("PLAINTEXT_INVALID");
        // Normalize only the line terminators PowerShell can append. Do not
        // trim user credentials or use them in diagnostics.
        plaintext = plaintext.TrimEnd('\r', '\n');
        if (plaintext.Length == 0) return Failure("PLAINTEXT_INVALID");

        var encoded = Convert.ToBase64String(StrictUtf8.GetBytes(plaintext));
        return new { ok = true, plaintextBase64 = encoded };
    }

    private static byte[] DecodeHex(string value)
    {
        if (value.Length == 0 || value.Length % 2 != 0 || value.Length > MaxInputBytes * 2)
        {
            throw new FormatException();
        }

        var result = new byte[value.Length / 2];
        for (var index = 0; index < result.Length; index++)
        {
            var high = HexValue(value[index * 2]);
            var low = HexValue(value[index * 2 + 1]);
            if (high < 0 || low < 0) throw new FormatException();
            result[index] = (byte)((high << 4) | low);
        }
        return result;
    }

    private static int HexValue(char value)
    {
        if (value is >= '0' and <= '9') return value - '0';
        if (value is >= 'a' and <= 'f') return value - 'a' + 10;
        if (value is >= 'A' and <= 'F') return value - 'A' + 10;
        return -1;
    }

    private static byte[] UnprotectCurrentUser(byte[] protectedBytes)
    {
        var input = new DataBlob(protectedBytes);
        var output = new DataBlob();
        try
        {
            if (!CryptUnprotectData(ref input, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, ref output))
            {
                throw new SecurityException();
            }

            if (output.cbData <= 0 || output.cbData > MaxPlaintextBytes || output.pbData == IntPtr.Zero)
            {
                throw new SecurityException();
            }

            var bytes = new byte[output.cbData];
            Marshal.Copy(output.pbData, bytes, 0, output.cbData);
            return bytes;
        }
        finally
        {
            if (input.pbData != IntPtr.Zero) Marshal.FreeHGlobal(input.pbData);
            if (output.pbData != IntPtr.Zero) LocalFree(output.pbData);
        }
    }

    private static object Failure(string code) => new
    {
        ok = false,
        error = new { code },
    };

    [StructLayout(LayoutKind.Sequential)]
    private struct DataBlob
    {
        public int cbData;
        public IntPtr pbData;

        public DataBlob(byte[] bytes)
        {
            cbData = bytes.Length;
            pbData = Marshal.AllocHGlobal(bytes.Length);
            Marshal.Copy(bytes, 0, pbData, bytes.Length);
        }
    }

    [DllImport("crypt32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptUnprotectData(
        ref DataBlob pDataIn,
        IntPtr ppszDataDescr,
        IntPtr pOptionalEntropy,
        IntPtr pvReserved,
        IntPtr pPromptStruct,
        int dwFlags,
        ref DataBlob pDataOut);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr hMem);
}
