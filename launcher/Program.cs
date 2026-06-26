using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text.RegularExpressions;

const int PreferredPort = 8000;
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

var localPort = PreferredPort;
var localUrl = $"http://localhost:{localPort}";

var nodePath = ResolveNodePath(appRoot);
if (nodePath is null)
{
    Console.WriteLine("Node.js를 찾지 못했습니다.");
    Console.WriteLine("포터블 릴리즈 ZIP에는 tools\\node\\node.exe가 포함되어야 합니다.");
    Console.WriteLine("직접 실행하는 경우 Node.js 20 이상을 설치하거나 MULTIPLAY_NODE_PATH로 node.exe 경로를 지정하세요.");
    Console.ReadLine();
    return;
}

ReleasePort(localPort);
if (!IsPortAvailable(localPort))
{
    Console.WriteLine($"포트 {localPort}을 비우지 못했습니다. 관리자 권한이 필요하거나 보호된 프로세스가 사용 중일 수 있습니다.");
    Console.ReadLine();
    return;
}
serverProcess = StartProcess(
    nodePath,
    "server.js",
    appRoot,
    redirectOutput: false,
    new Dictionary<string, string> { ["PORT"] = localPort.ToString() }
);
Console.WriteLine("Starting local web server...");
if (!await WaitForHealth(localUrl, TimeSpan.FromSeconds(12)))
{
    Console.WriteLine($"서버 시작에 실패했습니다. 포트 {localPort} 사용 상태를 확인해주세요.");
    Cleanup();
    Console.ReadLine();
    return;
}

Console.WriteLine($"Local URL: {localUrl}");

var openUrl = localUrl;
var cloudflaredPath = ResolveCloudflaredPath(appRoot, cloudflaredPathStorePath);
if (cloudflaredPath is null)
{
    cloudflaredPath = await PromptForCloudflaredPath(appRoot, cloudflaredPathStorePath);
}

