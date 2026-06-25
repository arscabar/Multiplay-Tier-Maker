using System.Diagnostics;
using System.Text.RegularExpressions;

const string LocalUrl = "http://localhost:3000";
const string CloudflaredDownloadUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";
const string CloudflaredDownloadsPageUrl = "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";

Process? serverProcess = null;
Process? tunnelProcess = null;
string appRoot;

try
{
    appRoot = FindAppRoot();
}
catch (Exception error)
{
    Console.Title = "Multiplay Tier Maker";
    Console.WriteLine("Multiplay Tier Maker launcher");
    Console.WriteLine(error.Message);
    Console.WriteLine("EXE 파일만 따로 실행하면 서버 파일을 찾을 수 없습니다.");
    Console.WriteLine("릴리즈 ZIP을 받은 뒤 압축을 모두 풀고, 그 폴더 안의 MultiplayTierMaker.exe를 실행하세요.");
    Console.ReadLine();
    return;
}

var publicUrlPath = Path.Combine(appRoot, ".omx", "public-base-url.txt");
var cloudflaredPathStorePath = Path.Combine(appRoot, ".omx", "cloudflared-path.txt");
Directory.CreateDirectory(Path.GetDirectoryName(publicUrlPath)!);
TryDelete(publicUrlPath);

Console.Title = "Multiplay Tier Maker";
Console.WriteLine("Multiplay Tier Maker launcher");
Console.WriteLine($"Project: {appRoot}");

var nodePath = ResolveNodePath(appRoot);
if (nodePath is null)
{
    Console.WriteLine("Node.js를 찾지 못했습니다.");
    Console.WriteLine("포터블 릴리즈 ZIP에는 tools\\node\\node.exe가 포함되어야 합니다.");
    Console.WriteLine("직접 실행하는 경우 Node.js 20 이상을 설치하거나 MULTIPLAY_NODE_PATH로 node.exe 경로를 지정하세요.");
    Console.ReadLine();
    return;
}

if (!await IsHealthy())
{
    serverProcess = StartProcess(nodePath, "server.js", appRoot, redirectOutput: false);
    Console.WriteLine("Starting local web server...");
    if (!await WaitForHealth(TimeSpan.FromSeconds(12)))
    {
        Console.WriteLine("서버 시작에 실패했습니다. 포트 3000이 이미 사용 중인지 확인해주세요.");
        Cleanup();
        Console.ReadLine();
        return;
    }
}

Console.WriteLine($"Local URL: {LocalUrl}");

var openUrl = LocalUrl;
var cloudflaredPath = ResolveCloudflaredPath(appRoot, cloudflaredPathStorePath);
if (cloudflaredPath is null)
{
    cloudflaredPath = await PromptForCloudflaredPath(appRoot, cloudflaredPathStorePath);
}

if (cloudflaredPath is not null)
{
    var tunnelUrlSource = new TaskCompletionSource<string>();
    tunnelProcess = StartProcess(cloudflaredPath, $"tunnel --url {LocalUrl}", appRoot, redirectOutput: true);
    _ = ReadTunnelOutput(tunnelProcess, tunnelUrlSource, publicUrlPath);

    Console.WriteLine("Starting free Cloudflare tunnel...");
    var completed = await Task.WhenAny(tunnelUrlSource.Task, Task.Delay(TimeSpan.FromSeconds(15)));
    if (completed == tunnelUrlSource.Task)
    {
        openUrl = tunnelUrlSource.Task.Result;
        Console.WriteLine($"Public URL: {openUrl}");
    }
    else
    {
        Console.WriteLine("Public tunnel URL is not ready yet. Local URL will open first.");
    }
}
else
{
    Console.WriteLine("Cloudflare Tunnel 없이 로컬 주소만 엽니다. 다른 인터넷에서는 접속할 수 없습니다.");
}

OpenBrowser(openUrl);
Console.WriteLine("Press Enter to stop the server and exit.");
Console.CancelKeyPress += (_, eventArgs) =>
{
    eventArgs.Cancel = true;
    Cleanup();
    Environment.Exit(0);
};
Console.ReadLine();
Cleanup();

