// 学习通刷课助手 —— 桌面托盘启动器（P8）
//
// 为什么用 C# + Windows 自带的 csc.exe：
//   - 免安装任何依赖（.NET Framework 4 是 Windows 自带，csc.exe 可直接编译出 exe）
//   - 能做出真正的托盘图标 + 右键菜单 + 无控制台黑窗
//   - 单文件、体积小（~30KB）
//
// 职责：
//   1) 单实例保护（避免双击多次起多个 node 进程）
//   2) 用隐藏窗口的方式拉起 node src/main.mjs（不弹黑窗）
//   3) 托盘图标 + 悬浮提示显示运行状态
//   4) 右键菜单：打开控制台 / 显示日志窗口 / 重启 / 停止 / 退出
//   5) 退出时把 node 进程树和专用 Edge 一起收掉（不留孤儿）
//   6) 日志写 logs/desktop.log，便于排查
//
// 编译：tools/build-desktop.mjs 会调用 csc.exe

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace XuexitongAssistant
{
    static class Program
    {
        // ── 配置 ──
        const string AppTitle = "学习通刷课助手";
        const int ConsolePortStart = 8787;
        const int ConsolePortEnd = 8799;
        const int DebugPort = 9222;

        static string _root;
        static Process _node;
        static NotifyIcon _tray;
        static ToolStripMenuItem _miStatus;
        static ToolStripMenuItem _miOpen;
        static ToolStripMenuItem _miStop;
        static System.Windows.Forms.Timer _timer;
        static Mutex _single;
        static int _activePort = -1;
        static string _lastState = "";

        [STAThread]
        static void Main(string[] args)
        {
            // 单实例
            bool created;
            _single = new Mutex(true, "Global\\XuexitongAssistantTray", out created);
            if (!created)
            {
                MessageBox.Show("学习通刷课助手已经在运行了（看右下角托盘图标）。", AppTitle,
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            _root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            // 兼容 exe 放在 desktop\ 子目录的情况：往上找到含 src\main.mjs 的目录
            if (!File.Exists(Path.Combine(_root, "src", "main.mjs")))
            {
                var parent = Directory.GetParent(_root);
                if (parent != null && File.Exists(Path.Combine(parent.FullName, "src", "main.mjs")))
                    _root = parent.FullName;
            }

            Directory.CreateDirectory(Path.Combine(_root, "logs"));
            Log("=== 托盘启动器启动，root=" + _root + " ===");

            // 自愈：清掉上次被强杀（任务管理器结束进程）留下的孤儿 node
            KillOrphanNode();

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            BuildTray();
            StartNode();

            _timer = new System.Windows.Forms.Timer();
            _timer.Interval = 3000;
            _timer.Tick += (s, e) => RefreshState();
            _timer.Start();

            Application.ApplicationExit += (s, e) => Cleanup();
            Application.Run();

            Cleanup();
        }

        // ────────────────────────── 托盘 ──────────────────────────

        static void BuildTray()
        {
            _tray = new NotifyIcon();
            _tray.Icon = MakeIcon();
            _tray.Text = AppTitle + " —— 启动中…";
            _tray.Visible = true;
            _tray.DoubleClick += (s, e) => OpenConsole();

            var menu = new ContextMenuStrip();

            _miStatus = new ToolStripMenuItem("状态：启动中…") { Enabled = false };
            menu.Items.Add(_miStatus);
            menu.Items.Add(new ToolStripSeparator());

            _miOpen = new ToolStripMenuItem("打开控制台", null, (s, e) => OpenConsole());
            menu.Items.Add(_miOpen);

            menu.Items.Add(new ToolStripMenuItem("显示日志窗口", null, (s, e) => ShowLogWindow()));
            menu.Items.Add(new ToolStripMenuItem("打开所在文件夹", null, (s, e) => OpenFolder()));
            menu.Items.Add(new ToolStripSeparator());

            menu.Items.Add(new ToolStripMenuItem("重启服务", null, (s, e) => RestartNode()));

            _miStop = new ToolStripMenuItem("停止服务", null, (s, e) => StopNode());
            menu.Items.Add(_miStop);

            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("退出（并关闭专用 Edge）", null, (s, e) =>
            {
                Log("用户选择退出");
                _tray.Visible = false;
                Application.Exit();
            }));

            _tray.ContextMenuStrip = menu;
        }

        /// <summary>程序化生成图标：圆角方块 + "学"字（免外部 ico 文件）</summary>
        static Icon MakeIcon()
        {
            try
            {
                using (var bmp = new Bitmap(32, 32))
                using (var g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
                    g.Clear(Color.Transparent);

                    using (var brush = new LinearGradientBrush(
                        new Rectangle(0, 0, 32, 32), Color.FromArgb(76, 141, 255), Color.FromArgb(124, 92, 255), 45f))
                    using (var path = RoundedRect(new Rectangle(1, 1, 30, 30), 8))
                    {
                        g.FillPath(brush, path);
                    }

                    using (var f = new Font("Microsoft YaHei", 15f, FontStyle.Bold, GraphicsUnit.Pixel))
                    using (var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
                    using (var white = new SolidBrush(Color.White))
                    {
                        g.DrawString("学", f, white, new RectangleF(0, 1, 32, 32), sf);
                    }

                    IntPtr h = bmp.GetHicon();
                    return Icon.FromHandle(h);
                }
            }
            catch (Exception ex)
            {
                Log("生成图标失败，改用系统图标：" + ex.Message);
                return SystemIcons.Application;
            }
        }

        static GraphicsPath RoundedRect(Rectangle r, int radius)
        {
            var p = new GraphicsPath();
            int d = radius * 2;
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        // ────────────────────────── 进程管理 ──────────────────────────

        static string NodePath()
        {
            // 优先用固定安装路径，其次依赖 PATH
            string[] cands = {
                @"C:\Program Files\nodejs\node.exe",
                @"C:\Program Files (x86)\nodejs\node.exe"
            };
            foreach (var c in cands) if (File.Exists(c)) return c;
            return "node.exe";
        }

        static void StartNode()
        {
            var mainJs = Path.Combine(_root, "src", "main.mjs");
            if (!File.Exists(mainJs))
            {
                Fail("找不到 " + mainJs + "\n请确认 exe 放在项目目录下。");
                return;
            }

            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = NodePath(),
                    Arguments = "\"" + mainJs + "\"",
                    WorkingDirectory = _root,
                    UseShellExecute = false,
                    CreateNoWindow = true,          // 关键：不弹控制台黑窗
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8,
                    StandardErrorEncoding = Encoding.UTF8
                };

                _node = new Process { StartInfo = psi, EnableRaisingEvents = true };
                _node.OutputDataReceived += (s, e) => { if (e.Data != null) Log("[out] " + e.Data); };
                _node.ErrorDataReceived += (s, e) => { if (e.Data != null) Log("[err] " + e.Data); };
                _node.Exited += (s, e) => Log("node 进程已退出，exitCode=" + SafeExitCode());

                _node.Start();
                _node.BeginOutputReadLine();
                _node.BeginErrorReadLine();
                Log("已启动 node，PID=" + _node.Id);
            }
            catch (Exception ex)
            {
                Fail("启动 node 失败：" + ex.Message + "\n\n请确认已安装 Node.js 20+。");
            }
        }

        static int SafeExitCode()
        {
            try { return _node != null ? _node.ExitCode : -1; } catch { return -1; }
        }

        /// <summary>停掉 node 进程树（node 可能派生子进程）</summary>
        static void StopNode()
        {
            try
            {
                if (_node != null && !_node.HasExited)
                {
                    Log("停止 node，PID=" + _node.Id);
                    // /T 连带子进程 /F 强制
                    var k = Process.Start(new ProcessStartInfo("taskkill",
                        "/PID " + _node.Id + " /T /F")
                    { UseShellExecute = false, CreateNoWindow = true });
                    if (k != null) k.WaitForExit(8000);
                }
            }
            catch (Exception ex)
            {
                Log("停止 node 失败：" + ex.Message);
            }
        }

        /// <summary>关闭专用 Edge 实例（只杀带 edge-profile 的，不碰用户日常 Edge）</summary>
        static void StopDedicatedEdge()
        {
            try
            {
                var psi = new ProcessStartInfo("powershell",
                    "-NoProfile -NonInteractive -Command \"" +
                    "Get-CimInstance Win32_Process -Filter \\\"Name='msedge.exe'\\\" | " +
                    "Where-Object { $_.CommandLine -and $_.CommandLine -match 'edge-profile' } | " +
                    "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }\"")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
                var p = Process.Start(psi);
                if (p != null) p.WaitForExit(15000);
                Log("已请求关闭专用 Edge");
            }
            catch (Exception ex)
            {
                Log("关闭专用 Edge 失败（可手动关）：" + ex.Message);
            }
        }

        /// <summary>
        /// 清掉本项目遗留的孤儿 node 进程。
        ///
        /// 场景：用户用任务管理器"结束任务"强杀托盘，ApplicationExit 不会触发，
        /// 于是 node 服务留了下来（端口 8787 被占）。下次启动前先清一遍，
        /// 避免"启动后发现控制台打不开"这种迷惑现象。
        ///
        /// 安全：只杀命令行里同时含 main.mjs 与本项目路径的 node，不误伤其他 node。
        /// </summary>
        static void KillOrphanNode()
        {
            try
            {
                var psi = new ProcessStartInfo("powershell",
                    "-NoProfile -NonInteractive -Command \"" +
                    "Get-CimInstance Win32_Process -Filter \\\"Name='node.exe'\\\" -ErrorAction SilentlyContinue | " +
                    "Where-Object { $_.CommandLine -and $_.CommandLine -match 'main\\.mjs' -and $_.CommandLine -match '学习通脚本' } | " +
                    "ForEach-Object { Write-Output ('killed ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }\"")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    StandardOutputEncoding = Encoding.UTF8
                };
                var p = Process.Start(psi);
                if (p != null)
                {
                    string outp = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(15000);
                    if (!string.IsNullOrWhiteSpace(outp))
                        Log("清理遗留 node：" + outp.Trim().Replace("\r\n", ", ").Replace("\n", ", "));
                }
            }
            catch (Exception ex)
            {
                Log("清理遗留 node 时出错（可忽略）：" + ex.Message);
            }
        }

        static void RestartNode()
        {
            Log("重启服务…");
            StopNode();
            Thread.Sleep(1500);
            _activePort = -1;
            StartNode();
            RefreshState();
        }

        static void Cleanup()
        {
            try { if (_timer != null) _timer.Stop(); } catch { }
            StopNode();
            StopDedicatedEdge();
            try { if (_tray != null) { _tray.Visible = false; _tray.Dispose(); } } catch { }
            Log("=== 托盘退出完成 ===");
            try { _single.ReleaseMutex(); } catch { }
        }

        // ────────────────────────── 状态刷新 ──────────────────────────

        static int FindConsolePort()
        {
            if (_activePort > 0 && IsPortOpen(_activePort)) return _activePort;
            for (int p = ConsolePortStart; p <= ConsolePortEnd; p++)
            {
                if (IsPortOpen(p)) { _activePort = p; return p; }
            }
            _activePort = -1;
            return -1;
        }

        static bool IsPortOpen(int port)
        {
            try
            {
                using (var c = new TcpClient())
                {
                    var ar = c.BeginConnect("127.0.0.1", port, null, null);
                    if (!ar.AsyncWaitHandle.WaitOne(300)) return false;
                    c.EndConnect(ar);
                    return true;
                }
            }
            catch { return false; }
        }

        static void RefreshState()
        {
            bool running = _node != null && !_node.HasExited;
            int port = running ? FindConsolePort() : -1;
            bool edge = IsPortOpen(DebugPort);

            string state;
            string tip;
            if (!running)
            {
                state = "状态：已停止";
                tip = AppTitle + " —— 已停止";
            }
            else if (port > 0)
            {
                state = "状态：运行中（控制台 :" + port + "）" + (edge ? " · Edge 已接管" : "");
                tip = AppTitle + " —— 运行中 :" + port;
            }
            else
            {
                state = "状态：启动中…（等待控制台端口）";
                tip = AppTitle + " —— 启动中";
            }

            if (state != _lastState)
            {
                _lastState = state;
                Log(state);
            }

            try
            {
                _miStatus.Text = state;
                _miOpen.Enabled = port > 0;
                _miStop.Enabled = running;
                // NotifyIcon.Text 上限 63 字符
                _tray.Text = tip.Length > 63 ? tip.Substring(0, 63) : tip;
            }
            catch { }
        }

        // ────────────────────────── 菜单动作 ──────────────────────────

        static void OpenConsole()
        {
            int port = FindConsolePort();
            if (port <= 0)
            {
                MessageBox.Show("控制台还没就绪（服务可能正在启动，或已停止）。\n\n可以点「显示日志窗口」看详细输出。",
                    AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            try
            {
                Process.Start(new ProcessStartInfo("http://127.0.0.1:" + port + "/") { UseShellExecute = true });
                Log("已打开控制台 :" + port);
            }
            catch (Exception ex)
            {
                MessageBox.Show("打开浏览器失败：" + ex.Message, AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        static void OpenFolder()
        {
            try { Process.Start(new ProcessStartInfo(_root) { UseShellExecute = true }); } catch { }
        }

        /// <summary>把日志尾部显示在一个只读窗口里（替代控制台黑窗）</summary>
        static void ShowLogWindow()
        {
            string logFile = Path.Combine(_root, "logs", "desktop.log");
            string text;
            try
            {
                if (File.Exists(logFile))
                {
                    var lines = File.ReadAllLines(logFile);
                    int take = Math.Min(lines.Length, 400);
                    var sb = new StringBuilder();
                    for (int i = lines.Length - take; i < lines.Length; i++) sb.AppendLine(lines[i]);
                    text = sb.ToString();
                }
                else text = "(还没有日志)";
            }
            catch (Exception ex) { text = "(读取日志失败：" + ex.Message + ")"; }

            var f = new Form
            {
                Text = AppTitle + " —— 运行日志（只读）",
                Width = 900,
                Height = 560,
                StartPosition = FormStartPosition.CenterScreen,
                Icon = MakeIcon()
            };
            var box = new TextBox
            {
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Both,
                WordWrap = false,
                Dock = DockStyle.Fill,
                Font = new Font("Consolas", 9f),
                Text = text
            };
            box.SelectionStart = box.TextLength;
            box.ScrollToCaret();
            f.Controls.Add(box);
            f.Show();
        }

        static void Fail(string msg)
        {
            Log("[FATAL] " + msg.Replace("\n", " | "));
            MessageBox.Show(msg, AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }

        // ────────────────────────── 日志 ──────────────────────────

        static readonly object _logLock = new object();

        static void Log(string msg)
        {
            try
            {
                lock (_logLock)
                {
                    string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + msg;
                    File.AppendAllText(Path.Combine(_root, "logs", "desktop.log"), line + Environment.NewLine, Encoding.UTF8);
                }
            }
            catch { /* 日志失败不能影响运行 */ }
        }
    }
}
