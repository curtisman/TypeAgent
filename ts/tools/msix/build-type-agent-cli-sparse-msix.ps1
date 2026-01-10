<#
.SYNOPSIS
Builds a sparse (external location) MSIX identity package for TypeAgent CLI.

.DESCRIPTION
1) Builds a Windows executable for the TypeAgent CLI (Oclif-based, SEA-based node executable).
2) Generates an MSIX (identity-only) package with AllowExternalContent=true.
3) Registers a protocol handler for the `type-agent:` scheme that launches:
     type-agent-cli.exe connect --uri "%1"
4) Registers an AppExecutionAlias so launching `type-agent-cli.exe` runs with package identity.
5) Adds an Agent Launcher app extension entry (com.microsoft.windows.ai.appAgent) and emits an `agentRegistration.json`.

By default, this script performs a **pack-only** build (produces the `.msix` and staged assets).
Signing and installation are opt-in:
- Pass `-Sign -PfxPath ...` to sign the MSIX.
- Pass `-Register` to install/register the sparse package with `Add-AppxPackage -ExternalLocation ...`.

IMPORTANT: In a sparse (external location) package, the MSIX is **identity-only**. The `.msix` will
contain the manifest + assets, but **not** the external Win32 executable. The executable is placed
in the `ExternalLocation` folder (default: `<OutDir>\bin`) and is associated with package identity
via a side-by-side manifest (`type-agent-cli.exe.manifest`).

SEA injection note:
- Default `-InjectionMethod postject` uses `postject` to inject the SEA blob and flip the SEA fuse.
    This is the normal, reliable way to do SEA without brittle binary patching.
- In this environment, `postject` is not compatible with Node 22+. Use Node 20.x (recommended) or
    pass `-InjectionMethod resource` to use the fallback resource-based injector.

This script follows Microsoft guidance for packaging with external location and packaging extensions.

.NOTES
- Requires Node >= 20 (repo already targets this)
- Requires Windows 10 SDK (MakeAppx.exe). Signing requires SignTool.exe.

#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string] $TsRoot = (Join-Path $PSScriptRoot ".." ".."),

    [Parameter(Mandatory = $false)]
    [string] $OutDir = (Join-Path $PSScriptRoot ".." ".." ".." "artifacts" "type-agent-cli-msix"),

    [Parameter(Mandatory = $false)]
    [string] $ExternalLocation,

    [Parameter(Mandatory = $false)]
    [ValidateNotNullOrEmpty()]
    [string] $PackageName = "TypeAgent.Cli",

    [Parameter(Mandatory = $false)]
    [ValidateNotNullOrEmpty()]
    [string] $Publisher = "CN=TypeAgent",

    [Parameter(Mandatory = $false)]
    [ValidateNotNullOrEmpty()]
    [string] $Version = "0.0.1.0",

    [Parameter(Mandatory = $false)]
    [string] $DisplayName = "TypeAgent CLI",

    [Parameter(Mandatory = $false)]
    [string] $PublisherDisplayName = "TypeAgent",

    [Parameter(Mandatory = $false)]
    [string] $ProtocolName = "type-agent",

    [Parameter(Mandatory = $false)]
    [string] $ActionProtocolName = "typeagent-action",

    [Parameter(Mandatory = $false)]
    [string] $ExeName = "type-agent-cli.exe",

    [Parameter(Mandatory = $false)]
    [string] $AppId = "TypeAgentCli",

    [Parameter(Mandatory = $false)]
    [int] $DefaultPort = 8999,

    [Parameter(Mandatory = $false)]
    [string] $PfxPath,

    [Parameter(Mandatory = $false)]
    [string] $PfxPassword,

    [Parameter(Mandatory = $false)]
    [switch] $Sign,

    [Parameter(Mandatory = $false)]
    [switch] $Register

    ,
    [Parameter(Mandatory = $false)]
    [ValidateSet("postject", "resource")]
    [string] $InjectionMethod = "postject"

    ,
    [Parameter(Mandatory = $false)]
    [ValidateSet("minimal", "oclif")]
    [string] $EntryMode = "oclif"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-FullPath([string] $p) {
    return [System.IO.Path]::GetFullPath($p)
}

function Find-WindowsSdkTool([string] $toolName) {
    $kitsRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
    if (-not (Test-Path $kitsRoot)) {
        throw "Windows SDK not found at: $kitsRoot"
    }

    $candidates = Get-ChildItem -Path $kitsRoot -Directory -ErrorAction Stop |
        Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
        Sort-Object Name -Descending |
        ForEach-Object {
            $p = Join-Path $_.FullName "x64\$toolName"
            if (Test-Path $p) { $p }
        }

    $first = $candidates | Select-Object -First 1
    if (-not $first) {
        throw "Could not locate $toolName under $kitsRoot"
    }
    return $first
}

