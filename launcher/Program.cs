using System.Diagnostics;
using System.Text.RegularExpressions;

const string LocalUrl = "http://localhost:3000";

Process? serverProcess = null;
Process? tunnelProcess = null;
var appRoot = FindAppRoot();
var publicUrlPath = Path.Combine(appRoot, ".omx", "public-base-url.txt");
Directory.CreateDirectory(Path.GetDirectoryName(publicUrlPath)!);
TryDelete(publicUrlPath);

Console.Title = "Multiplay Tier Maker";
Console.WriteLine("Multiplay Tier Maker launcher");
Console.WriteLine($"Project: {appRoot}");

if (!CommandExists("node"))
{
    Console.WriteLine("Node.js를 찾지 못했습니다. Node.js 설치 후 다시 실행해주세요.");
    Console.ReadLine();
    return;
}

if (!await IsHealthy())
{
    serverProcess = StartProcess("node", "server.js", appRoot, redirectOutput: false);
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
if (CommandExists("cloudflared"))
{
    var tunnelUrlSource = new TaskCompletionSource<string>();
    tunnelProcess = StartProcess("cloudflared", $"tunnel --url {LocalUrl}", appRoot, redirectOutput: true);
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
    Console.WriteLine("cloudflared를 찾지 못해 외부 공개 URL은 만들지 않았습니다.");
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

static bool CommandExists(string command)
{
    var paths = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator);
    var extensions = (Environment.GetEnvironmentVariable("PATHEXT") ?? ".EXE;.CMD;.BAT").Split(';');
    return paths.Any(path => extensions.Any(ext => File.Exists(Path.Combine(path, command + ext))));
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