static string FindAppRoot()
{
    var candidates = new[]
    {
        AppContext.BaseDirectory,
        Directory.GetCurrentDirectory(),
    };

    foreach (var candidate in candidates)
    {
        var current = new DirectoryInfo(candidate);
        while (current is not null)
        {
            if (File.Exists(Path.Combine(current.FullName, "server.js")))
            {
                return current.FullName;
            }
            current = current.Parent;
        }
    }

    throw new FileNotFoundException("server.js를 찾지 못했습니다. exe를 프로젝트 폴더 안에서 실행해주세요.");
}

static Process StartProcess(string fileName, string arguments, string workingDirectory, bool redirectOutput)
{
    var info = new ProcessStartInfo
    {
        FileName = fileName,
        Arguments = arguments,
        WorkingDirectory = workingDirectory,
        UseShellExecute = false,
        CreateNoWindow = true,
        RedirectStandardError = redirectOutput,
        RedirectStandardOutput = redirectOutput,
    };
    return Process.Start(info) ?? throw new InvalidOperationException($"{fileName} 실행에 실패했습니다.");
}

static string? ResolveNodePath(string appRoot)
{
    var candidates = new[]
    {
        Environment.GetEnvironmentVariable("MULTIPLAY_NODE_PATH"),
        Path.Combine(appRoot, "tools", "node", "node.exe"),
        Path.Combine(appRoot, "node", "node.exe"),
        Path.Combine(AppContext.BaseDirectory, "node.exe"),
        FindCommandPath("node"),
    };

    foreach (var candidate in candidates)
    {
        var path = CleanPath(candidate);
        if (path is not null && File.Exists(path)) return path;
    }

    return null;
}

static string? ResolveCloudflaredPath(string appRoot, string pathStorePath)
{
    var candidates = new[]
    {
        Environment.GetEnvironmentVariable("MULTIPLAY_CLOUDFLARED_PATH"),
        Environment.GetEnvironmentVariable("CLOUDFLARED_PATH"),
        ReadStoredPath(pathStorePath),
        Path.Combine(appRoot, "tools", "cloudflared.exe"),
        Path.Combine(appRoot, ".omx", "cloudflared.exe"),
        Path.Combine(AppContext.BaseDirectory, "cloudflared.exe"),
        FindCommandPath("cloudflared"),
    };

    foreach (var candidate in candidates)
    {
        var path = CleanPath(candidate);
        if (path is not null && File.Exists(path)) return path;
    }

    return null;
}

static async Task<string?> PromptForCloudflaredPath(string appRoot, string pathStorePath)
{
    Console.WriteLine();
    Console.WriteLine("cloudflared를 찾지 못했습니다.");
    Console.WriteLine("외부 친구와 접속하려면 Cloudflare Tunnel 프로그램이 필요합니다.");
    Console.WriteLine("1. 자동 다운로드해서 .omx\\cloudflared.exe에 저장");
    Console.WriteLine("2. cloudflared.exe 경로 직접 입력");
    Console.WriteLine("Enter. 로컬 주소만 열기");
    Console.WriteLine($"수동 설치 안내: {CloudflaredDownloadsPageUrl}");
    Console.Write("선택: ");

    var choice = Console.ReadLine()?.Trim() ?? "";
    if (string.IsNullOrWhiteSpace(choice))
    {
        return null;
    }

    if (choice.Equals("1", StringComparison.OrdinalIgnoreCase) || choice.Equals("download", StringComparison.OrdinalIgnoreCase))
    {
        return await DownloadCloudflared(appRoot);
    }

    if (choice.Equals("2", StringComparison.OrdinalIgnoreCase) || choice.Equals("path", StringComparison.OrdinalIgnoreCase))
    {
        return PromptForManualCloudflaredPath(pathStorePath);
    }

    var directPath = CleanPath(choice);
    if (directPath is not null && File.Exists(directPath))
    {
        SaveCloudflaredPath(pathStorePath, directPath);
        return directPath;
    }

    Console.WriteLine("입력한 값을 cloudflared.exe 경로로 사용할 수 없어 로컬 주소만 엽니다.");
    return null;
}