function Write-FileUtf8NoBom([string] $path, [string] $content) {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $content, $utf8NoBom)
}

function Ensure-Dir([string] $dir) {
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir | Out-Null
    }
}

function Invoke-Checked([string] $file, [string[]] $arguments, [string] $cwd) {
    Write-Host "> $file $($arguments -join ' ')" -ForegroundColor DarkGray

    # Use the call operator instead of Start-Process so we can invoke PowerShell shims
    # like pnpm.ps1 on Windows (Start-Process would fail with "%1 is not a valid Win32 application").
    #
    # IMPORTANT: Do not mutate the caller's working directory. Many callers already pass absolute
    # paths (or pnpm -C), and changing location can fail depending on the host/session.
    $global:LASTEXITCODE = 0
    & $file @arguments
    $success = $?
    $exitCode = $global:LASTEXITCODE
    if (-not $success -or $exitCode -ne 0) {
        throw "Command failed (exit $exitCode): $file $($arguments -join ' ')"
    }
}

function Get-RelativeImportPath([string] $fromDir, [string] $toFile) {
        $rel = [System.IO.Path]::GetRelativePath($fromDir, $toFile)
        $rel = $rel.Replace('\\', '/')
        if (-not ($rel.StartsWith('./') -or $rel.StartsWith('../'))) {
                $rel = './' + $rel
        }
        return $rel
}

function Write-SeaEntrySource([string] $entryMode, [string] $tsRoot, [string] $writeDir) {
    $entryPath = Join-Path $writeDir ("sea-entry-" + [Guid]::NewGuid().ToString("N") + ".ts")

        if ($entryMode -eq "oclif") {
                $content = @'
import { run } from "@oclif/core";
import * as fs from "node:fs";
import * as path from "node:path";

function isUriLike(value: string): boolean {
    return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value);
}

function findCliRoot(startDir: string): string | undefined {
    let dir = startDir;
    for (let i = 0; i < 10; i++) {
        const candidate1 = path.join(dir, "ts", "packages", "cli", "package.json");
        if (fs.existsSync(candidate1)) return path.dirname(candidate1);

        const candidate2 = path.join(dir, "packages", "cli", "package.json");
        if (fs.existsSync(candidate2)) return path.dirname(candidate2);

        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return undefined;
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);

    // Allow launching directly as: type-agent-cli.exe type-agent://?request=...
    // (protocol activation often passes the URI as the first argument)
    if (argv.length >= 1 && isUriLike(argv[0])) {
        argv.unshift("connect", "--uri");
    }

    const exeDir = path.dirname(process.execPath);
    const root = findCliRoot(exeDir);
    if (!root) {
        // eslint-disable-next-line no-console
        console.error(
            "Could not locate agent-cli root (packages/cli/package.json). " +
                "For -EntryMode oclif, the CLI package must be present on disk near the executable (e.g. inside a repo checkout)."
        );
        process.exitCode = 1;
        return;
    }

    await run(argv, { root });
}

void main();
'@

                Write-FileUtf8NoBom $entryPath $content
                return $entryPath
        }

        # minimal
        $content = @'
import { connectDispatcher } from "@typeagent/agent-server-client";
import { DisplayAppendMode, DisplayContent } from "@typeagent/agent-sdk";
import {
    ClientIO,
    IAgentMessage,
    RequestId,
    TemplateEditConfig,
} from "@typeagent/dispatcher-types";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

type ParsedArgs = {
    command: "connect" | "help" | "version";
    request?: string;
    uri?: string;
    exit: boolean;
    port: number;
    inputFile?: string;
};

function isUriLike(value: string): boolean {
    return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value);
}