if (cloudflaredPath is not null)
{
    var tunnelUrlSource = new TaskCompletionSource<string>();
    var tunnelLogLines = new List<string>();
    tunnelProcess = StartProcess(cloudflaredPath, $"tunnel --url {localUrl}", appRoot, redirectOutput: true);
    _ = ReadTunnelOutput(tunnelProcess, tunnelUrlSource, publicUrlPath, tunnelLogLines);

    Console.WriteLine("Starting free Cloudflare tunnel... 공개 주소를 기다리는 중입니다.");
    var completed = await Task.WhenAny(tunnelUrlSource.Task, WaitForProcessExit(tunnelProcess), Task.Delay(TimeSpan.FromSeconds(60)));
    if (completed == tunnelUrlSource.Task)
    {
        openUrl = tunnelUrlSource.Task.Result;
        Console.WriteLine($"Public URL: {openUrl}");
    }
    else if (tunnelProcess.HasExited)
    {
        Console.WriteLine($"Cloudflare Tunnel 실행이 실패했습니다. ExitCode: {tunnelProcess.ExitCode}");
        PrintTunnelLog(tunnelLogLines);
        Console.WriteLine("로컬 주소만 엽니다. 다른 인터넷에서는 접속할 수 없습니다.");
    }
    else
    {
        Console.WriteLine("60초 안에 공개 주소가 만들어지지 않았습니다.");
        PrintTunnelLog(tunnelLogLines);
        Console.WriteLine("로컬 주소만 엽니다. 네트워크나 방화벽이 Cloudflare Tunnel 연결을 막는지 확인하세요.");
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

static Process StartProcess(
    string fileName,
    string arguments,
    string workingDirectory,
    bool redirectOutput,
    IReadOnlyDictionary<string, string>? environment = null
)
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
    if (environment is not null)
    {
        foreach (var pair in environment)
        {
            info.Environment[pair.Key] = pair.Value;
        }
    }
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

static bool IsPortAvailable(int port)
{
    try
    {
        using var listener = new TcpListener(IPAddress.Loopback, port);
        listener.Start();
        return true;
    }
    catch
    {
        return false;
    }
}

static void ReleasePort(int port, bool quiet = false)
{
    var listenerPids = GetPortListenerProcessIds(port)
        .Where((pid) => pid > 0 && pid != Environment.ProcessId)
        .Distinct()
        .ToList();

    if (listenerPids.Count == 0)
    {
        if (!quiet) Console.WriteLine($"Port {port} is available.");
        return;
    }

    if (!quiet)
    {
        Console.WriteLine($"Port {port} is already in use. Stopping {listenerPids.Count} listener process(es)...");
    }

    foreach (var pid in listenerPids)
    {
        TryKillProcessById(pid, quiet);
    }

    var until = DateTime.UtcNow + TimeSpan.FromSeconds(8);
    while (DateTime.UtcNow < until)
    {
        if (GetPortListenerProcessIds(port).Count == 0 && IsPortAvailable(port)) return;
        Thread.Sleep(250);
    }

    if (!quiet)
    {
        Console.WriteLine($"Port {port} is still busy after cleanup.");
    }
}

static List<int> GetPortListenerProcessIds(int port)
{
    try
    {
        var info = new ProcessStartInfo
        {
            FileName = "netstat",
            Arguments = "-ano -p tcp",
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        using var process = Process.Start(info);
        if (process is null) return [];

        var output = process.StandardOutput.ReadToEnd();
        process.WaitForExit(3000);

        var pids = new List<int>();
        foreach (var rawLine in output.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries))
        {
            var line = rawLine.Trim();
            if (!line.StartsWith("TCP", StringComparison.OrdinalIgnoreCase)) continue;

            var parts = Regex.Split(line, @"\s+");
            if (parts.Length < 5) continue;
            if (!parts[3].Equals("LISTENING", StringComparison.OrdinalIgnoreCase)) continue;
            if (!EndpointUsesPort(parts[1], port)) continue;
            if (int.TryParse(parts[4], out var pid)) pids.Add(pid);
        }
        return pids;
    }
    catch
    {
        return [];
    }
}

static bool EndpointUsesPort(string endpoint, int port)
{
    var lastColon = endpoint.LastIndexOf(':');
    if (lastColon < 0 || lastColon >= endpoint.Length - 1) return false;
    return int.TryParse(endpoint[(lastColon + 1)..], out var endpointPort) && endpointPort == port;
}

static void TryKillProcessById(int pid, bool quiet = false)
{
    try
    {
        using var process = Process.GetProcessById(pid);
        if (!quiet)
        {
            Console.WriteLine($"Stopping PID {pid} ({process.ProcessName})...");
        }
        process.Kill(entireProcessTree: true);
        process.WaitForExit(5000);
    }
    catch (Exception error)
    {
        if (!quiet)
        {
            Console.WriteLine($"PID {pid} 종료 실패: {error.Message}");
        }
    }
}

static async Task<bool> IsHealthy(string localUrl)
{
    try
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromMilliseconds(1200) };
        using var response = await client.GetAsync($"{localUrl}/healthz");
        if (!response.IsSuccessStatusCode) return false;
        var body = await response.Content.ReadAsStringAsync();
        return Regex.IsMatch(body, @"""ok""\s*:\s*true", RegexOptions.IgnoreCase);
    }
    catch
    {
        return false;
    }
}

static async Task<bool> WaitForHealth(string localUrl, TimeSpan timeout)
{
    var until = DateTime.UtcNow + timeout;
    while (DateTime.UtcNow < until)
    {
        if (await IsHealthy(localUrl)) return true;
        await Task.Delay(350);
    }
    return false;
}

static async Task WaitForProcessExit(Process process)
{
    try
    {
        await process.WaitForExitAsync();
    }
    catch
    {
    }
}

static async Task ReadTunnelOutput(Process process, TaskCompletionSource<string> urlSource, string publicUrlPath, List<string> logLines)
{
    var regex = new Regex(@"https://[-a-z0-9]+\.trycloudflare\.com", RegexOptions.IgnoreCase);

    async Task ReadStreamAsync(StreamReader reader)
    {
        while (!reader.EndOfStream)
        {
            var line = await reader.ReadLineAsync();
            if (line is null) break;
            lock (logLines)
            {
                logLines.Add(line);
                if (logLines.Count > 24) logLines.RemoveAt(0);
            }
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

static void PrintTunnelLog(List<string> logLines)
{
    List<string> snapshot;
    lock (logLines)
    {
        snapshot = logLines.ToList();
    }

    if (snapshot.Count == 0) return;
    Console.WriteLine("Cloudflare Tunnel log:");
    foreach (var line in snapshot.TakeLast(12))
    {
        Console.WriteLine(line);
    }
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
    ReleasePort(PreferredPort, quiet: true);
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
