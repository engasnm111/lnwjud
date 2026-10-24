using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Lnwjud.Containment;

internal static class ImportOperations
{
    internal static object Execute(string command, JsonElement request)
    {
        var workspace = Text(request, "workspaceRoot");
        var destination = Text(request, "destination");
        var commit = Text(request, "commit");
        if (!Regex.IsMatch(commit, "^(?:[a-f0-9]{40}|[a-f0-9]{64})$")) throw new IOException("IMPORT_INVALID_COMMIT");
        using var anchor = new RepositoryImportAnchor(workspace, destination, command == "publish_import");
        if (command == "inspect_publication")
            return Receipt("published", anchor.ReadPublishedIdentity(), commit);
        var stage = Text(request, "stagePath");
        if (!Path.IsPathFullyQualified(stage)
            || !String.Equals(Path.GetDirectoryName(Path.GetFullPath(stage)), Path.GetDirectoryName(Path.GetFullPath(workspace)), StringComparison.OrdinalIgnoreCase))
            throw new IOException("IMPORT_STAGE_SCOPE_INVALID");
        if (command == "prepare_import")
        {
            var identity = RepositoryImportAnchor.CreatePrivateStage(stage);
            if (anchor.PrepareStage(stage) != identity) throw new IOException("IMPORT_STAGE_IDENTITY_CHANGED");
            return Receipt("prepared", identity, commit);
        }
        if (command != "publish_import") throw new IOException("IMPORT_OPERATION_INVALID");
        var expected = Text(request, "expectedStageIdentity");
        if (!Regex.IsMatch(expected, "^[0-9A-F]{16}-[0-9A-F]{32}$")) throw new IOException("IMPORT_STAGE_IDENTITY_INVALID");
        ValidateCheckout(stage, commit, Text(request, "privateHome"));
        var actual = anchor.PrepareStage(stage);
        if (actual != expected) throw new IOException("IMPORT_STAGE_IDENTITY_CHANGED");
        anchor.Publish();
        if (anchor.ReadPublishedIdentity() != actual) throw new IOException("IMPORT_PUBLISHED_IDENTITY_CHANGED");
        return Receipt("published", actual, commit);
    }

    private static object Receipt(string state, string identity, string commit) => new { version = 2, state, nativeIdentity = identity, commit };

    internal static void ValidateCheckout(string stage, string commit, string home,
        Func<string, string[], string, IReadOnlyDictionary<string, string>, string>? capture = null)
    {
        var windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        var drive = Path.GetPathRoot(windows) ?? throw new IOException("IMPORT_TRUSTED_OS_PATH_UNAVAILABLE");
        var gitBin = Path.Combine(drive, "Program Files", "Git", "cmd");
        var git = Path.Combine(gitBin, "git.exe");
        if (!File.Exists(git) || !Path.IsPathFullyQualified(home)) throw new IOException("IMPORT_TRUSTED_GIT_UNAVAILABLE");
        var environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var name in new[] { "SystemRoot", "windir", "PATHEXT", "ComSpec", "TEMP", "TMP", "SystemDrive", "PROCESSOR_ARCHITECTURE" })
            if (Environment.GetEnvironmentVariable(name) is string value) environment[name] = value;
        environment["PATH"] = String.Join(';', Path.Combine(windows, "System32"), windows, gitBin);
        environment["HOME"] = home; environment["XDG_CONFIG_HOME"] = home;
        environment["GIT_CONFIG_NOSYSTEM"] = "1"; environment["GIT_CONFIG_GLOBAL"] = "NUL";
        environment["GIT_TERMINAL_PROMPT"] = "0"; environment["GCM_INTERACTIVE"] = "never";
        environment["GIT_CONFIG_COUNT"] = "0"; environment["GIT_OPTIONAL_LOCKS"] = "0";
        environment["GIT_LFS_SKIP_SMUDGE"] = "1"; environment["GIT_TRACE"] = "0";
        string Run(params string[] args)
        {
            string[] prefix = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=NUL", "-c", "credential.helper=", "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never", "-C", stage];
            return capture is null
                ? ContainedProcess.Capture(git, [.. prefix, .. args], home, environment, 30000, 16 * 1024 * 1024)
                : capture(git, [.. prefix, .. args], home, environment);
        }
        if (Run("rev-parse", "--verify", "HEAD").Trim().ToLowerInvariant() != commit) throw new IOException("IMPORT_STAGE_HEAD_CHANGED");
        foreach (var line in Run("ls-files", "-v", "-z").Split('\0', StringSplitOptions.RemoveEmptyEntries))
            if (line.Length < 2 || line[1] != ' ' || Char.IsLower(line[0]) || line[0] == 'S') throw new IOException("IMPORT_STAGE_INDEX_FLAGS_UNSAFE");
        if (Run("status", "--porcelain=v1", "--untracked-files=all").Length != 0) throw new IOException("IMPORT_STAGE_WORKTREE_CHANGED");
    }

    private static string Text(JsonElement request, string name)
    {
        if (!request.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String)
            throw new IOException("IMPORT_REQUEST_INVALID");
        var result = value.GetString();
        if (String.IsNullOrEmpty(result) || result.Length > 32768 || result.Contains('\0')) throw new IOException("IMPORT_REQUEST_INVALID");
        return result;
    }
}