function parseArgs(argv: string[]): ParsedArgs {
    const args = [...argv];

    if (args.length >= 1 && (args[0] === "--help" || args[0] === "-h" || args[0] === "help")) {
        return { command: "help", exit: true, port: 8999 };
    }
    if (args.length >= 1 && (args[0] === "--version" || args[0] === "version")) {
        return { command: "version", exit: true, port: 8999 };
    }

    // Allow launching directly as: type-agent-cli.exe type-agent://?request=...
    if (args.length >= 1 && isUriLike(args[0])) {
        args.unshift("connect", "--uri");
    }

    const command = (args.shift() ?? "connect") as string;
    if (command !== "connect") {
        if (command === "help") return { command: "help", exit: true, port: 8999 };
        if (command === "version") return { command: "version", exit: true, port: 8999 };
        throw new Error(`Unsupported command: ${command}`);
    }

    const parsed: ParsedArgs = { command: "connect", exit: true, port: 8999 };

    while (args.length > 0) {
        const token = args.shift()!;
        if (token === "--help" || token === "-h") {
            return { command: "help", exit: true, port: parsed.port };
        }
        if (token === "--request") {
            const value = args.shift();
            if (!value) throw new Error("--request requires a value");
            parsed.request = value;
        } else if (token === "--uri") {
            const value = args.shift();
            if (!value) throw new Error("--uri requires a value");
            parsed.uri = value;
        } else if (token === "--port") {
            const value = args.shift();
            if (!value) throw new Error("--port requires a value");
            const port = Number(value);
            if (!Number.isFinite(port) || port <= 0) throw new Error(`Invalid --port value: ${value}`);
            parsed.port = port;
        } else if (token === "--exit") {
            parsed.exit = true;
        } else if (token === "--no-exit") {
            parsed.exit = false;
        } else if (token.startsWith("-")) {
            throw new Error(`Unknown option: ${token}`);
        } else if (!parsed.inputFile) {
            parsed.inputFile = token;
        } else {
            throw new Error(`Unexpected extra argument: ${token}`);
        }
    }

    return parsed;
}

function printUsage(): void {
    // eslint-disable-next-line no-console
    console.log(
        [
            "TypeAgent CLI (minimal Windows host)",
            "",
            "Usage:",
            "  type-agent-cli.exe connect [--request <text>] [--uri <type-agent://?request=...>] [--port <n>] [--no-exit] [<inputFile>]",
            "",
            "Notes:",
            "  - Protocol activation may pass the URI as the first argument.",
            "  - The default server URL is ws://localhost:8999.",
        ].join("\n"),
    );
}

function printAgentMessage(message: IAgentMessage): void {
    const rendered = renderDisplay(message);
    const text = rendered.text.trimEnd();
    // eslint-disable-next-line no-console
    (rendered.isError ? console.error : console.log)(text);
}

function renderDisplay(message: IAgentMessage): { text: string; isError: boolean } {
    const rendered = renderDisplayContent(message.message);

    const needsPrefix =
        typeof message.message === "string" &&
        !!message.source &&
        message.message.trim().length > 0;

    const prefix = needsPrefix ? `[${message.source}] ` : "";
    return { text: prefix + rendered.text, isError: rendered.isError };
}

function renderDisplayContent(content: DisplayContent): { text: string; isError: boolean } {
    if (typeof content === "string") return { text: content, isError: false };
    if (!content || typeof content !== "object") return { text: String(content), isError: false };

    const maybeText = content as any;
    if (maybeText.type === "text" && typeof maybeText.content === "string") {
        return { text: maybeText.content, isError: maybeText.kind === "error" };
    }
    if (typeof maybeText.content === "string") {
        return { text: maybeText.content, isError: maybeText.kind === "error" };
    }

    try {
        return { text: JSON.stringify(content, null, 2), isError: false };
    } catch {
        return { text: String(content), isError: false };
    }
}