static async Task<string?> DownloadCloudflared(string appRoot)
{
    var targetPath = Path.Combine(appRoot, ".omx", "cloudflared.exe");
    try
    {
        Directory.CreateDirectory(Path.GetDirectoryName(targetPath)!);
        Console.WriteLine("cloudflared를 다운로드하는 중입니다...");
        using var client = new HttpClient { Timeout = TimeSpan.FromMinutes(3) };
        using var response = await client.GetAsync(CloudflaredDownloadUrl);
        response.EnsureSuccessStatusCode();
        await using var source = await response.Content.ReadAsStreamAsync();
        await using var target = File.Create(targetPath);
        await source.CopyToAsync(target);
        Console.WriteLine($"cloudflared 저장 완료: {targetPath}");
        return targetPath;
    }
    catch (Exception error)
    {
        Console.WriteLine($"cloudflared 자동 다운로드 실패: {error.Message}");
        Console.WriteLine($"직접 설치한 뒤 PATH에 추가하거나, 다음 실행에서 경로를 지정해주세요: {CloudflaredDownloadsPageUrl}");
        TryDelete(targetPath);
        return null;
    }
}

static string? PromptForManualCloudflaredPath(string pathStorePath)
{
    Console.Write("cloudflared.exe 전체 경로를 입력하세요: ");
    var path = CleanPath(Console.ReadLine());
    if (path is null || !File.Exists(path))
    {
        Console.WriteLine("파일을 찾지 못했습니다. 이번 실행은 로컬 주소만 엽니다.");
        return null;
    }

    SaveCloudflaredPath(pathStorePath, path);
    Console.WriteLine($"cloudflared 경로 저장: {path}");
    return path;
}

static void SaveCloudflaredPath(string pathStorePath, string path)
{
    try
    {
        Directory.CreateDirectory(Path.GetDirectoryName(pathStorePath)!);
        File.WriteAllText(pathStorePath, path);
    }
    catch
    {
    }
}

static string? ReadStoredPath(string pathStorePath)
{
    try
    {
        return File.Exists(pathStorePath) ? File.ReadAllText(pathStorePath) : null;
    }
    catch
    {
        return null;
    }
}

static string? CleanPath(string? path)
{
    var value = path?.Trim().Trim('"');
    return string.IsNullOrWhiteSpace(value) ? null : Environment.ExpandEnvironmentVariables(value);
}

static string? FindCommandPath(string command)
{
    var paths = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator);
    var extensions = (Environment.GetEnvironmentVariable("PATHEXT") ?? ".EXE;.CMD;.BAT").Split(';');
    foreach (var path in paths)
    {
        foreach (var extension in extensions)
        {
            var candidate = Path.Combine(path, command + extension);
            if (File.Exists(candidate)) return candidate;
        }
    }

    return null;
}

static async Task<bool> IsHealthy()
{
    try
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromMilliseconds(1200) };
        using var response = await client.GetAsync($"{LocalUrl}/healthz");
        return response.IsSuccessStatusCode;
    }
    catch
    {
        return false;
    }
}

static async Task<bool> WaitForHealth(TimeSpan timeout)
{
    var until = DateTime.UtcNow + timeout;
    while (DateTime.UtcNow < until)
    {
        if (await IsHealthy()) return true;
        await Task.Delay(350);
    }
    return false;
}

static async Task ReadTunnelOutput(Process process, TaskCompletionSource<string> urlSource, string publicUrlPath)
{
    var regex = new Regex(@"https://[-a-z0-9]+\.trycloudflare\.com", RegexOptions.IgnoreCase);

    async Task ReadStreamAsync(StreamReader reader)
    {
        while (!reader.EndOfStream)
        {
            var line = await reader.ReadLineAsync();
            if (line is null) break;
            var match = regex.Match(line);
            if (match.Success)
            {
                var url = match.Value.TrimEnd('/');
                await File.WriteAllTextAsync(publicUrlPath, url);
                urlSource.TrySetResult(url);
            }
        }
    }

    await Task.WhenAny(ReadStreamAsync(process.StandardError), ReadStreamAsync(process.StandardOutput));
}

static void OpenBrowser(string url)
{
    Process.Start(new ProcessStartInfo
    {
        FileName = url,
        UseShellExecute = true,
    });
}

void Cleanup()
{
    TryKill(tunnelProcess);
    TryKill(serverProcess);
    TryDelete(publicUrlPath);
}

static void TryKill(Process? process)
{
    try
    {
        if (process is { HasExited: false })
        {
            process.Kill(entireProcessTree: true);
        }
    }
    catch
    {
    }
}

static void TryDelete(string path)
{
    try
    {
        if (File.Exists(path)) File.Delete(path);
    }
    catch
    {
    }
}