async function runConnect(parsed: ParsedArgs): Promise<void> {
    const rl = createInterface({ input, output });

    const clientIO: ClientIO = {
        clear() {
            // eslint-disable-next-line no-console
            console.clear();
        },
        exit() {
            process.exit(0);
        },
        setDisplayInfo() {},
        setDisplay(message: IAgentMessage) {
            printAgentMessage(message);
        },
        appendDisplay(message: IAgentMessage, _mode: DisplayAppendMode) {
            printAgentMessage(message);
        },
        appendDiagnosticData(_requestId: RequestId, data: any) {
            // eslint-disable-next-line no-console
            console.log(data);
        },
        setDynamicDisplay() {},
        async askYesNo(message: string, _requestId: RequestId, defaultValue?: boolean) {
            const suffix = defaultValue === undefined ? "[y/n]" : defaultValue ? "[Y/n]" : "[y/N]";
            while (true) {
                const answer = (await rl.question(`${message} ${suffix} `)).trim().toLowerCase();
                if (!answer && defaultValue !== undefined) return defaultValue;
                if (answer === "y" || answer === "yes") return true;
                if (answer === "n" || answer === "no") return false;
            }
        },
        async proposeAction(_actionTemplates: TemplateEditConfig, _requestId: RequestId, _source: string) {
            throw new Error("proposeAction is not supported in this minimal CLI host");
        },
        async popupQuestion(message: string, choices: string[], defaultId: number | undefined) {
            // eslint-disable-next-line no-console
            console.log(message);
            for (let i = 0; i < choices.length; i++) {
                // eslint-disable-next-line no-console
                console.log(`  ${i}: ${choices[i]}`);
            }
            const prompt = defaultId === undefined ? "Choice: " : `Choice (${defaultId}): `;
            while (true) {
                const raw = (await rl.question(prompt)).trim();
                if (!raw && defaultId !== undefined) return defaultId;
                const n = Number(raw);
                if (Number.isInteger(n) && n >= 0 && n < choices.length) return n;
            }
        },
        notify(event: string, _requestId: RequestId, data: any, source: string) {
            // eslint-disable-next-line no-console
            console.log(`[${source}] ${event}`, data ?? "");
        },
        openLocalView(_port: number) {},
        closeLocalView(_port: number) {},
        takeAction(_action: string, _data: unknown) {},
    };

    const dispatcher = await connectDispatcher(clientIO, `ws://localhost:${parsed.port}`);
    try {
        let processed = false;

        if (parsed.request) {
            await dispatcher.processCommand(parsed.request);
            processed = true;
        }

        if (parsed.uri) {
            const url = new URL(parsed.uri);
            const request = url.searchParams.get("request");
            if (request) {
                await dispatcher.processCommand(request);
                processed = true;
            } else {
                throw new Error("No request found in URI");
            }
        }

        if (parsed.inputFile) {
            await dispatcher.processCommand(`@run ${parsed.inputFile}`);
            processed = true;
        }

        if (processed && parsed.exit) return;

        while (true) {
            const line = await rl.question("> ");
            const command = line.trim();
            if (!command) continue;
            await dispatcher.processCommand(command);
        }
    } finally {
        await dispatcher.close();
        rl.close();
    }
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    try {
        const parsed = parseArgs(argv);
        if (parsed.command === "help") {
            printUsage();
            return;
        }
        if (parsed.command === "version") {
            // eslint-disable-next-line no-console
            console.log("TypeAgent CLI (minimal Windows host)");
            return;
        }
        await runConnect(parsed);
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // eslint-disable-next-line no-console
        console.error(message);
        process.exitCode = 1;
    } finally {
        process.exit();
    }
}

void main();
'@

        Write-FileUtf8NoBom $entryPath $content
        return $entryPath
}

function Build-SeaExe([string] $tsRoot, [string] $outDir, [string] $exeName, [string] $entryMode) {
    Ensure-Dir $outDir

    # Use a unique temp directory per run to avoid issues with locked files from prior attempts.
    $tmpBase = Join-Path $outDir "_tmp"
    if (Test-Path $tmpBase) {
        try {
            Remove-Item -Recurse -Force $tmpBase -ErrorAction Stop
        }
        catch {
            Write-Warning "Could not remove existing temp dir '$tmpBase' (will use a new one). $($_.Exception.Message)"
        }
    }

    $tmp = Join-Path $outDir ("_tmp-" + [Guid]::NewGuid().ToString("N"))
    Ensure-Dir $tmp

    $entryWriteDir = $tmp
    $cleanupEntryDir = $false
    $entryDirToCleanup = $null
    if ($entryMode -eq "oclif") {
        # Ensure Node/esbuild module resolution can find @oclif/core (installed under packages/cli/node_modules).
        # Node resolution walks up parent directories only, so the entry file must live under packages/cli.
        $entryWriteDir = Join-Path $tsRoot "packages\cli\.sea-tmp"
        Ensure-Dir $entryWriteDir
        $cleanupEntryDir = $true
        $entryDirToCleanup = $entryWriteDir
    }

    $seaEntry = Write-SeaEntrySource -entryMode $entryMode -tsRoot $tsRoot -writeDir $entryWriteDir

    # Bundle the minimal CLI host into a single JS file for SEA.
    $bundleOut = Join-Path $tmp "sea-entry.js"

    # esbuild doesn't always treat Node built-in subpath modules (e.g. "readline/promises") as built-ins.
    # Externalize them so Node resolves them at runtime.
    $esbuildExternals = @(
        "readline/promises",
        "fs/promises",
        "stream/promises",
        "timers/promises"
    )
    $externalArgs = @()
    foreach ($m in $esbuildExternals) {
        $externalArgs += "--external:$m"
    }

    $esbuildArgs = @(
        "-C", $tsRoot, "dlx", "esbuild",
        $seaEntry,
        "--bundle",
        "--platform=node",
        "--format=cjs",
        "--target=node20",
        "--outfile=$bundleOut"
    ) + $externalArgs

    Invoke-Checked "pnpm" $esbuildArgs $tsRoot

    if ($cleanupEntryDir) {
        try {
            Remove-Item -Force $seaEntry -ErrorAction Stop
        }
        catch {
            Write-Warning "Failed to remove temporary SEA entry '$seaEntry'. $($_.Exception.Message)"
        }

        if ($entryDirToCleanup) {
            try {
                $remaining = Get-ChildItem -LiteralPath $entryDirToCleanup -Force -ErrorAction Stop
                if ($remaining.Count -eq 0) {
                    Remove-Item -LiteralPath $entryDirToCleanup -Force -ErrorAction Stop
                }
            }
            catch {
                # Best-effort cleanup only.
            }
        }
    }

    $seaConfigPath = Join-Path $tmp "sea-config.json"
    $seaBlobPath = Join-Path $tmp "sea-prep.blob"

    $seaConfig = @{
        main   = (Resolve-FullPath $bundleOut)
        output = (Resolve-FullPath $seaBlobPath)
    } | ConvertTo-Json
    Write-FileUtf8NoBom $seaConfigPath $seaConfig

    # Create SEA blob.
    Invoke-Checked "node" @("--experimental-sea-config", (Resolve-FullPath $seaConfigPath)) $tsRoot

    $nodePath = (Get-Command node).Source
    $exePath = Join-Path $outDir $exeName

    Copy-Item -Force $nodePath $exePath

    if ($InjectionMethod -eq "postject") {
        Assert-NodeSeaPostjectCompatible
        # postject handles BOTH embedding the blob and blowing the SEA fuse.
        Invoke-Checked "pnpm" @(
            "-C", $tsRoot, "dlx", "postject",
            (Resolve-FullPath $exePath),
            "NODE_SEA_BLOB",
            (Resolve-FullPath $seaBlobPath),
            "--sentinel-fuse",
            "NODE_SEA_FUSE",
            "--overwrite"
        ) $tsRoot
    }
    else {
        # Fallback path (not recommended unless postject is unavailable): embed blob as a Win32 resource
        # and flip the fuse manually.
        Add-SeaBlobResource -exePath $exePath -blobPath $seaBlobPath -resourceName "NODE_SEA_BLOB"
        Set-SeaFuse -exePath $exePath
    }

    # Side-by-side manifest that binds the executable to the MSIX identity.
    return $exePath
}

function Assert-NodeSeaPostjectCompatible() {
    # postject currently has compatibility issues on some environments with Node 22+.
    # Require Node 20.x by default for a predictable SEA pipeline.
    $ver = & node -p "process.versions.node" 2>$null
    if (-not $ver) {
        return
    }
    $major = [int]($ver.Split('.')[0])
    if ($major -ge 22) {
        throw "Node $ver detected. SEA injection via postject is known to fail on Node 22+ in this environment. Install/use Node 20.x (e.g. 20.17+) or rerun with -InjectionMethod resource."
    }
}

function Add-SeaBlobResource(
    [Parameter(Mandatory = $true)]
    [string] $exePath,
    [Parameter(Mandatory = $true)]
    [string] $blobPath,
    [Parameter(Mandatory = $true)]
    [string] $resourceName
) {
    if (-not (Test-Path $exePath)) {
        throw "Exe not found: $exePath"
    }
    if (-not (Test-Path $blobPath)) {
        throw "SEA blob not found: $blobPath"
    }

    if (-not ("SeaResourceUpdater" -as [type])) {
        Add-Type -Language CSharp -TypeDefinition @"
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

public static class SeaResourceUpdater
{
    private const int RT_RCDATA = 10;

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr BeginUpdateResourceW(string pFileName, [MarshalAs(UnmanagedType.Bool)] bool bDeleteExistingResources);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool UpdateResourceW(IntPtr hUpdate, IntPtr lpType, string lpName, ushort wLanguage, byte[] lpData, uint cbData);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool EndUpdateResourceW(IntPtr hUpdate, [MarshalAs(UnmanagedType.Bool)] bool fDiscard);

    public static void AddRcDataResource(string exePath, string resourceName, byte[] data)
    {
        IntPtr h = BeginUpdateResourceW(exePath, false);
        if (h == IntPtr.Zero)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "BeginUpdateResource failed");

        try
        {
            // Neutral language
            const ushort LANG_NEUTRAL = 0;
            if (!UpdateResourceW(h, (IntPtr)RT_RCDATA, resourceName, LANG_NEUTRAL, data, (uint)data.Length))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "UpdateResource failed");

            if (!EndUpdateResourceW(h, false))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "EndUpdateResource failed");
        }
        catch
        {
            EndUpdateResourceW(h, true);
            throw;
        }
    }
}
"@
    }

    $data = [System.IO.File]::ReadAllBytes((Resolve-FullPath $blobPath))
    [SeaResourceUpdater]::AddRcDataResource((Resolve-FullPath $exePath), $resourceName, $data)
}

function Set-SeaFuse(
    [Parameter(Mandatory = $true)]
    [string] $exePath
) {
    $bytes = [System.IO.File]::ReadAllBytes((Resolve-FullPath $exePath))
    $needle = [System.Text.Encoding]::ASCII.GetBytes("NODE_SEA_FUSE_")

    $found = $false
    for ($i = 0; $i -le $bytes.Length - $needle.Length; $i++) {
        $ok = $true
        for ($j = 0; $j -lt $needle.Length; $j++) {
            if ($bytes[$i + $j] -ne $needle[$j]) { $ok = $false; break }
        }
        if (-not $ok) { continue }

        # Look for the ':0\0' marker within a small window after the sentinel.
        $windowEnd = [Math]::Min($bytes.Length - 3, $i + 256)
        for ($k = $i; $k -le $windowEnd; $k++) {
            if ($bytes[$k] -eq 0x3A -and $bytes[$k + 1] -eq 0x30 -and $bytes[$k + 2] -eq 0x00) {
                $bytes[$k + 1] = 0x31
                $found = $true
                break
            }
        }

        if ($found) { break }
    }

    if (-not $found) {
        throw "Could not locate NODE_SEA_FUSE marker in: $exePath"
    }

    [System.IO.File]::WriteAllBytes((Resolve-FullPath $exePath), $bytes)
}

function Write-IdentitySideBySideManifest(
    [string] $exePath,
    [string] $packageName,
    [string] $publisher,
    [string] $applicationId
) {
    $manifestPath = "$exePath.manifest"
    $xml = @"
<?xml version="1.0" encoding="utf-8"?>
<assembly manifestVersion="1.0" xmlns="urn:schemas-microsoft-com:asm.v1">
  <assemblyIdentity version="0.0.0.0" name="$packageName"/>
  <msix xmlns="urn:schemas-microsoft-com:msix.v1"
        publisher="$publisher"
        packageName="$packageName"
        applicationId="$applicationId" />
</assembly>
"@
    Write-FileUtf8NoBom $manifestPath $xml
    return $manifestPath
}

function Write-MinimalPng([string] $path) {
    # 1x1 transparent PNG
    $b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/xcAAn8B9p5oYQAAAABJRU5ErkJggg=="
    $bytes = [Convert]::FromBase64String($b64)
    [System.IO.File]::WriteAllBytes($path, $bytes)
}

function Write-AppxManifest(
    [string] $path,
    [string] $packageName,
    [string] $publisher,
    [string] $version,
    [string] $displayName,
    [string] $publisherDisplayName,
    [string] $appId,
    [string] $exeName,
    [string] $protocolName,
    [string] $actionProtocolName
) {
    $protocolParams = "connect --uri &quot;%1&quot;"

    $xml = @"
<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:uap3="http://schemas.microsoft.com/appx/manifest/uap/windows10/3"
  xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10"
  xmlns:desktop="http://schemas.microsoft.com/appx/manifest/desktop/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap uap3 uap10 desktop rescap">

  <Identity Name="$packageName" Publisher="$publisher" Version="$version" ProcessorArchitecture="neutral" />

  <Properties>
    <DisplayName>$displayName</DisplayName>
    <PublisherDisplayName>$publisherDisplayName</PublisherDisplayName>
    <Logo>Assets\storelogo.png</Logo>
    <uap10:AllowExternalContent>true</uap10:AllowExternalContent>
  </Properties>

  <Resources>
    <Resource Language="en-us" />
  </Resources>

  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>

  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
    <rescap:Capability Name="unvirtualizedResources" />
  </Capabilities>

  <Applications>
        <Application Id="$appId" Executable="$exeName" uap10:TrustLevel="mediumIL" uap10:RuntimeBehavior="win32App">
      <uap:VisualElements
        AppListEntry="none"
        DisplayName="$displayName"
        Description="$displayName"
        BackgroundColor="transparent"
        Square150x150Logo="Assets\Square150x150Logo.png"
        Square44x44Logo="Assets\Square44x44Logo.png" />

      <Extensions>
                <!-- App Actions (URI launch) requires registering a protocol-for-results -->
                <uap:Extension Category="windows.protocol">
                    <uap:Protocol Name="$actionProtocolName" ReturnResults="always">
                        <uap:DisplayName>TypeAgent App Action</uap:DisplayName>
                    </uap:Protocol>
                </uap:Extension>

        <!-- Protocol handler: type-agent: -->
                <uap3:Extension Category="windows.protocol" Executable="$exeName" EntryPoint="Windows.FullTrustApplication">
          <uap3:Protocol Name="$protocolName" Parameters="$protocolParams" />
        </uap3:Extension>

        <!-- App execution alias (runs with package identity) -->
        <uap3:Extension Category="windows.appExecutionAlias" Executable="$exeName" EntryPoint="Windows.FullTrustApplication">
          <uap3:AppExecutionAlias>
            <desktop:ExecutionAlias Alias="$exeName" />
          </uap3:AppExecutionAlias>
        </uap3:Extension>

                <!-- App Action provider registration (required for Agent Launcher registration) -->
                <uap3:Extension Category="windows.appExtension">
                    <uap3:AppExtension
                        Name="com.microsoft.windows.ai.actions"
                        Id="TypeAgentActions"
                        DisplayName="TypeAgent Actions"
                        PublicFolder="Assets">
                        <uap3:Properties>
                            <Registration xmlns="">registration.json</Registration>
                        </uap3:Properties>
                    </uap3:AppExtension>
                </uap3:Extension>

        <!-- Agent Launcher registration (requires matching App Actions provider in same package) -->
        <uap3:Extension Category="windows.appExtension">
          <uap3:AppExtension
            Name="com.microsoft.windows.ai.appAgent"
            Id="TypeAgent"
            DisplayName="TypeAgent"
            PublicFolder="Assets">
            <uap3:Properties>
              <Registration>agentRegistration.json</Registration>
            </uap3:Properties>
          </uap3:AppExtension>
        </uap3:Extension>
      </Extensions>
    </Application>
  </Applications>
</Package>
"@

    Write-FileUtf8NoBom $path $xml
}

function Write-AgentRegistrationJson([string] $path) {
    $json = @{
        manifest_version = "0.1.0"
        version          = "1.0.0"
        name             = "TypeAgent.TypeAgent"
        display_name     = "TypeAgent"
        description      = "TypeAgent Agent Launcher (requires App Action provider)"
        icon             = "ms-resource://Files/Assets/Square44x44Logo.png"
        action_id        = "TypeAgentAction"
    } | ConvertTo-Json -Depth 10

    Write-FileUtf8NoBom $path $json
}

function Write-ActionsRegistrationJson([string] $path, [string] $actionProtocolName) {
    # Minimal URI-launched App Action definition suitable for Agent Launcher scenarios.
    # Note: A real implementation must handle ProtocolForResults activation and read the ValueSet inputs.
    $json = @{
        version = 3
        actions = @(
            @{
                id = "TypeAgentAction"
                description = "Start TypeAgent"
                icon = "ms-resource://Files/Assets/Square44x44Logo.png"
                usesGenerativeAI = $true
                allowedAppInvokers = @("*")
                inputs = @(
                    @{ name = "agentName"; kind = "Text" },
                    @{ name = "prompt"; kind = "Text" }
                )
                inputCombinations = @(
                    # Escape $ so PowerShell doesn't interpolate the placeholder.
                    @{ inputs = @("agentName", "prompt"); description = "Start TypeAgent with '`${agentName.Text}'." }
                )
                outputs = @()
                invocation = @{
                    type = "Uri"
                    # Pass the prompt via a URI query parameter so the CLI can consume it like:
                    #   connect --uri "<uri>"  ->  ?request=<...>
                    # This matches the semantics expected by packages/cli/src/commands/connect.ts.
                    # Escape $ so PowerShell doesn't interpolate the placeholder.
                    uri = "${actionProtocolName}://?request=`${prompt.Text}"
                }
            }
        )
    } | ConvertTo-Json -Depth 20

    Write-FileUtf8NoBom $path $json
}

function Build-IdentityMsix(
    [string] $makeAppx,
    [string] $stageDir,
    [string] $outMsix
) {
    Ensure-Dir (Split-Path -Parent $outMsix)

    Invoke-Checked $makeAppx @(
        "pack",
        "/o",
        "/d", (Resolve-FullPath $stageDir),
        "/nv",
        "/p", (Resolve-FullPath $outMsix)
    ) $stageDir
}

function Sign-Msix(
    [string] $signtool,
    [string] $msixPath,
    [string] $pfxPath,
    [string] $pfxPassword
) {
    if (-not (Test-Path $pfxPath)) {
        throw "PFX not found: $pfxPath"
    }

    $args = @("sign", "/fd", "SHA256", "/a", "/f", (Resolve-FullPath $pfxPath))
    if ($pfxPassword) {
        $args += @("/p", $pfxPassword)
    }
    $args += @(Resolve-FullPath $msixPath)

    Invoke-Checked $signtool $args (Split-Path -Parent $msixPath)
}

$TsRoot = Resolve-FullPath $TsRoot
$OutDir = Resolve-FullPath $OutDir

Ensure-Dir $OutDir

$binDir = Join-Path $OutDir "bin"
Ensure-Dir $binDir

if (-not $ExternalLocation) {
    $ExternalLocation = $binDir
}
$ExternalLocation = Resolve-FullPath $ExternalLocation

Write-Host "Building SEA executable..." -ForegroundColor Cyan
$exePath = Build-SeaExe $TsRoot $binDir $ExeName $EntryMode

Write-Host "Writing side-by-side identity manifest..." -ForegroundColor Cyan
$null = Write-IdentitySideBySideManifest -exePath $exePath -packageName $PackageName -publisher $Publisher -applicationId $AppId

Write-Host "Staging identity package..." -ForegroundColor Cyan
$stageDir = Join-Path $OutDir "msix-stage"
if (Test-Path $stageDir) {
    Remove-Item -Recurse -Force $stageDir
}
Ensure-Dir $stageDir

$assetsDir = Join-Path $stageDir "Assets"
Ensure-Dir $assetsDir
Write-MinimalPng (Join-Path $assetsDir "storelogo.png")
Write-MinimalPng (Join-Path $assetsDir "Square150x150Logo.png")
Write-MinimalPng (Join-Path $assetsDir "Square44x44Logo.png")
Write-ActionsRegistrationJson (Join-Path $assetsDir "registration.json") $ActionProtocolName
Write-AgentRegistrationJson (Join-Path $assetsDir "agentRegistration.json")

$appxManifestPath = Join-Path $stageDir "AppxManifest.xml"
Write-AppxManifest -path $appxManifestPath -packageName $PackageName -publisher $Publisher -version $Version -displayName $DisplayName -publisherDisplayName $PublisherDisplayName -appId $AppId -exeName $ExeName -protocolName $ProtocolName -actionProtocolName $ActionProtocolName

$makeAppx = Find-WindowsSdkTool "MakeAppx.exe"
Write-Host "Using MakeAppx: $makeAppx" -ForegroundColor DarkCyan

$outMsix = Join-Path $OutDir "$PackageName-$Version.msix"
Write-Host "Building MSIX: $outMsix" -ForegroundColor Cyan
Build-IdentityMsix -makeAppx $makeAppx -stageDir $stageDir -outMsix $outMsix

if ($Sign) {
    if (-not $PfxPath) {
        throw "-Sign requires -PfxPath"
    }
    $signtool = Find-WindowsSdkTool "SignTool.exe"
    Write-Host "Signing with SignTool: $signtool" -ForegroundColor DarkCyan
    Sign-Msix -signtool $signtool -msixPath $outMsix -pfxPath $PfxPath -pfxPassword $PfxPassword
}

if ($Register) {
    Write-Host "Registering identity package with external location: $ExternalLocation" -ForegroundColor Cyan
    Add-AppxPackage -Path $outMsix -ExternalLocation $ExternalLocation -ForceApplicationShutdown
}

Write-Host "Done." -ForegroundColor Green
Write-Host "Exe:  $exePath"
Write-Host "MSIX: $outMsix"
Write-Host "ExternalLocation to use: $ExternalLocation"

if (-not $Sign -and -not $Register) {
    Write-Host "Pack-only complete (not signed, not registered)." -ForegroundColor DarkGreen
    Write-Host "To register: rerun with -Register (and optionally -ExternalLocation)." -ForegroundColor DarkGreen
    Write-Host "Note: The MSIX is identity-only and will not contain the EXE." -ForegroundColor DarkGreen
}
